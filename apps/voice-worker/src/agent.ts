/**
 * Feather-Lite voice worker (LiveKit Agents). Registers with LiveKit Cloud under LIVEKIT_AGENT_NAME
 * and, per dispatched job:
 *   1. reads conversation/mode/opening from the room metadata written by POST /api/voice/sessions
 *   2. starts an AgentSession (STT/TTS via LiveKit Inference, silero VAD, multilingual EOT,
 *      preemptive generation OFF, speech during non-interruptible segments buffered)
 *   3. browser mode: waits for the participant, speaks the opening, then every user turn is a
 *      control-plane turn (FeatherAgent.llmNode)
 *      sip mode: dials the borrower, runs AMD, and only speaks the opening to a HUMAN
 *   4. reports playout truth / no-input / hangup back as signals; ends the call by deleting the room
 *
 * Run: pnpm --filter @feather-lite/voice-worker dev   (needs .env at repo root)
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent, inference, voice } from "@livekit/agents";
import * as livekitPlugin from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { ControlPlaneClient } from "./control-plane-client.js";
import { FeatherAgent } from "./feather-agent.js";
import { RemoteOrchestratorLLM } from "./tracer/remote-orchestrator-llm.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const AGENT_NAME = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-agent";
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const API_BEARER_TOKEN = process.env["API_BEARER_TOKEN"] ?? null;
const STT_MODEL = process.env["LIVEKIT_STT_MODEL"] ?? "deepgram/nova-3";
const TTS_MODEL = process.env["LIVEKIT_TTS_MODEL"] ?? "cartesia/sonic-3";
const TTS_VOICE = process.env["LIVEKIT_TTS_VOICE"] ?? "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
const SIP_OUTBOUND_TRUNK_ID = process.env["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"] ?? null;

const client = new ControlPlaneClient({ baseUrl: CONTROL_PLANE_URL, bearerToken: API_BEARER_TOKEN });

interface RoomMeta {
  conversation_id?: string;
  mode?: "browser" | "sip";
  opening_text?: string;
  contact_point_value?: string;
}
const parseMeta = (raw: string | undefined): RoomMeta => {
  try {
    return raw ? (JSON.parse(raw) as RoomMeta) : {};
  } catch {
    return {};
  }
};

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(`[feather] ${msg} ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`);
    await ctx.connect();
    const meta = parseMeta(ctx.room.metadata ?? ctx.job.metadata);
    const conversationId = meta.conversation_id;
    if (!conversationId) {
      log("room has no conversation_id in metadata; leaving", { room: ctx.room.name });
      ctx.shutdown("no conversation");
      return;
    }
    const mode = meta.mode ?? "browser";
    const roomName = ctx.room.name ?? "";
    log("job started", { room: roomName, conversationId, mode });

    const lk = { url: process.env["LIVEKIT_URL"] ?? "", key: process.env["LIVEKIT_API_KEY"] ?? "", secret: process.env["LIVEKIT_API_SECRET"] ?? "" };
    const rooms = new RoomServiceClient(lk.url, lk.key, lk.secret);
    let ended = false;
    const hangup = async (reason: string) => {
      if (ended) return;
      ended = true;
      log("hangup", { reason });
      try {
        await rooms.deleteRoom(roomName);
      } catch (e) {
        log("deleteRoom failed", { error: String(e) });
      }
    };

    const agent = new FeatherAgent({
      client,
      conversationId,
      openingText: meta.opening_text ?? "Hello, this is a call from Feather-Lite Collections.",
      onEndCall: async (reason) => {
        await hangup(reason);
      },
      log,
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: STT_MODEL, language: "en" }),
      llm: new RemoteOrchestratorLLM(),
      tts: new inference.TTS({ model: TTS_MODEL, voice: TTS_VOICE }),
      vad: ctx.proc.userData.vad as silero.VAD,
      turnHandling: {
        turnDetection: new livekitPlugin.turnDetector.MultilingualModel(),
        endpointing: { minDelay: 500, maxDelay: 3000 },
        interruption: { enabled: true, mode: "adaptive", falseInterruptionTimeout: 2000, resumeFalseInterruption: true, discardAudioIfUninterruptible: false },
        preemptiveGeneration: { enabled: false }, // one control-plane turn per confirmed user turn
      },
      userAwayTimeout: 12,
      aecWarmupDuration: 3000,
    });

    // Runtime truth back to the ledger.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === "message" && item.role === "assistant") void agent.reportPlayout(item);
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "away") void agent.onSilence();
    });
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      if (m["type"] === "tts_metrics" || m["type"] === "eou_metrics") {
        log("metrics", { type: m["type"], ttfbMs: m["ttfbMs"], eouDelayMs: m["endOfUtteranceDelayMs"], transcriptionDelayMs: m["transcriptionDelayMs"] });
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => log("session error", { error: String(ev.error) }));
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      log("session closed", { reason: String(ev.reason) });
      if (!agent.ended && !ended) {
        // Participant left / transport closed before a disposition: tell the ledger.
        void client.signal(conversationId, { kind: "hangup", reason: String(ev.reason) }).catch(() => undefined).then(() => hangup("session_closed"));
      }
    });

    await session.start({ agent, room: ctx.room });

    if (mode === "sip") {
      const to = meta.contact_point_value;
      if (!SIP_OUTBOUND_TRUNK_ID || !to) {
        log("sip mode requested but LIVEKIT_SIP_OUTBOUND_TRUNK_ID or contact number missing; closing");
        await client.signal(conversationId, { kind: "hangup", reason: "sip_not_configured" }).catch(() => undefined);
        await hangup("sip_not_configured");
        return;
      }
      const sip = new SipClient(lk.url, lk.key, lk.secret);
      const identity = "borrower-phone";
      try {
        await sip.createSipParticipant(SIP_OUTBOUND_TRUNK_ID, to, roomName, { participantIdentity: identity, waitUntilAnswered: true, ringingTimeout: 30 });
      } catch (e) {
        log("dial failed / unanswered", { error: String(e) });
        await client.signal(conversationId, { kind: "no_answer" }).catch(() => undefined);
        await hangup("no_answer");
        return;
      }
      await ctx.waitForParticipant(identity);
      // AMD before ANY speech (plan rev.2 R9): never recite Mini-Miranda into a voicemail.
      const detector = new voice.AMD(session, { participantIdentity: identity });
      const result = await detector.execute();
      log("amd", { category: result.category });
      const amd = result.category === voice.AMDCategory.HUMAN ? "HUMAN" : result.category === voice.AMDCategory.UNCERTAIN ? "UNCERTAIN" : "MACHINE";
      const r = await client.signal(conversationId, { kind: "amd_result", result: amd });
      if (amd === "MACHINE") {
        const h = session.say(r.agent_text, { allowInterruptions: false });
        await h.waitForPlayout();
        await hangup("voicemail_left");
        return;
      }
    } else {
      await ctx.waitForParticipant();
    }
    await agent.speakOpening();
    log("listening");
  },
});

// Liveness for the console.
setInterval(() => void client.heartbeat(AGENT_NAME, { pid: process.pid, mode: "worker" }), 10_000).unref();
void client.heartbeat(AGENT_NAME, { pid: process.pid, mode: "worker", started: true });

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    numIdleProcesses: 1,
    initializeProcessTimeout: 60_000,
  }),
);
