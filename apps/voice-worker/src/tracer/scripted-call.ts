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
import { addNoiseAtSnr, dropFrames, makeRng, muLawRoundTrip, wordErrorRate, type DegradationProfile } from "@feather-lite/domain";
import { buildSpeechStack, speechProvider } from "../speech.js";
import { synthesizeCached } from "./line-cache.js";
import { harnessHeaders, harnessJsonHeaders } from "@feather-lite/load-test/harness-http";
// The threshold and the hangover come from `domain` rather than a second copy: the live detector
// and the post-hoc `speechWindows()` must agree, and drifting apart on the value is the failure
// that module exists to prevent.
import { SILENCE_HANGOVER_MS, SPEECH_RMS, type BorrowerEvent, type RmsSample } from "@feather-lite/domain";

/** Resolved lazily: harnesses load .env after imports are hoisted. */
const borrowerVoice = (): string =>
  speechProvider() === "plugins"
    ? "aura-2-orion-en" // Deepgram Aura model name (the voice IS the model)
    : "a0e99841-438c-4a64-b679-ae501e7d6091"; // Cartesia voice id via Cloud Inference

const SPEECH_START_TIMEOUT_MS = 60_000;
const READBACK_TIMEOUT_MS = 60_000;

export interface ScriptedLine {
  readonly frames: ReadonlyArray<AudioFrame>;
  readonly text: string;
}

export interface ScriptedLines {
  readonly yes: ScriptedLine;
  readonly pay: ScriptedLine;
  readonly amount: ScriptedLine;
  readonly confirm: ScriptedLine;
  readonly backchannel: ScriptedLine;
  readonly hold: ScriptedLine;
  readonly yesEarly: ScriptedLine;
  readonly sampleRate: number;
  readonly channels: number;
  readonly cached: boolean;
  readonly describe: string;
}

/** A name, not a voice id: the id is provider-specific and the report must stay readable. */
export type BorrowerPersona = string;

