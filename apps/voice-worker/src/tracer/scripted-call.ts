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
export const loadScriptedLines = async (): Promise<ScriptedLines> => {
  const speech = buildSpeechStack(borrowerVoice());
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
  /** Short tag used in log lines so concurrent calls are readable. */
  readonly label: string;
  readonly log?: (message: string) => void;
  /**
   * Chaos hook: once the agent has actually replied — so there is a live call to break — this is
   * invoked and the call is abandoned where it stands, with no further lines and no hangup. Only
   * `chaos-orphan.ts` uses it; every other harness leaves it unset and runs the full script.
   */
  readonly abandonAfterFirstReply?: (() => void) | undefined;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** Bootstrap the room through the real control plane, or (TRACER_RAW=1) with a raw agent dispatch. */
const bootstrapRoom = async (opts: ScriptedCallOptions): Promise<{ roomName: string; token: string; conversationId: string | null }> => {
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

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      log(`subscribed to agent audio (${participant.identity})`);
      const stream = new AudioStream(track);
      void (async () => {
        // The track carries frames continuously, silence included, so frame ARRIVAL says nothing —
        // but frame ENERGY does. RMS over int16 samples: measured here, agent TTS speech peaks
        // around 250 and channel silence stays under ~25, so 80 splits them cleanly. First
        // energetic frame after the borrower fell silent is when a human would hear the reply.
        const SPEECH_RMS = 80;
        /**
         * Every fourth sample, not every sample (W8). Frames are ~10 ms, and the onset detector
         * needs that 10 ms of resolution — it does not need the RMS of a 10 ms frame computed over
         * all ~480 of its samples at 48 kHz. A quarter of them puts the same speech/silence
         * decision either side of a threshold that sits between 25 and 250, and takes three
         * quarters of this loop off the box the worker is being measured on. Frames are still
         * counted one by one, and no frame is skipped, so onset timing is unchanged.
         */
        const SAMPLE_STRIDE = 4;
        for await (const frame of stream) {
          audioFrames += 1;
          const pending = awaiting.reply;
          if (pending && pending.audioAt === null) {
            const data = frame.data;
            let sum = 0;
            let n = 0;
            for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
              sum += data[i]! * data[i]!;
              n += 1;
            }
            if (n > 0 && Math.sqrt(sum / n) > SPEECH_RMS) pending.audioAt = Date.now();
          }
        }
      })();
    });
    room.registerTextStreamHandler("lk.transcription", (reader, participantInfo) => {
      const openedAt = Date.now();
      void (async () => {
        const attrs = reader.info.attributes ?? {};
        const fromAgent = participantInfo.identity.startsWith("agent");
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

    // 1. opening (non-interruptible): wait for the right-party question, then a short pause for playout
    log("waiting for opening to finish...");
    let cursor = await waitAgentSaid(new RegExp(`speak with ${firstName(opts.borrowerName)}`, "i"), 0, 60_000);
    await sleep(1500);
    // 2. right-party confirmation
    await speak("yes this is the borrower", opts.lines.yes);
    // 3. wait for the reply to *start*, then barge in ~2s into it.
    //    The wait must be generous: against LiveKit Cloud the STT -> turn -> TTS round trip has been
    //    seen to take 25s+, and barging in before the agent speaks is not a barge-in — the line lands
    //    in silence, the agent then talks over it, and the turn is lost.
    log("waiting for agent reply to start...");
    if (opts.abandonAfterFirstReply) {
      // Abandon the call mid-conversation: no more lines, no hangup, nothing that would let the
      // control plane learn the call is over. That is exactly the state a killed worker leaves.
      const replied = await waitAgentSpeaking(SPEECH_START_TIMEOUT_MS);
      if (!replied) log("agent never replied; abandoning anyway");
      opts.abandonAfterFirstReply();
      closeCurrentLine();
      return {
        label: opts.label,
        borrowerName: opts.borrowerName,
        conversationId,
        roomName,
        hungUp: false,
        agentSegments: agentSaid.map((s) => s.text),
        agentAudioFrames: audioFrames,
        durationMs: Date.now() - t0,
        endedAtMs: Date.now(),
        turnLatencies: [...turnLatencies],
        werLines: [...werLines],
        unmatchedTranscripts: [...unmatchedTranscripts],
        unansweredTurns: [...unansweredTurns],
        error: null,
      };
    }
    if (await waitAgentSpeaking(SPEECH_START_TIMEOUT_MS)) {
      await sleep(2000);
      await speak("BARGE-IN: I can pay 550 on Friday", opts.lines.pay);
    } else {
      log("agent did not start speaking; speaking anyway");
      await speak("I can pay 550 on Friday", opts.lines.pay);
    }
    // 4. wait for the read-back ("Please say yes to confirm"), then confirm. If the agent asks a
    //    clarifying question about the amount instead of proposing, answer it once and keep
    //    waiting — a real borrower would, and the deaf alternative is two NO_INPUT timeouts and a
    //    NO_ANSWER close.
    log("waiting for read-back...");
    {
      const readback = /say yes to confirm/i;
      const askedAmount = /amount|how much/i;
      const start = Date.now();
      // Anchor past everything already said: the broad amount-pattern must only ever see segments
      // that came after the barge-in, not the earlier account statement.
      let from = Math.max(cursor, agentSaid.length);
      let clarified = false;
      let rb = -1;
      while (Date.now() - start < READBACK_TIMEOUT_MS && !agentGone) {
        const idx = agentSaid.findIndex(
          (seg, i) => i >= from && (readback.test(seg.text) || (!clarified && askedAmount.test(seg.text))),
        );
        if (idx >= 0) {
          if (readback.test(agentSaid[idx]!.text)) {
            rb = idx + 1;
            break;
          }
          clarified = true;
          from = idx + 1;
          await sleep(2500); // the transcript stream closes before audio playout finishes
          await speak("the full balance", opts.lines.amount);
        }
        await sleep(100);
      }
      if (rb < 0) log("no read-back seen before the timeout; confirming anyway (the ledger check will catch it)");
      else cursor = rb;
    }
    await sleep(2500); // the transcript stream closes before audio playout finishes
    await speak("yes, that's correct", opts.lines.confirm);
    // 5. wait for hangup
    log("waiting for agent to hang up...");
    const waitStart = Date.now();
    while (!agentGone && Date.now() - waitStart < 40_000) await sleep(200);
    log(agentGone ? "agent hung up" : "agent did not hang up within 40s");
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
      unmatchedTranscripts: [...unmatchedTranscripts],
      unansweredTurns: [...unansweredTurns],
      error: String(e),
    };
  } finally {
    await room.disconnect().catch(() => undefined);
  }
};
