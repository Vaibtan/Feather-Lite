/**
 * Phase 1.5 tracer bullet — proves the D2 design on the real framework:
 *
 *  1. `llmNode()` override streams text from a (fake) control plane          -> generated reply
 *  2. `say` frames become separate non-interruptible speech handles           -> read-backs / confirmations
 *  3. Non-interruptible opening (Mini-Miranda) from `onEnter()`
 *  4. Barge-in truncation is observable via `conversation_item_added` (interrupted assistant item)
 *  5. `userAwayTimeout` -> `user_state_changed: away`
 *  6. `preemptiveGeneration` disabled so `llmNode` runs once per confirmed turn
 *  7. LiveKit Inference STT/TTS on the Build plan; silero VAD; multilingual turn detector
 *
 * Run:  pnpm --filter @feather-lite/voice-worker download-files   (once)
 *       pnpm --filter @feather-lite/voice-worker tracer            (worker, dev mode)
 *       pnpm --filter @feather-lite/voice-worker tracer:token      (token server + test page)
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from "@livekit/agents";
import * as livekitPlugin from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import { RemoteOrchestratorLLM } from "./remote-orchestrator-llm.js";
import { TracerAgent } from "./tracer-agent.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const AGENT_NAME = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-tracer";

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    console.log(`[tracer] job for room=${ctx.room.name} metadata=${ctx.room.metadata ?? ""}`);

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: "deepgram/nova-3", language: "en" }),
      // Placeholder LLM: our Agent overrides llmNode; RemoteOrchestratorLLM.chat() throws if ever reached.
      llm: new RemoteOrchestratorLLM(),
      tts: new inference.TTS({ model: "cartesia/sonic-3", voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc" }),
      vad: ctx.proc.userData.vad as silero.VAD,
      turnHandling: {
        turnDetection: new livekitPlugin.turnDetector.MultilingualModel(),
        endpointing: { minDelay: 500, maxDelay: 3000 },
        interruption: {
          enabled: true,
          mode: "adaptive",
          falseInterruptionTimeout: 2000,
          resumeFalseInterruption: true,
          // PRD §5.2.1: speech during non-interruptible segments is buffered, not dropped.
          discardAudioIfUninterruptible: false,
        },
        preemptiveGeneration: { enabled: false }, // plan rev.2 R2
      },
      userAwayTimeout: 12,
      aecWarmupDuration: 3000,
    });

    // Observability of the things D2 depends on.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === "message") {
        console.log(
          `[tracer] item_added role=${item.role} interrupted=${item.interrupted} text=${JSON.stringify(item.textContent?.slice(0, 80))}`,
        );
      }
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) =>
      console.log(`[tracer] user_state ${ev.oldState} -> ${ev.newState}`),
    );
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) =>
      console.log(`[tracer] agent_state ${ev.oldState} -> ${ev.newState}`),
    );
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, () =>
      console.log("[tracer] agent_false_interruption (resumed)"),
    );
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) =>
      console.log(`[tracer] speech_created source=${ev.source} userInitiated=${ev.userInitiated}`),
    );
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      const pick = (keys: string[]) => keys.filter((k) => m[k] !== undefined).map((k) => `${k}=${String(m[k])}`).join(" ");
      console.log(`[tracer] metrics ${String(m["type"])} ${pick(["ttfb", "duration", "audioDuration", "endOfUtteranceDelay", "transcriptionDelay", "onUserTurnCompletedDelay", "charactersCount", "cancelled"])} keys=${Object.keys(m).join(",")}`);
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => console.error("[tracer] session error", ev.error));
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.log("[tracer] session closed", ev.reason);
      // Hang up: deleting the room disconnects every participant (browser or SIP) and ends the job.
      void ctx.deleteRoom().catch((err) => console.warn("[tracer] deleteRoom failed", err));
    });

    await session.start({ agent: new TracerAgent(), room: ctx.room });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    // Job processes are spawned per call; tsx + local inference models make cold init slow on Windows.
    numIdleProcesses: 1,
    initializeProcessTimeout: 60_000,
  }),
);