export const loadScriptedLines = async (persona?: BorrowerPersona): Promise<ScriptedLines> => {
  const speech = buildSpeechStack(persona ?? borrowerVoice());
  const key = `${speech.provider}|${speech.describe}`;
  try {
    // Sequential on purpose: some TTS plugins multiplex synthesis over one pooled WebSocket and
    // silently drop a generation under concurrency.
    const YES = "Yes, this is Jordan.";
    const PAY = "Actually, wait. I can pay 550 dollars on Friday.";
    const AMOUNT = "The full balance. 550 dollars.";
    const CONFIRM = "Yes, that's correct.";
    const BACKCHANNEL = "Mm-hm.";
    const HOLD = "Hold on, let me get my card.";
    const YES_EARLY = "Yes.";
    const yes = await synthesizeCached(speech.tts, YES, key);
    const pay = await synthesizeCached(speech.tts, PAY, key);
    const amount = await synthesizeCached(speech.tts, AMOUNT, key);
    const confirm = await synthesizeCached(speech.tts, CONFIRM, key);
    const backchannel = await synthesizeCached(speech.tts, BACKCHANNEL, key);
    const hold = await synthesizeCached(speech.tts, HOLD, key);
    const yesEarly = await synthesizeCached(speech.tts, YES_EARLY, key);
    return {
      yes: { frames: yes.frames, text: YES },
      pay: { frames: pay.frames, text: PAY },
      amount: { frames: amount.frames, text: AMOUNT },
      confirm: { frames: confirm.frames, text: CONFIRM },
      backchannel: { frames: backchannel.frames, text: BACKCHANNEL },
      hold: { frames: hold.frames, text: HOLD },
      yesEarly: { frames: yesEarly.frames, text: YES_EARLY },
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
  readonly script?: BorrowerScript | undefined;
  /** The seam a scenario needs to react to an onset; a transcript arrives a sentence too late. */
  readonly onStretchStart?: ((index: number, atMs: number) => void) | undefined;
  readonly onStretchEnd?: ((index: number, atMs: number) => void) | undefined;
  readonly label: string;
  /**
   * What keeps a simulator call out of the window the product's latency claim is made from: it is
   * `channel: "voice"` served by the real decider, so no other segment column can tell it apart.
   */
  readonly harness?: string | undefined;
  readonly degradation?: DegradationProfile | null | undefined;
  /** Seeds the noise and the frame loss, so a degraded run is repeatable. */
  readonly degradationSeed?: number | undefined;
  readonly log?: (message: string) => void;
  /** Abandons the call where it stands, with no further lines and no hangup. */
}

/**
 * Measured from the return of `speak()` to the first delta of the next agent segment: a headless
 * client cannot see audio onset, because the subscribed track carries silence continuously. A
 * segment already in flight during a barge-in is the line being interrupted, not a reply.
 */
export interface TurnLatency {
  readonly turn: string;
  /** Carried so a score joins the ledger's turn by time rather than by position. */
  readonly atMs: number;
  readonly ms: number;
  /**
   * The same interval measured to the first energetic audio frame instead of the first
   * transcription delta, which the framework paces against playout and which lags it.
   */
  readonly audioMs: number | null;
}

export interface WerLine {
  readonly turn: string;
  readonly atMs: number;
  readonly reference: string;
  readonly hypothesis: string;
  /** Null when the reference was empty — nothing to be wrong about. */
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
  readonly hungUp: boolean;
  readonly agentSegments: ReadonlyArray<string>;
  readonly agentAudioFrames: number;
  readonly durationMs: number;
  /** `durationMs` cannot close a join window: measurements are absolute instants. */
  readonly endedAtMs: number;
  readonly turnLatencies: ReadonlyArray<TurnLatency>;
  readonly werLines: ReadonlyArray<WerLine>;
  readonly rmsSamples: ReadonlyArray<RmsSample>;
  readonly liveStretchCount: number;
  readonly borrowerEvents: ReadonlyArray<BorrowerEvent>;
  /** Non-empty means the reference/hypothesis pairing may be off by one for that run. */
  readonly unmatchedTranscripts: ReadonlyArray<string>;
  /** Reported so a short `turnLatencies` list is never mistaken for a clean run. */
  readonly unansweredTurns: ReadonlyArray<string>;
  readonly error: string | null;
}

/**
 * Deep on purpose: behind these few members sit the LiveKit room, the audio source, the RMS onset
 * detector, the transcript join, the per-line word-error bookkeeping and the response-latency
 * measurement. A script says "speak this, wait for that" and none of the rest is its business,
 * which is what makes five scenarios five scripts rather than five forks of one long function.
 */
export interface CallContext {
  readonly lines: ScriptedLines;
  readonly borrowerName: string;
  readonly log: (message: string) => void;
  readonly sleep: (ms: number) => Promise<unknown>;
  /** Returns when playout finishes, the instant both measurements about the line are anchored to. */
  readonly speak: (label: string, line: ScriptedLine) => Promise<void>;
  readonly waitAgentSaid: (pattern: RegExp, from: number, timeoutMs: number) => Promise<number>;
  readonly waitAgentSpeaking: (timeoutMs: number) => Promise<boolean>;
  readonly agentSaid: ReadonlyArray<{ readonly at: number; readonly text: string }>;
  readonly agentGone: boolean;
  /** Returns the onset, or null: a segment arrives when it closes, so its text is too late. */
  readonly waitNextStretchStart: (timeoutMs: number) => Promise<number | null>;
  /**
   * Words spoken into a non-interruptible line are dropped at the worker, so a scenario that means
   * to be heard must wait for silence — and only the audio can say when.
   */
  readonly waitAgentQuiet: (quietMs: number, timeoutMs: number) => Promise<boolean>;
  readonly waitForHangup: (timeoutMs: number) => Promise<boolean>;
}

export interface BorrowerScript {
  readonly name: string;
  readonly run: (ctx: CallContext) => Promise<void>;
}

const SPEECH_START_WAIT_MS = SPEECH_START_TIMEOUT_MS;

export const promiseToPayScript: BorrowerScript = {
  name: "promise-to-pay",
  run: async (ctx) => {
    const firstNameOf = (full: string) => full.trim().split(/\s+/)[0] ?? full;
    ctx.log("waiting for opening to finish...");
    let cursor = await ctx.waitAgentSaid(new RegExp(`speak with ${firstNameOf(ctx.borrowerName)}`, "i"), 0, 60_000);
    await ctx.sleep(1500);
    await ctx.speak("yes this is the borrower", ctx.lines.yes);
    // The wait must be generous: the STT -> turn -> TTS round trip has been seen to take 25 s, and
    // barging in before the agent speaks is not a barge-in — the line lands in silence and is lost.
    ctx.log("waiting for agent reply to start...");
    if (await ctx.waitAgentSpeaking(SPEECH_START_WAIT_MS)) {
      await ctx.sleep(2000);
      await ctx.speak("BARGE-IN: I can pay 550 on Friday", ctx.lines.pay);
    } else {
      ctx.log("agent did not start speaking; speaking anyway");
      await ctx.speak("I can pay 550 on Friday", ctx.lines.pay);
    }
    // Answer an amount clarification once and keep waiting; the deaf alternative is a NO_ANSWER close.
    ctx.log("waiting for read-back...");
    {
      const readback = /say yes to confirm/i;
      const askedAmount = /amount|how much/i;
      const start = Date.now();
      // Anchor past everything already said: the broad amount-pattern must only see segments from
      // after the barge-in, not the earlier account statement.
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
    ctx.log("waiting for agent to hang up...");
    ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
  },
};

export const abandonAfterFirstReplyScript = (onAbandon: () => void): BorrowerScript => ({
  name: "abandon-after-first-reply",
  run: async (ctx) => {
    ctx.log("waiting for agent reply to start...");
    if (!(await ctx.waitAgentSpeaking(SPEECH_START_WAIT_MS))) ctx.log("agent never replied; abandoning anyway");
    // No more lines, no hangup: nothing that lets the control plane learn the call is over.
    onAbandon();
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/**
 * Exported because a tier-3 scenario that is not a `runScriptedCall` still has to enter the room
 * the same way. `TRACER_RAW=1` uses a raw agent dispatch instead of the control plane.
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

  // Through `harnessHeaders`: this is the one call the server's per-IP budget can shed, and a 429
  // here looks like a missing fixture.
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
      ...(opts.harness === undefined ? {} : { harness: opts.harness }),
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
  const rmsSamples: Array<RmsSample> = [];
  const borrowerEvents: Array<BorrowerEvent> = [];
  /**
   * Every fourth sample: the onset detector needs 10 ms of resolution, not the RMS of a 10 ms frame
   * over all ~480 of its samples at 48 kHz. A quarter of them puts the same decision either side of
   * a threshold that sits between 25 and 250, and takes three quarters of this loop off the box.
   */
  const SAMPLE_STRIDE = 4;
  let liveStretches = 0;
  /** On the audio clock. Onsets are the only thing that says the agent is talking now. */
  const stretchStarts: number[] = [];
  let lastStretchEndMs = 0;
  let agentSpeakingNow = false;
  const unmatchedTranscripts: string[] = [];
  /**
   * A list, not a single transcript, because the STT splits one utterance across several finals:
   * measured, "Actually, wait. I can pay 550 dollars on Friday." came back as two, and taking only
   * the first scored the missing half as deletions. Opened before the audio is played, since the
   * first final can arrive while the borrower is still speaking.
   *
   * `closedAt` is null rather than 0 until the line is finished: a 0 would sort before every ledger
   * turn and silently join the wrong one.
   */
  let currentLine: { turn: string; reference: string; parts: string[]; closedAt: number | null } | null = null;
  const unansweredTurns: Array<string> = [];
  const awaiting: { reply: { turn: string; at: number; audioAt: number | null } | null } = { reply: null };
  /** Recorded rather than dropped: a silently shorter `turnLatencies` would flatter the mean. */
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
     * The same identity rule the transcript handler uses, in one place: filtering on `kind` alone
     * books a third party's energy as agent speech.
     */
    const isAgent = (identity: string): boolean => identity.startsWith("agent");

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (!isAgent(participant.identity)) {
        log(`ignoring audio from non-agent participant ${participant.identity} (not the agent's speech)`);
        return;
      }
      log(`subscribed to agent audio (${participant.identity})`);
      const stream = new AudioStream(track);
      void (async () => {
        /**
         * RMS is computed for every frame of agent audio, not only while a reply is pending: the
         * turn-taking metrics are about stretches, and `speechWindows()` needs samples for all of them.
         *
         * Timed from a sample counter, not `Date.now()` per chunk. Frames arrive in bursts through
         * an async iterator, so wall-clock at delivery is jittered by the event loop, while every
         * frame is `samplesPerChannel / sampleRate` seconds of speech whenever it arrives. `t0Audio`
         * anchors that count to the wall clock once, so a stretch can still be joined to a playout.
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
           * The same rule `speechWindows()` applies post hoc, at the same threshold and the same
           * 700 ms hangover — a pause inside a line is a few hundred milliseconds and the gap between
           * two turns is the whole latency waterfall. Live because a scenario has to react to an
           * onset, and post hoc so the run can check that what it reacted to is what the samples say.
           */
          if (rms > SPEECH_RMS) {
            if (!inStretch) {
              inStretch = true;
              liveStretches += 1;
              stretchStarts.push(atMs);
              agentSpeakingNow = true;
              opts.onStretchStart?.(liveStretches, atMs);
            }
            lastLoudMs = atMs;
          } else if (inStretch && atMs - lastLoudMs > SILENCE_HANGOVER_MS) {
            inStretch = false;
            lastStretchEndMs = Date.now();
            agentSpeakingNow = false;
            opts.onStretchEnd?.(liveStretches, lastLoudMs);
          }

          // The first energetic frame after the borrower fell silent.
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
        // Only this borrower feeds the word-error gate: a third party's words are not the script.
        const fromThisBorrower = participantInfo.identity === opts.participantIdentity;
        if (!fromAgent && !fromThisBorrower) {
          log(`ignoring transcript from ${participantInfo.identity}: neither the agent nor this borrower`);
          return;
        }
        let text = "";
        for await (const chunk of reader) {
          text += chunk;
          if (fromAgent) {
            agentSpeakingAt = Date.now();
            // Only a segment that opened after the borrower fell silent is a reply to it; one already
            // in flight during a barge-in is the line being interrupted.
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
            // Counted rather than dropped: an unnoticed mis-pairing moves WER without looking wrong.
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

    /**
     * Order is physical: the room's noise reaches the microphone first, the codec quantises what
     * the microphone captured, and the network loses whole frames of the encoded stream last.
     */
  const degradeFrames = (frames: ReadonlyArray<AudioFrame>): ReadonlyArray<AudioFrame | null> => {
    const profile = opts.degradation;
    if (profile === undefined || profile === null) return [...frames];
    const rng = makeRng(opts.degradationSeed ?? 1);
    const shaped = frames.map((f) => {
      let pcm = f.data;
      if (profile.snrDb > 0) pcm = addNoiseAtSnr(pcm, profile.snrDb, rng);
      if (profile.muLaw) pcm = muLawRoundTrip(pcm);
      return new AudioFrame(pcm, f.sampleRate, f.channels, f.samplesPerChannel);
    });
    return dropFrames(shaped, { lossRate: profile.lossRate, burstiness: profile.burstiness, rng });
  };

  const speak = async (label: string, line: ScriptedLine) => {
      const startedAt = Date.now();
      closeCurrentLine();
      // Opened before playout: the STT can emit a final for the first phrase while the rest is still
      // being spoken, and that phrase is part of this line, not a stray.
      currentLine = { turn: label, reference: line.text, parts: [], closedAt: null };
      log(`speaking: ${label}`);
      /**
       * Applied at the last moment before publishing, so everything upstream is unchanged and the
       * degradation is the only difference between a clean run and a degraded one. `null` frames are
       * not sent: a lost frame is absent audio, and sending silence would affect the endpointer.
       */
      for (const f of degradeFrames(line.frames)) {
        if (f !== null) await source.captureFrame(f);
      }
      await source.waitForPlayout();
      log(`finished: ${label}`);
      const spokenAt = Date.now();
      borrowerEvents.push({ kind: "line", label, startMs: startedAt, endMs: spokenAt });
      currentLine.closedAt = spokenAt;
      abandonPendingReply("before the next line"); // the script waited, timed out, and moved on
      awaiting.reply = { turn: label, at: spokenAt, audioAt: null };
    };
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
      /** Returns the onset instant, or null on timeout — what the transcript cannot answer. */
      waitNextStretchStart: async (timeoutMs: number) => {
        const from = stretchStarts.length;
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const at = stretchStarts[from];
          if (at !== undefined) return at;
          if (agentGone) return null;
          await sleep(50);
        }
        return null;
      },
      /**
       * Words spoken into a non-interruptible line are dropped at the worker rather than deferred,
       * so a scenario that means to be heard has to wait for silence — and the transcript cannot
       * tell it when, because a segment arrives only once it has closed.
       */
      waitAgentQuiet: async (quietMs: number, timeoutMs: number) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (agentGone) return false;
          if (!agentSpeakingNow && lastStretchEndMs > 0 && Date.now() - lastStretchEndMs >= quietMs) return true;
          await sleep(50);
        }
        return false;
      },
      waitForHangup: async (timeoutMs: number) => {
        const waitStart = Date.now();
        while (!agentGone && Date.now() - waitStart < timeoutMs) await sleep(200);
        return agentGone;
      },
    };

    await (opts.script ?? promiseToPayScript).run(ctx);

    abandonPendingReply("before the call ended");
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
