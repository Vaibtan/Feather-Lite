/**
 * One automated end-to-end voice call with a *speaking* headless borrower.
 *
 * The borrower joins the room with a published audio track and speaks a scripted set of lines at
 * the right moments:
 *
 *   1. wait for the agent to finish its opening (the right-party question)
 *   2. say "Yes, this is <name>."
 *   3. wait for the agent's reply to *start*, then barge in with "I can pay on Friday." after ~2s
 *   4. wait for the read-back to finish, say "Yes, that's correct."
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
    const pay = await synthesizeCached(speech.tts, "Actually, wait. I can pay on Friday.", key);
    const confirm = await synthesizeCached(speech.tts, "Yes, that's correct.", key);
    return {
      yes: yes.frames,
      pay: pay.frames,
      confirm: confirm.frames,
      sampleRate: yes.sampleRate,
      channels: yes.channels,
      cached: yes.cached && pay.cached && confirm.cached,
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
        for await (const _frame of stream) audioFrames += 1;
      })();
    });
    room.registerTextStreamHandler("lk.transcription", (reader, participantInfo) => {
      void (async () => {
        const attrs = reader.info.attributes ?? {};
        const fromAgent = participantInfo.identity.startsWith("agent");
        let text = "";
        // Agent segments are delta streams: chunks arrive as the agent speaks; the stream closes at segment end.
        for await (const chunk of reader) {
          text += chunk;
          if (fromAgent) agentSpeakingAt = Date.now();
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
      await speak("BARGE-IN: I can pay on Friday", opts.lines.pay);
    } else {
      log("agent did not start speaking; speaking anyway");
      await speak("I can pay on Friday", opts.lines.pay);
    }
    // 4. wait for the read-back ("Please say yes to confirm"), then confirm
    log("waiting for read-back...");
    cursor = await waitAgentSaid(/say yes to confirm/i, cursor, READBACK_TIMEOUT_MS);
    if (cursor < 0) log("no read-back seen before the timeout; confirming anyway (the ledger check will catch it)");
    await sleep(2500); // the transcript stream closes before audio playout finishes
    await speak("yes, that's correct", opts.lines.confirm);
    // 5. wait for hangup
    log("waiting for agent to hang up...");
    const waitStart = Date.now();
    while (!agentGone && Date.now() - waitStart < 40_000) await sleep(200);
    log(agentGone ? "agent hung up" : "agent did not hang up within 40s");

    return {
      label: opts.label,
      borrowerName: opts.borrowerName,
      conversationId,
      roomName,
      hungUp: agentGone,
      agentSegments: agentSaid.map((s) => s.text),
      agentAudioFrames: audioFrames,
      durationMs: Date.now() - t0,
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
      error: String(e),
    };
  } finally {
    await room.disconnect().catch(() => undefined);
  }
};
