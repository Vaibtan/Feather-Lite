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
import { buildSpeechStack, speechProvider } from "../speech.js";
import { synthesizeCached } from "./line-cache.js";

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

export interface ScriptedLines {
  readonly yes: ReadonlyArray<AudioFrame>;
  readonly pay: ReadonlyArray<AudioFrame>;
  /** Answer to an amount-clarifying question, if the agent asks one instead of proposing. */
  readonly amount: ReadonlyArray<AudioFrame>;
  readonly confirm: ReadonlyArray<AudioFrame>;
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
    const yes = await synthesizeCached(speech.tts, "Yes, this is Jordan.", key);
    const pay = await synthesizeCached(speech.tts, "Actually, wait. I can pay 550 dollars on Friday.", key);
    const amount = await synthesizeCached(speech.tts, "The full balance. 550 dollars.", key);
    const confirm = await synthesizeCached(speech.tts, "Yes, that's correct.", key);
    return {
      yes: yes.frames,
      pay: pay.frames,
      amount: amount.frames,
      confirm: confirm.frames,
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
  /** Per-turn response latency, in scripted order. See {@link TurnLatency}. */
  readonly turnLatencies: ReadonlyArray<TurnLatency>;
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

  const bearer = process.env["API_BEARER_TOKEN"];
  const dir = (await (await fetch(`${opts.controlPlaneUrl}/api/borrowers`)).json()) as Array<{ borrower_id: string; name: string; contact_points: Array<{ contact_point_id: string }> }>;
  const b = dir.find((x) => x.name === opts.borrowerName);
  if (!b) throw new Error(`borrower ${opts.borrowerName} not found in ${opts.controlPlaneUrl}/api/borrowers`);
  const res = await fetch(`${opts.controlPlaneUrl}/api/voice/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
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
        for await (const frame of stream) {
          audioFrames += 1;
          const pending = awaiting.reply;
          if (pending && pending.audioAt === null) {
            const data = frame.data;
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
            if (Math.sqrt(sum / data.length) > SPEECH_RMS) pending.audioAt = Date.now();
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
              turnLatencies.push({ turn: pending.turn, ms, audioMs });
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

    const speak = async (label: string, frames: ReadonlyArray<AudioFrame>) => {
      log(`speaking: ${label}`);
      for (const f of frames) await source.captureFrame(f);
      await source.waitForPlayout();
      log(`finished: ${label}`);
      abandonPendingReply("before the next line"); // the script waited, timed out, and moved on
      awaiting.reply = { turn: label, at: Date.now(), audioAt: null };
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

    return {
      label: opts.label,
      borrowerName: opts.borrowerName,
      conversationId,
      roomName,
      hungUp: agentGone,
      agentSegments: agentSaid.map((s) => s.text),
      agentAudioFrames: audioFrames,
      durationMs: Date.now() - t0,
      turnLatencies: [...turnLatencies],
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
      turnLatencies: [...turnLatencies],
      unansweredTurns: [...unansweredTurns],
      error: String(e),
    };
  } finally {
    await room.disconnect().catch(() => undefined);
  }
};
