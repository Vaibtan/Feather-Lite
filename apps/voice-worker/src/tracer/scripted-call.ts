/**
 * One automated end-to-end voice call with a *speaking* headless borrower.
 *
 * The borrower joins the room with a published audio track and speaks a scripted set of lines at
 * the right moments:
 *
 *   1. wait for the agent to finish its opening (the right-party question)
 *   2. say "Yes, this is <name>."
 *   3. wait for the agent's reply to *start*, then barge in with "I can pay 550 dollars on Friday."
 *      after ~2s (the same amount+date the simulation reference line carries, so the decider's
 *      choice is not riding on whether the model infers an unstated amount)
 *   4. wait for the read-back to finish, say "Yes, that's correct." — answering an amount
 *      clarification first if the agent asks one (an extra DISCUSSING_PAYMENT turn changes neither
 *      the state path nor the tool sequence, so equivalence is preserved)
 *   5. stay until the agent hangs up
 *
 * This is the real audio path — STT -> llmNode -> control-plane turn -> TTS -> playout -> barge-in —
 * so it doubles as the regression that proves a self-hosted SFU behaves like LiveKit Cloud
 * (ADR 0006). Timing is deliberately heuristic; the assertion that matters is the ledger
 * equivalence check the callers run afterwards (`equivalence.ts`).
 *
 * The borrower's voice comes from the same `STT_TTS_PROVIDER` switch the worker uses, and its lines
 * are cached to WAV so an N-call fleet pays for synthesis once, not 3xN times per run.
 */
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { wordErrorRate } from "@feather-lite/domain";
import { buildSpeechStack, speechProvider } from "../speech.js";
import { synthesizeCached } from "./line-cache.js";
import { harnessHeaders, harnessJsonHeaders } from "@feather-lite/load-test/harness-http";
// The threshold and the hangover come from `domain`, not a second copy here: the live detector and
// the post-hoc `speechWindows()` have to agree, and a harness and a metric drifting apart on the
// value is exactly the failure the domain module was written to prevent (H1).
import { SILENCE_HANGOVER_MS, SPEECH_RMS, type BorrowerEvent, type RmsSample } from "@feather-lite/domain";

/**
 * A different voice than the agent's, so a human listening can tell the two apart.
 * Resolved lazily: harnesses load .env after module imports are hoisted, so reading
 * STT_TTS_PROVIDER at module level would always see the "inference" default.
 */
const borrowerVoice = (): string =>
  speechProvider() === "plugins"
    ? "aura-2-orion-en" // Deepgram Aura model name (the voice IS the model)
    : "a0e99841-438c-4a64-b679-ae501e7d6091"; // Cartesia voice id via Cloud Inference

/** How long to wait for the agent's reply to start before giving up on a clean barge-in. */
const SPEECH_START_TIMEOUT_MS = 60_000;
/** How long to wait for the promise read-back. */
const READBACK_TIMEOUT_MS = 60_000;

/** One borrower line: the audio, and the exact words it says — the WER ground truth (D4). */
export interface ScriptedLine {
  readonly frames: ReadonlyArray<AudioFrame>;
  readonly text: string;
}

export interface ScriptedLines {
  readonly yes: ScriptedLine;
  readonly pay: ScriptedLine;
  /** Answer to an amount-clarifying question, if the agent asks one instead of proposing. */
  readonly amount: ScriptedLine;
  readonly confirm: ScriptedLine;
  readonly sampleRate: number;
  readonly channels: number;
  readonly cached: boolean;
  readonly describe: string;
}

/**
 * Synthesise (or load from the WAV cache) the three borrower lines. Call once per process and share
 * the frames across every call in a fleet.
 */
/**
 * A persona: whose voice the borrower speaks in (issue #4, H9).
 *
 * D4 wants at least five, fixed per seed and reported by name, because the literature's one
 * consistent finding is that accents cost most and cost provider-specifically — so a per-persona
 * number is the only honest one and an average across them is not.
 *
 * A name here rather than a voice id: the id is provider-specific and the report has to stay
 * readable when the provider changes. `undefined` is the voice `BORROWER_TTS_VOICE` selects, which
 * is what every number recorded so far was taken on.
 */
export type BorrowerPersona = string;

