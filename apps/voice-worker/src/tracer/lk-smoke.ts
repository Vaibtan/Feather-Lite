/**
 * LiveKit server smoke test: proves LIVEKIT_URL/KEY/SECRET can mint a token and drive the server
 * API (create room -> list -> agent dispatch list -> delete). Works against LiveKit Cloud and the
 * self-hosted container (`pnpm lk:up`) unchanged — that portability is the point of ADR 0006.
 *
 * Run: pnpm --filter @feather-lite/voice-worker lk-smoke
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const url = process.env["LIVEKIT_URL"] ?? "";
const key = process.env["LIVEKIT_API_KEY"] ?? "";
const secret = process.env["LIVEKIT_API_SECRET"] ?? "";
if (!url || !key || !secret) throw new Error("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set");

const roomName = `smoke-${Date.now().toString(36)}`;
const rooms = new RoomServiceClient(url, key, secret);
console.log(`[lk-smoke] target=${url} key=${key}`);

const created = await rooms.createRoom({ name: roomName, emptyTimeout: 60, metadata: JSON.stringify({ smoke: true }) });
console.log(`[lk-smoke] created room ${created.name} sid=${created.sid}`);

const listed = await rooms.listRooms([roomName]);
if (listed.length !== 1 || listed[0]?.name !== roomName) throw new Error(`listRooms did not return ${roomName}: ${JSON.stringify(listed.map((r) => r.name))}`);
console.log(`[lk-smoke] listRooms -> ${listed.map((r) => r.name).join(", ")}`);

// Explicit agent dispatch is an OSS-server feature too; the control plane relies on it.
const dispatchClient = new AgentDispatchClient(url, key, secret);
const dispatches = await dispatchClient.listDispatch(roomName);
console.log(`[lk-smoke] listDispatch -> ${dispatches.length} dispatch(es)`);

const at = new AccessToken(key, secret, { identity: "smoke-participant" });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const jwt = await at.toJwt();
console.log(`[lk-smoke] participant token minted (${jwt.length} chars)`);

await rooms.deleteRoom(roomName);
console.log("[lk-smoke] deleted room; PASS");
