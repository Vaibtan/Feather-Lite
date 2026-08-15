/**
 * Headless *speaking* borrower: joins the room with a published audio track and speaks a
 * scripted set of lines (synthesised with LiveKit Inference TTS) at the right moments:
 *
 *   1. wait for the agent to finish its opening (silence on the agent track for ~1.2s)
 *   2. say "Yes, this is Jordan."
 *   3. wait for the agent's reply to *start*, then barge in with "I can pay on Friday." after ~2s
 *   4. wait for the read-back to finish, say "Yes."
 *   5. stay until the agent hangs up
 *
 * This is an automated end-to-end voice regression: STT -> llmNode -> TTS -> playout -> barge-in.
 * It is deliberately crude (timing heuristics), but it lets CI-ish runs exercise the real audio path.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { inference, initializeLogger, tts as ttsBase } from "@livekit/agents";
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

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

const url = process.env["LIVEKIT_URL"] ?? "";
const key = process.env["LIVEKIT_API_KEY"] ?? "";
const secret = process.env["LIVEKIT_API_SECRET"] ?? "";
const agentName = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-tracer";

const t0 = Date.now();
const log = (m: string) => console.log(`[borrower] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

/* ---------- synthesise the borrower's lines up front (a different voice than the agent) ---------- */
const tts = new inference.TTS({ model: "cartesia/sonic-3", voice: "a0e99841-438c-4a64-b679-ae501e7d6091" });
const synth = async (text: string): Promise<AudioFrame[]> => {
  const frames: AudioFrame[] = [];
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  for await (const ev of stream) {
    if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
    frames.push(ev.frame);
  }
  stream.close();
  return frames;
};
log("synthesising borrower lines...");
const [lineYes, linePay, lineConfirm] = await Promise.all([
  synth("Yes, this is Jordan."),
  synth("Actually, wait. I can pay on Friday."),
  synth("Yes, that's correct."),
]);
log(`synthesised: yes=${lineYes.length}f pay=${linePay.length}f confirm=${lineConfirm.length}f`);
await tts.close();

/* ---------- room + dispatch ---------- */
const rooms = new RoomServiceClient(url, key, secret);
const dispatch = new AgentDispatchClient(url, key, secret);
const roomName = `tracer-${Date.now().toString(36)}`;
await rooms.createRoom({ name: roomName, emptyTimeout: 120, metadata: JSON.stringify({ tracer: true }) });
await dispatch.createDispatch(roomName, agentName, { metadata: JSON.stringify({ tracer: true }) });
log(`room=${roomName}`);

const at = new AccessToken(key, secret, { identity: "borrower-headless", name: "Jordan (headless)" });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const token = await at.toJwt();

const room = new Room();
let agentGone = false;
let audioFrames = 0;
/** Final agent transcript segments, in order (from the `lk.transcription` text stream). */
const agentSaid: Array<{ at: number; text: string }> = [];
/** Non-final agent segment seen recently => the agent is currently speaking. */
let agentSpeakingAt = 0;

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

await room.connect(url, token, { autoSubscribe: true, dynacast: false });
log("connected");

const first = lineYes[0];
if (!first) throw new Error("no synthesised audio");
log(`borrower audio format: ${first.sampleRate}Hz x${first.channels}`);
const source = new AudioSource(first.sampleRate, first.channels);
const track = LocalAudioTrack.createAudioTrack("mic", source);
const opts = new TrackPublishOptions();
opts.source = TrackSource.SOURCE_MICROPHONE;
await room.localParticipant!.publishTrack(track, opts);
log("mic published");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speak = async (label: string, frames: AudioFrame[]) => {
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
let cursor = await waitAgentSaid(/speak with Jordan/i, 0, 60_000);
await sleep(1500);
// 2. right-party confirmation
await speak("yes this is Jordan", lineYes);
// 3. wait for the reply to start, then barge in ~2s into it
log("waiting for agent reply to start...");
if (await waitAgentSpeaking(20_000)) {
  await sleep(2000);
  await speak("BARGE-IN: I can pay on Friday", linePay);
} else {
  log("agent did not start speaking; speaking anyway");
  await speak("I can pay on Friday", linePay);
}
// 4. wait for the read-back ("Please say yes to confirm"), then confirm
log("waiting for read-back...");
cursor = await waitAgentSaid(/say yes to confirm/i, cursor, 30_000);
await sleep(2500); // transcript stream closes before audio playout finishes
await speak("yes, that's correct", lineConfirm);
// 5. wait for hangup
log("waiting for agent to hang up...");
const start = Date.now();
while (!agentGone && Date.now() - start < 40_000) await sleep(200);
log(agentGone ? "agent hung up: PASS" : "agent did not hang up within 40s: FAIL");
log(`agent audio frames received=${audioFrames}; agent final segments=${agentSaid.length}`);
await room.disconnect();
process.exit(agentGone ? 0 : 1);
