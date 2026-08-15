/**
 * Headless "borrower": creates a room, dispatches the tracer agent, joins as a participant
 * (subscribes only, no mic), counts agent audio frames, and stays until the agent hangs up or
 * `TRACER_STAY_S` elapses. Exercises real-time playout, transcription forwarding and the
 * `userAwayTimeout` path without a human.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { AudioStream, Room, RoomEvent, TrackKind } from "@livekit/rtc-node";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
const url = process.env["LIVEKIT_URL"] ?? "";
const key = process.env["LIVEKIT_API_KEY"] ?? "";
const secret = process.env["LIVEKIT_API_SECRET"] ?? "";
const agentName = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-tracer";
const staySeconds = Number(process.env["TRACER_STAY_S"] ?? 60);

const rooms = new RoomServiceClient(url, key, secret);
const dispatch = new AgentDispatchClient(url, key, secret);
const roomName = `tracer-${Date.now().toString(36)}`;
await rooms.createRoom({ name: roomName, emptyTimeout: 120, metadata: JSON.stringify({ tracer: true }) });
const d = await dispatch.createDispatch(roomName, agentName, { metadata: JSON.stringify({ tracer: true }) });
console.log(`[fake] room=${roomName} dispatch=${d.id}`);

const at = new AccessToken(key, secret, { identity: "borrower-headless", name: "Jordan (headless)" });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const token = await at.toJwt();

const room = new Room();
let frames = 0;
let firstAudioAt: number | null = null;
const t0 = Date.now();
room.on(RoomEvent.ParticipantConnected, (p) => console.log(`[fake] +${Date.now() - t0}ms participant connected ${p.identity}`));
room.on(RoomEvent.ParticipantDisconnected, (p) => console.log(`[fake] +${Date.now() - t0}ms participant disconnected ${p.identity}`));
room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  console.log(`[fake] +${Date.now() - t0}ms subscribed to audio from ${participant.identity}`);
  const stream = new AudioStream(track);
  void (async () => {
    for await (const _frame of stream) {
      frames += 1;
      if (firstAudioAt === null) {
        firstAudioAt = Date.now();
        console.log(`[fake] +${firstAudioAt - t0}ms first agent audio frame`);
      }
    }
  })();
});
room.on(RoomEvent.Disconnected, (reason) => console.log(`[fake] +${Date.now() - t0}ms disconnected reason=${String(reason)}`));

await room.connect(url, token, { autoSubscribe: true, dynacast: false });
console.log(`[fake] +${Date.now() - t0}ms connected as ${room.localParticipant?.identity}`);

await new Promise((r) => setTimeout(r, staySeconds * 1000));
console.log(`[fake] done: audio frames received=${frames}`);
await room.disconnect();
process.exit(0);
