/**
 * Minimal token server + test page for a browser join. Creates a room, dispatches the tracer
 * agent by name, and returns a participant token. Throwaway; the real endpoint lives in the
 * control plane (`POST /api/voice/sessions`).
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const url = process.env["LIVEKIT_URL"] ?? "";
const apiKey = process.env["LIVEKIT_API_KEY"] ?? "";
const apiSecret = process.env["LIVEKIT_API_SECRET"] ?? "";
const agentName = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-tracer";
const port = Number(process.env["TRACER_TOKEN_PORT"] ?? 8787);

if (!url || !apiKey || !apiSecret) {
  console.error("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing from .env");
  process.exit(1);
}

const rooms = new RoomServiceClient(url, apiKey, apiSecret);
const dispatch = new AgentDispatchClient(url, apiKey, apiSecret);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Feather-Lite tracer</title>
<style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px}pre{background:#f4f4f4;padding:12px;height:280px;overflow:auto}button{padding:10px 16px;font-size:16px}</style>
<h1>Feather-Lite voice tracer bullet</h1>
<p>Click <b>Call</b>, allow the microphone, and talk to the agent. Try interrupting it mid-sentence.</p>
<button id="call">Call</button> <button id="hangup" disabled>Hang up</button>
<pre id="log"></pre>
<script type="module">
import { Room, RoomEvent, Track } from "https://cdn.jsdelivr.net/npm/livekit-client@2/+esm";
const log = (m) => { const el = document.getElementById("log"); el.textContent += m + "\\n"; el.scrollTop = el.scrollHeight; };
let room;
document.getElementById("call").onclick = async () => {
  const res = await fetch("/token", { method: "POST" });
  const { url, token, roomName } = await res.json();
  room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind === Track.Kind.Audio) { const el = track.attach(); document.body.appendChild(el); log("agent audio attached from " + participant.identity); }
  });
  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    for (const s of segments) if (s.final) log((participant?.identity ?? "?") + ": " + s.text);
  });
  room.on(RoomEvent.ParticipantConnected, (p) => log("participant connected: " + p.identity));
  room.on(RoomEvent.Disconnected, () => log("disconnected"));
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  log("connected to " + roomName + " as " + room.localParticipant.identity);
  document.getElementById("hangup").disabled = false;
};
document.getElementById("hangup").onclick = async () => { await room?.disconnect(); };
</script>`;

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/token") {
      const roomName = `tracer-${Date.now().toString(36)}`;
      await rooms.createRoom({ name: roomName, emptyTimeout: 300, metadata: JSON.stringify({ tracer: true }) });
      const d = await dispatch.createDispatch(roomName, agentName, { metadata: JSON.stringify({ tracer: true }) });
      const at = new AccessToken(apiKey, apiSecret, { identity: "borrower-browser", name: "Jordan (browser)" });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url, token, roomName, dispatchId: d.id }));
      console.log(`[token] room=${roomName} dispatch=${d.id}`);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end(String(err));
  }
}).listen(port, () => console.log(`[token] http://localhost:${port}  (agent=${agentName})`));
