/**
 * Headless voice regression: one automated real call with a speaking fake borrower, then the
 * SPEC §10.5 equivalence assertion against the simulation scenario.
 *
 * Needs a running server (`pnpm dev:server`), worker (`pnpm dev:worker`) and a LiveKit server —
 * Cloud or the self-hosted container (`pnpm lk:up`). The call logic lives in `scripted-call.ts`;
 * `fake-borrower-fleet.ts` runs N of them concurrently.
 *
 * Run: pnpm --filter @feather-lite/voice-worker fake-borrower
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { checkEquivalence, loadScenarioReference } from "./equivalence.js";
import { loadScriptedLines, runScriptedCall } from "./scripted-call.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

const t0 = Date.now();
const log = (m: string) => console.log(`[borrower] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const BORROWER_NAME = process.env["TRACER_BORROWER"] ?? "Jordan Avery";

log(`livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"} stt/tts=${process.env["STT_TTS_PROVIDER"] ?? "inference"}`);
log("loading borrower lines...");
const lines = await loadScriptedLines();
log(`lines ready (${lines.cached ? "from WAV cache" : "synthesised"}): ${lines.describe}`);

const result = await runScriptedCall({
  lines,
  controlPlaneUrl: CONTROL_PLANE_URL,
  borrowerName: BORROWER_NAME,
  participantIdentity: "borrower-headless",
  label: "borrower",
  log,
});

log(`call finished in ${result.durationMs}ms; agent audio frames=${result.agentAudioFrames}; agent final segments=${result.agentSegments.length}`);
if (result.error) log(`call error: ${result.error}`);

// Composite response latency (borrower falls silent -> agent starts replying), per scripted turn.
// This is the baseline the turn-detector and STT swaps are measured against.
for (const t of result.turnLatencies) log(`response latency  ${t.turn}: ${t.ms}ms`);
for (const t of result.unansweredTurns) log(`response latency  ${t}: UNANSWERED (not measured)`);
if (result.turnLatencies.length === 0) {
  log("response latency: no turns measured");
} else {
  const ms = result.turnLatencies.map((t) => t.ms);
  const mean = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  log(`response latency  turns=${ms.length} unanswered=${result.unansweredTurns.length} mean=${mean}ms min=${Math.min(...ms)}ms max=${Math.max(...ms)}ms`);
}

if (!result.hungUp) {
  log("agent did not hang up: FAIL");
  process.exit(1);
}
if (!result.conversationId) {
  log("no conversation id (TRACER_RAW mode): skipping the equivalence check, call path PASS");
  process.exit(0);
}

log("running the reference simulation scenario...");
const reference = await loadScenarioReference(CONTROL_PLANE_URL);
const eq = await checkEquivalence(CONTROL_PLANE_URL, result.conversationId, reference);
log(`voice   states=${JSON.stringify(eq.statePath)} tools=${JSON.stringify(eq.tools)} outcome=${String(eq.finalOutcome)}`);
log(`sim     states=${JSON.stringify(reference.statePath)} tools=${JSON.stringify(reference.tools)} outcome=${String(reference.finalOutcome)}`);
if (!eq.equivalent) {
  for (const f of eq.failures) log(`  MISMATCH: ${f}`);
  log("voice/sim equivalence: FAIL");
  process.exit(1);
}
log("voice/sim equivalence: PASS");
process.exit(0);