export const loadScriptedLines = async (persona?: BorrowerPersona): Promise<ScriptedLines> => {
  const speech = buildSpeechStack(persona ?? borrowerVoice());
  const key = `${speech.provider}|${speech.describe}`;
  try {
    // Sequential on purpose: some TTS plugins (Cartesia was one) multiplex synthesis over a single
    // pooled WebSocket and silently drop a generation under concurrency; sequential costs nothing here.
    const YES = "Yes, this is Jordan.";
    const PAY = "Actually, wait. I can pay 550 dollars on Friday.";
    const AMOUNT = "The full balance. 550 dollars.";
    const CONFIRM = "Yes, that's correct.";
    const yes = await synthesizeCached(speech.tts, YES, key);
    const pay = await synthesizeCached(speech.tts, PAY, key);
    const amount = await synthesizeCached(speech.tts, AMOUNT, key);
    const confirm = await synthesizeCached(speech.tts, CONFIRM, key);
    return {
      yes: { frames: yes.frames, text: YES },
      pay: { frames: pay.frames, text: PAY },
      amount: { frames: amount.frames, text: AMOUNT },
      confirm: { frames: confirm.frames, text: CONFIRM },
      sampleRate: yes.sampleRate,
      channels: yes.channels,
      cached: yes.cached && pay.cached && amount.cached && confirm.cached,
      describe: speech.describe,
    };
  } finally {
    await speech.tts.close().catch(() => undefined);
  }
};

export interface ScriptedCallOptions {
  readonly lines: ScriptedLines;
  readonly controlPlaneUrl: string;
  readonly borrowerName: string;
  readonly participantIdentity: string;
  /**
   * What the borrower does on this call (H9). Defaults to the promise-to-pay conversation this
   * harness has always run; a tier-3 scenario supplies its own.
   */
  readonly script?: BorrowerScript | undefined;
  /**
   * Called when the agent starts and stops speaking, live (H1).
   *
   * The seam a tier-3 scenario needs — "interrupt 400 ms into the agent's second line" is a reaction
   * to an onset, and a scripted borrower that waits for a transcript reacts a sentence too late.
   * Optional: tier 2 does not use them and its behaviour is unchanged.
   */
  readonly onStretchStart?: ((index: number, atMs: number) => void) | undefined;
  readonly onStretchEnd?: ((index: number, atMs: number) => void) | undefined;
  /** Short tag used in log lines so concurrent calls are readable. */
  readonly label: string;
  readonly log?: (message: string) => void;
  /**
   * Chaos hook: once the agent has actually replied — so there is a live call to break — this is
   * invoked and the call is abandoned where it stands, with no further lines and no hangup. Only
   * `chaos-orphan.ts` uses it; every other harness leaves it unset and runs the full script.
   */
}

/**
 * One measurement of the composite metric that matters: borrower stops speaking -> agent starts
 * responding. `ms` is measured from the return of `speak()` (i.e. after `waitForPlayout()`, so the
 * borrower's last audio frame has actually left the source) to the first delta of the *next* agent
 * transcription segment. LiveKit forwards agent transcription in step with playout, so the first
 * delta of a fresh segment is the closest proxy for "first agent audio frame" available to a
 * headless client — the subscribed audio track carries frames continuously, silence included, so
 * frame arrival cannot mark speech onset.
 *
 * Segments already in flight when the borrower barges in are excluded: a latency is only attributed
 * to a segment whose text stream *opened* after the borrower fell silent. (The stream-open stamp is
 * only that guard; the latency itself is measured to the first agent delta, i.e. the same instant
 * the call's `agentSpeakingAt` transitions.)
 */
export interface TurnLatency {
  /** Which scripted borrower line this reply answers. */
  readonly turn: string;
  /**
   * Wall clock when the borrower fell silent — the instant this measurement is anchored to.
   *
   * Carried so a score can be joined to the ledger's turn by *time* rather than by position
   * (review #10). The turn row is created after this, when the worker posts the committed turn, so
   * the matching turn is the first one that started at or after this.
   */
  readonly atMs: number;
  readonly ms: number;
  /**
   * Same interval, but measured to the first agent audio frame with speech-level RMS energy
   * instead of the first transcription delta. The transcription stream is paced by the framework
   * against playout and consistently lags the audio itself; this is the number a human ear
   * experiences. Null when no energetic frame was seen before the transcription delta (should not
   * happen; kept honest rather than defaulted).
   */
  readonly audioMs: number | null;
}

/** One borrower line, what the STT made of it, and the error rate between them (D4). */
export interface WerLine {
  readonly turn: string;
  /** Wall clock when the line finished being spoken; `NaN` if it never did. See {@link TurnLatency.atMs}. */
  readonly atMs: number;
  readonly reference: string;
  readonly hypothesis: string;
  /** null when the reference was empty — nothing to be wrong about. */
  readonly wer: number | null;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface ScriptedCallResult {
  readonly label: string;
  readonly borrowerName: string;
  readonly conversationId: string | null;
  readonly roomName: string | null;
  /** The agent ended the call itself (the expected happy-path ending). */
  readonly hungUp: boolean;
  readonly agentSegments: ReadonlyArray<string>;
  readonly agentAudioFrames: number;
  readonly durationMs: number;
  /**
   * When the call finished, in epoch milliseconds (H3).
   *
   * `durationMs` cannot close a join window: the measurements it is compared against are absolute
   * instants, matched to `conversation_turns.started_at`. Without an absolute end the last line's
   * window ran to infinity and could claim a turn the ledger opened after the call was over.
   */
  readonly endedAtMs: number;
  /** Per-turn response latency, in scripted order. See {@link TurnLatency}. */
  readonly turnLatencies: ReadonlyArray<TurnLatency>;
  /** Per-line STT accuracy, in scripted order. See {@link WerLine}. */
  readonly werLines: ReadonlyArray<WerLine>;
  /**
   * The call's agent-audio energy, frame by frame (H1). Returned so `speechWindows()` runs once,
   * post hoc and pure, on exactly what the live detector saw.
   */
  readonly rmsSamples: ReadonlyArray<RmsSample>;
  /** How many stretches the live detector counted, for reconciliation against the post-hoc index. */
  readonly liveStretchCount: number;
  /** The borrower's own events, for `turnTakingMetrics` (issue #1, D4). */
  readonly borrowerEvents: ReadonlyArray<BorrowerEvent>;
  /**
   * Borrower transcripts that arrived with no spoken line waiting for them. Non-empty means the
   * reference/hypothesis pairing above may be off by one, so the WER is not to be trusted for that
   * run — reported rather than hidden.
   */
  readonly unmatchedTranscripts: ReadonlyArray<string>;
  /**
   * Scripted turns that the borrower spoke but that no agent segment ever answered (the script moved
   * on first). Reported so a short `turnLatencies` list can never be mistaken for a clean run.
   */
  readonly unansweredTurns: ReadonlyArray<string>;
  readonly error: string | null;
}

/**
 * Everything a borrower script is given, and nothing else (issue #4, H9).
 *
 * Deep on purpose: behind these few members sit the LiveKit room, the audio source, the RMS onset
 * detector, the transcript join, the per-line word-error bookkeeping and the response-latency
 * measurement. A script says "speak this, wait for that" and none of the rest is its business —
 * which is what makes five scenarios a matter of writing five scripts rather than five forks of a
 * 350-line function.
 */
export interface CallContext {
  /** The persona's WAV-cached lines. */
  readonly lines: ScriptedLines;
  readonly borrowerName: string;
  readonly log: (message: string) => void;
  readonly sleep: (ms: number) => Promise<unknown>;
  /**
   * Play one line and close the previous one for scoring. Returns when playout finishes, which is
   * the instant both the WER line and the response-latency measurement are anchored to.
   */
  readonly speak: (label: string, line: ScriptedLine) => Promise<void>;
  /** Wait for an agent segment matching `pattern` after index `from`; returns the next index, or -1. */
  readonly waitAgentSaid: (pattern: RegExp, from: number, timeoutMs: number) => Promise<number>;
  /** Wait until the agent is actually producing audio, rather than until it has said something. */
  readonly waitAgentSpeaking: (timeoutMs: number) => Promise<boolean>;
  /** Every agent segment so far, in order. Read-only to a script. */
  readonly agentSaid: ReadonlyArray<{ readonly at: number; readonly text: string }>;
  /** Whether the agent has left the room. */
  readonly agentGone: boolean;
  /** Wait for the agent to hang up, or give up. Returns whether it did. */
  readonly waitForHangup: (timeoutMs: number) => Promise<boolean>;
}

/**
 * One borrower's behaviour for one call.
 *
 * A `name` because it goes in the report: a run whose borrower behaved differently is a different
 * measurement, and "which script" is the first thing to know about a tier-3 number.
 */
export interface BorrowerScript {
  readonly name: string;
  readonly run: (ctx: CallContext) => Promise<void>;
}

/** How long to wait for the agent to start speaking at all. */
const SPEECH_START_WAIT_MS = SPEECH_START_TIMEOUT_MS;

/**
 * The promise-to-pay conversation this harness has always run, now one implementation of the seam
 * rather than the only thing the file can do.
 *
 * Unchanged in behaviour, deliberately: H9's verification is that tier 2 is unchanged, because the
 * script is the same script.
 */
export const promiseToPayScript: BorrowerScript = {
  name: "promise-to-pay",
  run: async (ctx) => {
    const firstNameOf = (full: string) => full.trim().split(/\s+/)[0] ?? full;
    // 1. opening (non-interruptible): wait for the right-party question, then a short pause for playout
    ctx.log("waiting for opening to finish...");
    let cursor = await ctx.waitAgentSaid(new RegExp(`speak with ${firstNameOf(ctx.borrowerName)}`, "i"), 0, 60_000);
    await ctx.sleep(1500);
    // 2. right-party confirmation
    await ctx.speak("yes this is the borrower", ctx.lines.yes);
    // 3. wait for the reply to *start*, then barge in ~2s into it.
    //    The wait must be generous: against LiveKit Cloud the STT -> turn -> TTS round trip has been
    //    seen to take 25s+, and barging in before the agent speaks is not a barge-in — the line lands
    //    in silence, the agent then talks over it, and the turn is lost.
    ctx.log("waiting for agent reply to start...");
    if (await ctx.waitAgentSpeaking(SPEECH_START_WAIT_MS)) {
      await ctx.sleep(2000);
      await ctx.speak("BARGE-IN: I can pay 550 on Friday", ctx.lines.pay);
    } else {
      ctx.log("agent did not start speaking; speaking anyway");
      await ctx.speak("I can pay 550 on Friday", ctx.lines.pay);
    }
    // 4. wait for the read-back ("Please say yes to confirm"), then confirm. If the agent asks a
    //    clarifying question about the amount instead of proposing, answer it once and keep
    //    waiting — a real borrower would, and the deaf alternative is two NO_INPUT timeouts and a
    //    NO_ANSWER close.
    ctx.log("waiting for read-back...");
    {
      const readback = /say yes to confirm/i;
      const askedAmount = /amount|how much/i;
      const start = Date.now();
      // Anchor past everything already said: the broad amount-pattern must only ever see segments
      // that came after the barge-in, not the earlier account statement.
      let from = Math.max(cursor, ctx.agentSaid.length);
      let clarified = false;
      let rb = -1;
      while (Date.now() - start < READBACK_TIMEOUT_MS && !ctx.agentGone) {
        const idx = ctx.agentSaid.findIndex((seg, i) => i >= from && (readback.test(seg.text) || (!clarified && askedAmount.test(seg.text))));
        if (idx >= 0) {
          if (readback.test(ctx.agentSaid[idx]!.text)) {
            rb = idx + 1;
            break;
          }
          clarified = true;
          from = idx + 1;
          await ctx.sleep(2500); // the transcript stream closes before audio playout finishes
          await ctx.speak("the full balance", ctx.lines.amount);
        }
        await ctx.sleep(100);
      }
      if (rb < 0) ctx.log("no read-back seen before the timeout; confirming anyway (the ledger check will catch it)");
      else cursor = rb;
    }
    await ctx.sleep(2500); // the transcript stream closes before audio playout finishes
    await ctx.speak("yes, that's correct", ctx.lines.confirm);
    // 5. wait for hangup
    ctx.log("waiting for agent to hang up...");
    ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
  },
};

/**
 * The borrower who stops mid-call and never says goodbye — what a killed worker leaves behind.
 *
 * The second implementation, and the reason this is a seam rather than a hypothetical one: the chaos
 * probe used to reach this behaviour through an `abandonAfterFirstReply` callback threaded into the
 * middle of the one script, which is the shape H9 exists to remove.
 */
export const abandonAfterFirstReplyScript = (onAbandon: () => void): BorrowerScript => ({
  name: "abandon-after-first-reply",
  run: async (ctx) => {
    ctx.log("waiting for agent reply to start...");
    if (!(await ctx.waitAgentSpeaking(SPEECH_START_WAIT_MS))) ctx.log("agent never replied; abandoning anyway");
    // No more lines, no hangup, nothing that would let the control plane learn the call is over.
    onAbandon();
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** Bootstrap the room through the real control plane, or (TRACER_RAW=1) with a raw agent dispatch. */
/**
 * Join the room the agent will be dispatched to, and hand back what a call needs to run in it (H9).
 *
 * Exported because a tier-3 scenario that is not a `runScriptedCall` — a third party dialling in, a
 * borrower that only listens — still has to get into the room the same way, and copying twelve lines
 * of token minting is how two harnesses come to disagree about how a call starts.
 */
export const bootstrapRoom = async (opts: ScriptedCallOptions): Promise<{ roomName: string; token: string; conversationId: string | null }> => {
  const url = process.env["LIVEKIT_URL"] ?? "";
  const key = process.env["LIVEKIT_API_KEY"] ?? "";
  const secret = process.env["LIVEKIT_API_SECRET"] ?? "";
  if (process.env["TRACER_RAW"] === "1") {
    const rooms = new RoomServiceClient(url, key, secret);
    const dispatch = new AgentDispatchClient(url, key, secret);
    const roomName = `tracer-${Date.now().toString(36)}-${opts.label}`;
    await rooms.createRoom({ name: roomName, emptyTimeout: 120, metadata: JSON.stringify({ tracer: true }) });
    await dispatch.createDispatch(roomName, process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-agent", { metadata: JSON.stringify({ tracer: true }) });
    const at = new AccessToken(key, secret, { identity: opts.participantIdentity, name: `${opts.borrowerName} (headless)` });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return { roomName, token: await at.toJwt(), conversationId: null };
  }

  // Through `harnessHeaders`, like every other request this harness makes (H5). A bare `fetch` here
  // is exempt from nothing: it is the one call in the run that the server's own per-IP budget can
  // shed, and a run that cannot read the borrower directory fails in a way that looks like a missing
  // fixture rather than a 429.
  const dir = (await (await fetch(`${opts.controlPlaneUrl}/api/borrowers`, { headers: harnessHeaders() })).json()) as Array<{ borrower_id: string; name: string; contact_points: Array<{ contact_point_id: string }> }>;
  const b = dir.find((x) => x.name === opts.borrowerName);
  if (!b) throw new Error(`borrower ${opts.borrowerName} not found in ${opts.controlPlaneUrl}/api/borrowers`);
  const res = await fetch(`${opts.controlPlaneUrl}/api/voice/sessions`, {
    method: "POST",
    headers: harnessJsonHeaders(),
    body: JSON.stringify({
      borrower_id: b.borrower_id,
      contact_point_id: b.contact_points[0]!.contact_point_id,
      participant_identity: opts.participantIdentity,
      participant_name: `${opts.borrowerName} (headless)`,
      mode: "browser",
    }),
  });
  if (!res.ok) throw new Error(`voice session ${res.status}: ${await res.text()}`);
  const session = (await res.json()) as { room_name: string; participant_token: string; conversation_id: string };
  return { roomName: session.room_name, token: session.participant_token, conversationId: session.conversation_id };
};

export const runScriptedCall = async (opts: ScriptedCallOptions): Promise<ScriptedCallResult> => {
  const t0 = Date.now();
  const log = opts.log ?? ((m: string) => console.log(`[${opts.label}] ${m}`));
  let conversationId: string | null = null;
  let roomName: string | null = null;
  const agentSaid: Array<{ at: number; text: string }> = [];
  let agentGone = false;
  let audioFrames = 0;
  let agentSpeakingAt = 0;
  const room = new Room();
  const turnLatencies: Array<TurnLatency> = [];
  const werLines: Array<WerLine> = [];
  /**
   * Every frame's energy for the whole call (H1), so `speechWindows()` can run on it post hoc and
   * the turn-taking metrics have something to be computed from.
   */
  const rmsSamples: Array<RmsSample> = [];
  /** What the borrower said and when, for the turn-taking metrics (issue #1, D4). */
  const borrowerEvents: Array<BorrowerEvent> = [];
  /**
   * Every fourth sample, not every sample (W8). Frames are ~10 ms and the onset detector needs that
   * 10 ms of resolution — it does not need the RMS of a 10 ms frame over all ~480 of its samples at
   * 48 kHz. A quarter of them puts the same decision either side of a threshold that sits between 25
   * and 250, and takes three quarters of this loop off the box the worker is being measured on.
   */
  const SAMPLE_STRIDE = 4;
  /** The live onset index, reconciled against the post-hoc one when the call ends (H1). */
  let liveStretches = 0;
  const unmatchedTranscripts: string[] = [];
  /**
   * The line currently being spoken (or most recently spoken), collecting every borrower-final
   * transcript that belongs to it.
   *
   * A list, not a single transcript, because the STT splits one utterance across several finals:
   * measured live, "Actually, wait. I can pay 550 dollars on Friday." came back as "Actually,
   * wait." followed by "I can pay $550 on Friday.". Taking only the first final scored the missing
   * half as two deleted words and reported 0.222 for a transcription that was in fact perfect.
   *
   * Opened *before* the audio is played, since the first final can arrive while the borrower is
   * still speaking, and closed when the next line opens.
   */
  /**
   * `closedAt` is null until the line has finished being spoken. Null rather than 0, because a 0
   * would sort before every ledger turn and silently join the wrong one; a null is a measurement
   * that cannot be joined, which is a thing the score builder already handles honestly.
   */
  let currentLine: { turn: string; reference: string; parts: string[]; closedAt: number | null } | null = null;
  const unansweredTurns: Array<string> = [];
  /** Set when the borrower falls silent; cleared by the first delta of the next agent segment. */
  const awaiting: { reply: { turn: string; at: number; audioAt: number | null } | null } = { reply: null };
  /**
   * Give up on the pending turn. Recorded rather than dropped: a silently shorter `turnLatencies`
   * would flatter the mean, which is exactly the optimistic summary this harness must not produce.
   */
  const abandonPendingReply = (why: string) => {
    const p = awaiting.reply;
    if (!p) return;
    unansweredTurns.push(p.turn);
    log(`no agent reply to "${p.turn}" ${why}; not measured`);
    awaiting.reply = null;
  };

  try {
    const boot = await bootstrapRoom(opts);
    roomName = boot.roomName;
    conversationId = boot.conversationId;
    log(`room=${roomName} conversation=${conversationId ?? "(raw)"}`);

    /**
     * Whose audio is the agent's (issue #4, H2).
     *
     * The handler filtered on `kind` alone and called whatever it got "agent audio". With one agent
     * and one borrower in the room that is true by accident; with the third-party-pickup scenario
     * D4 adds, a second voice on the line would have its energy booked as agent speech — so the
     * agent would appear to talk over the borrower, and `turn.agent_interrupt_rate` would be
     * measuring a person the agent never spoke over.
     *
     * The same identity rule the transcript handler already uses, in one place now so the two
     * cannot disagree about who is speaking.
     */
    const isAgent = (identity: string): boolean => identity.startsWith("agent");

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (!isAgent(participant.identity)) {
        // Not a failure: a third party on the line is a scenario, not a fault. It is logged so a run
        // that hears one is not silently reinterpreted afterwards.
        log(`ignoring audio from non-agent participant ${participant.identity} (not the agent's speech)`);
        return;
      }
      log(`subscribed to agent audio (${participant.identity})`);
      const stream = new AudioStream(track);
      void (async () => {
        /**
         * Every frame's energy is kept, and the onset is a consumer of that (issue #4, H1).
         *
         * The loop used to compute RMS **only while a reply was pending** and stop at the first loud
         * frame: `if (pending && pending.audioAt === null)`. That is exactly enough for one number —
         * response latency — and it throws away the sample tier 3 needs for six. D4's metrics are
         * about *stretches* of agent audio with a beginning and an end, and `speechWindows()` in
         * `domain` already turns samples into stretches; it had nothing to run on because the
         * harness never kept any.
         *
         * So RMS is computed for every frame of agent audio, the samples are kept for the whole
         * call and returned on the result, and `pending.audioAt` is now set by the same loop rather
         * than being the reason it runs.
         *
         * **Timed from a sample counter, not `Date.now()` per chunk.** Frames arrive in bursts
         * through an async iterator, so wall-clock at delivery is jittered by the event loop — and
         * the stretch boundaries this feeds are compared against the ledger at 100 ms resolution.
         * The audio's own clock does not jitter: every frame is `samplesPerChannel / sampleRate`
         * seconds of speech, whenever it happens to arrive. `t0Audio` anchors that count to the wall
         * clock once, so a stretch can still be joined to a playout report.
         */
        let audioMs = 0;
        let t0Audio: number | null = null;
        let inStretch = false;
        let lastLoudMs = 0;

        for await (const frame of stream) {
          audioFrames += 1;
          t0Audio ??= Date.now();
          const data = frame.data;
          let sum = 0;
          let n = 0;
          for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
            sum += data[i]! * data[i]!;
            n += 1;
          }
          const rms = n > 0 ? Math.sqrt(sum / n) : 0;
          const atMs = t0Audio + audioMs;
          rmsSamples.push({ atMs, rms });
          audioMs += (frame.samplesPerChannel / frame.sampleRate) * 1000;

          /**
           * The hangover state machine, inline and live (H1).
           *
           * The same rule `speechWindows()` applies post hoc, at the same threshold and the same
           * 700 ms hangover — a pause inside a line is a few hundred milliseconds and the gap
           * between two turns is the whole latency waterfall, so 700 separates them with an order of
           * magnitude either side. Live because a scenario has to *react* to an onset (interrupt at
           * offset t into the agent's k-th line), and post hoc because the run must be able to check
           * that what it reacted to is what the samples say.
           */
          if (rms > SPEECH_RMS) {
            if (!inStretch) {
              inStretch = true;
              liveStretches += 1;
              opts.onStretchStart?.(liveStretches, atMs);
            }
            lastLoudMs = atMs;
          } else if (inStretch && atMs - lastLoudMs > SILENCE_HANGOVER_MS) {
            inStretch = false;
            opts.onStretchEnd?.(liveStretches, lastLoudMs);
          }

          // The onset the response-latency number is anchored to: the first energetic frame after
          // the borrower fell silent. A consumer of the loop now, not its purpose.
          const pending = awaiting.reply;
          if (pending && pending.audioAt === null && rms > SPEECH_RMS) pending.audioAt = Date.now();
        }
      })();
    });
    room.registerTextStreamHandler("lk.transcription", (reader, participantInfo) => {
      const openedAt = Date.now();
      void (async () => {
        const attrs = reader.info.attributes ?? {};
        const fromAgent = isAgent(participantInfo.identity);
        // Only the borrower this harness is playing feeds the word-error gate (H2). A third party's
        // words are not a transcription of the script, and scoring them against the borrower's
        // reference line would report a WER failure for a scenario behaving exactly as designed.
        const fromThisBorrower = participantInfo.identity === opts.participantIdentity;
        if (!fromAgent && !fromThisBorrower) {
          log(`ignoring transcript from ${participantInfo.identity}: neither the agent nor this borrower`);
          return;
        }
        let text = "";
        // Agent segments are delta streams: chunks arrive as the agent speaks; the stream closes at segment end.
        for await (const chunk of reader) {
          text += chunk;
          if (fromAgent) {
            agentSpeakingAt = Date.now();
            // Only a segment that *opened* after the borrower fell silent is a reply to it; a segment
            // already in flight during a barge-in is the line being interrupted, not an answer.
            const pending = awaiting.reply;
            if (pending && openedAt >= pending.at) {
              const ms = Date.now() - pending.at;
              const audioMs = pending.audioAt !== null ? pending.audioAt - pending.at : null;
              turnLatencies.push({ turn: pending.turn, atMs: pending.at, ms, audioMs });
              log(`response latency (${pending.turn}): ${ms}ms (first audio: ${audioMs === null ? "not seen" : `${audioMs}ms`})`);
              awaiting.reply = null;
            }
          }
        }
        if (fromAgent) {
          agentSaid.push({ at: Date.now(), text });
          log(`agent said: ${JSON.stringify(text.slice(0, 90))}`);
        } else if (attrs["lk.transcription_final"] === "true") {
          log(`stt heard me: ${JSON.stringify(text)}`);
          if (currentLine) {
            currentLine.parts.push(text);
          } else {
            // No line open at all: only possible before the first line is spoken. Counted and
            // printed rather than dropped, because an unnoticed mis-pairing would move WER without
            // moving anything that looks wrong.
            unmatchedTranscripts.push(text);
            log(`stt wer: unmatched borrower transcript (no line open): ${JSON.stringify(text.slice(0, 60))}`);
          }
        }
      })();
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      log(`agent disconnected (${p.identity})`);
      agentGone = true;
    });
    room.on(RoomEvent.Disconnected, () => {
      log("room disconnected (agent hung up by deleting the room)");
      agentGone = true;
    });

    await room.connect(process.env["LIVEKIT_URL"] ?? "", boot.token, { autoSubscribe: true, dynacast: false });
    log("connected");

    const source = new AudioSource(opts.lines.sampleRate, opts.lines.channels);
    const track = LocalAudioTrack.createAudioTrack("mic", source);
    const publishOpts = new TrackPublishOptions();
    publishOpts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, publishOpts);
    log("mic published");

    /** Score the line that just finished; its transcripts are complete once the next line starts. */
    const closeCurrentLine = () => {
      if (!currentLine) return;
      const { turn, reference, parts, closedAt } = currentLine;
      currentLine = null;
      const hypothesis = parts.join(" ");
      const r = wordErrorRate(reference, hypothesis);
      // A line abandoned mid-playout has no instant; `NaN` joins nothing, which is the honest answer.
      werLines.push({ turn, atMs: closedAt ?? Number.NaN, reference, hypothesis, wer: r.wer, substitutions: r.substitutions, insertions: r.insertions, deletions: r.deletions });
      log(`stt wer (${turn}): ${r.wer === null ? "n/a" : r.wer.toFixed(3)} (S${r.substitutions} I${r.insertions} D${r.deletions} / N${r.referenceWords}, ${parts.length} final(s))`);
    };

    const speak = async (label: string, line: ScriptedLine) => {
      const startedAt = Date.now();
      closeCurrentLine();
      // Opened before playout: the STT can emit a final for the first phrase while the rest is
      // still being spoken, and that phrase is part of this line, not a stray.
      currentLine = { turn: label, reference: line.text, parts: [], closedAt: null };
      log(`speaking: ${label}`);
      for (const f of line.frames) await source.captureFrame(f);
      await source.waitForPlayout();
      log(`finished: ${label}`);
      // The line is over; both measurements about it are anchored to this instant.
      const spokenAt = Date.now();
      /**
       * What the borrower did, for the turn-taking metrics (issue #1, D4).
       *
       * `kind` is `line` for everything the promise-to-pay script speaks: each one is a bid for the
       * turn. Tier 3's scenarios are what introduce backchannels and non-directed noise, and they
       * label their own — which is why this is recorded here, where the script's intent is known,
       * rather than inferred from audio afterwards.
       */
      borrowerEvents.push({ kind: "line", label, startMs: startedAt, endMs: spokenAt });
      currentLine.closedAt = spokenAt;
      abandonPendingReply("before the next line"); // the script waited, timed out, and moved on
      awaiting.reply = { turn: label, at: spokenAt, audioAt: null };
    };
    /** Wait until the agent has produced a final segment matching `pattern` (after index `from`). */
    const waitAgentSaid = async (pattern: RegExp, from: number, timeoutMs: number): Promise<number> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const idx = agentSaid.findIndex((seg, i) => i >= from && pattern.test(seg.text));
        if (idx >= 0) return idx + 1;
        if (agentGone) return -1;
        await sleep(100);
      }
      return -1;
    };
    const waitAgentSpeaking = async (timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (Date.now() - agentSpeakingAt < 400 && agentSpeakingAt > start - 400) return true;
        await sleep(100);
      }
      return false;
    };

    /**
     * What a borrower script is given (issue #4, H9).
     *
     * The call was one ~350-line function with the script inlined — hard-coded regexes, hard-coded
     * sleeps, and the promise-to-pay conversation interleaved with the room, the tracks, the RMS
     * detector and the WER bookkeeping. D4 needs five scenarios out of that, and the spec calls the
     * shape it would otherwise take a fork risk.
     *
     * So this is the seam, and everything above it stays where it is: the context is **deep** —
     * behind five methods sit the LiveKit room, the audio source, the onset detector, the transcript
     * join, the per-line WER and the response-latency bookkeeping — and a script never sees any of
     * it. A scenario says "speak this, wait for that", which is what a scenario is.
     */
    const ctx: CallContext = {
      lines: opts.lines,
      borrowerName: opts.borrowerName,
      log,
      sleep,
      speak,
      waitAgentSaid,
      waitAgentSpeaking,
      agentSaid,
      get agentGone() {
        return agentGone;
      },
      waitForHangup: async (timeoutMs: number) => {
        const waitStart = Date.now();
        while (!agentGone && Date.now() - waitStart < timeoutMs) await sleep(200);
        return agentGone;
      },
    };

    await (opts.script ?? promiseToPayScript).run(ctx);

    abandonPendingReply("before the call ended");
    // The last line's transcripts have had the whole hangup wait to arrive.
    closeCurrentLine();

    return {
      label: opts.label,
      borrowerName: opts.borrowerName,
      conversationId,
      roomName,
      hungUp: agentGone,
      agentSegments: agentSaid.map((s) => s.text),
      agentAudioFrames: audioFrames,
      durationMs: Date.now() - t0,
      endedAtMs: Date.now(),
      turnLatencies: [...turnLatencies],
      werLines: [...werLines],
      rmsSamples: [...rmsSamples],
      liveStretchCount: liveStretches,
      borrowerEvents: [...borrowerEvents],
      unmatchedTranscripts: [...unmatchedTranscripts],
      unansweredTurns: [...unansweredTurns],
      error: null,
    };
  } catch (e) {
    return {
      label: opts.label,
      borrowerName: opts.borrowerName,
      conversationId,
      roomName,
      hungUp: agentGone,
      agentSegments: agentSaid.map((s) => s.text),
      agentAudioFrames: audioFrames,
      durationMs: Date.now() - t0,
      endedAtMs: Date.now(),
      turnLatencies: [...turnLatencies],
      werLines: [...werLines],
      rmsSamples: [...rmsSamples],
      liveStretchCount: liveStretches,
      borrowerEvents: [...borrowerEvents],
      unmatchedTranscripts: [...unmatchedTranscripts],
      unansweredTurns: [...unansweredTurns],
      error: String(e),
    };
  } finally {
    await room.disconnect().catch(() => undefined);
  }
};
