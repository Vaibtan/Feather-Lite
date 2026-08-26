/**
 * Tier-2 voice load test: N concurrent scripted calls through the media plane, each asserted for
 * SPEC §10.5 equivalence against the simulation scenario.
 *
 * This tier is deliberately modest (single-digit N). Real audio costs provider credits and laptop
 * CPU (silero VAD + Opus encode per call); the claim under test is "the media plane and the worker
 * handle N simultaneous calls *correctly*", not raw scale. Tier 1 (`apps/load-test`) is where the
 * hundreds-of-conversations number lives.
 *
 * Each call needs its own borrower — one live conversation per borrower is a pre-call rule — so the
 * fleet mints throwaway fixtures via POST /api/demo/load-fixtures. Borrower lines are synthesised
 * once and replayed from the WAV cache, so a 10-call run does not pay TTS for 30 utterances.
 *
 * Run: pnpm --filter @feather-lite/voice-worker fake-borrower-fleet -- --calls 5
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { checkEquivalence, loadScenarioReference, type EquivalenceResult } from "./equivalence.js";
import { buildHarnessScores, postHarnessScores, summariseWer } from "./harness-scores.js";
import { loadScriptedLines, runScriptedCall, type ScriptedCallResult } from "./scripted-call.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};

const CALLS = Number(flag("calls", "5"));
/**
 * STT regression gate (D4). A provider or model change that degrades transcription is otherwise
 * invisible: the call still completes, the ledger still replays, and equivalence still passes,
 * because the scripted borrower's words survive a surprising amount of mangling.
 *
 * 0.20, set from measurement rather than taste. Two of the three scripted lines transcribe at
 * 0.000. The third is the barge-in, where the borrower deliberately talks over the agent and the
 * STT loses a word to the overlap ("wait", 1 deletion of 9 reference words = 0.111). That loss is
 * structural to the script rather than a provider defect, so the gate has to clear it: the spec's
 * provisional 0.15 leaves almost no room above it, and a single extra clipped word on one line
 * would fail an otherwise healthy run. 0.20 leaves ~80% headroom over the measured structural
 * worst while still failing a run whose transcription genuinely degrades.
 */
const MAX_WER = Number(flag("max-wer", "0.20"));
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const REPORT_DIR = fileURLToPath(new URL("../../../../docs/loadtest/", import.meta.url));

const t0 = Date.now();
const log = (m: string) => console.log(`[fleet] +${String(Date.now() - t0).padStart(6)}ms ${m}`);
const authHeaders = (): Record<string, string> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  return { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
};

log(`calls=${CALLS} max-wer=${MAX_WER} livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"} stt/tts=${process.env["STT_TTS_PROVIDER"] ?? "inference"}`);

const lines = await loadScriptedLines();
log(`borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"}): ${lines.describe}`);

const fixturesRes = await fetch(`${CONTROL_PLANE_URL}/api/demo/load-fixtures`, {
  method: "POST",
  headers: authHeaders(),
  body: JSON.stringify({ count: CALLS, prefix: `voice-${Date.now().toString(36)}` }),
});
if (!fixturesRes.ok) throw new Error(`load-fixtures ${fixturesRes.status}: ${await fixturesRes.text()}`);
const fixtures = (await fixturesRes.json()) as Array<{ borrower_id: string; name: string; timezone: string }>;
log(`minted ${fixtures.length} fixture borrowers (tz=${fixtures[0]?.timezone ?? "?"})`);

log("running the reference simulation scenario...");
const reference = await loadScenarioReference(CONTROL_PLANE_URL);
log(`reference: states=${JSON.stringify(reference.statePath)} tools=${JSON.stringify(reference.tools)} outcome=${String(reference.finalOutcome)}`);

log(`starting ${CALLS} concurrent calls...`);
const results = await Promise.all(
  fixtures.map((f, i) =>
    runScriptedCall({
      lines,
      controlPlaneUrl: CONTROL_PLANE_URL,
      borrowerName: f.name,
      participantIdentity: `borrower-fleet-${i}`,
      label: `call${String(i).padStart(2, "0")}`,
    }),
  ),
);

const equivalences: Array<{ call: ScriptedCallResult; eq: EquivalenceResult | null; eqError: string | null }> = [];
for (const call of results) {
  if (!call.conversationId) {
    equivalences.push({ call, eq: null, eqError: "no conversation id" });
    continue;
  }
  try {
    equivalences.push({ call, eq: await checkEquivalence(CONTROL_PLANE_URL, call.conversationId, reference), eqError: null });
  } catch (e) {
    equivalences.push({ call, eq: null, eqError: String(e) });
  }
}

const green = equivalences.filter((r) => r.eq?.equivalent === true).length;
const hungUp = results.filter((r) => r.hungUp).length;
const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const pct = (p: number) => percentile(durations, p);

// Per-turn response latency across every call in the fleet. This — not call durationMs, which is
// dominated by the scripted sleeps — is the number a latency A/B compares.
const turnMs = results.flatMap((r) => r.turnLatencies.map((t) => t.ms)).sort((a, b) => a - b);
const turnPct = (p: number) => percentile(turnMs, p);
const unanswered = results.reduce((n, r) => n + r.unansweredTurns.length, 0);

// Every borrower line across the fleet, so the gate is over the whole run rather than per call.
const werValues = results
  .flatMap((r) => r.werLines.map((l) => l.wer))
  .filter((v): v is number => v !== null)
  .sort((a, b) => a - b);
const werPct = (p: number) => (werValues.length === 0 ? null : percentile(werValues, p));
const worstLine = results.flatMap((r) => r.werLines).reduce<{ turn: string; wer: number; reference: string; hypothesis: string } | null>(
  (worst, l) => (l.wer !== null && (worst === null || l.wer > worst.wer) ? { turn: l.turn, wer: l.wer, reference: l.reference, hypothesis: l.hypothesis } : worst),
  null,
);
const unmatched = results.reduce((n, r) => n + r.unmatchedTranscripts.length, 0);
const werP95 = werPct(95);
const werBreached = werP95 !== null && werP95 > MAX_WER;

console.log("");
console.log(`  calls                 ${CALLS}`);
console.log(`  agent hung up         ${hungUp}/${CALLS}`);
console.log(`  equivalence green     ${green}/${CALLS}`);
console.log(`  call duration p50/p95 ${pct(50)}ms / ${pct(95)}ms`);
console.log(`  turn latency  n       ${turnMs.length} (${unanswered} unanswered)`);
console.log(`  turn latency p50/p95  ${turnPct(50)}ms / ${turnPct(95)}ms`);
console.log(`  stt wer  n            ${werValues.length}${unmatched > 0 ? `  (${unmatched} unmatched transcript(s) — pairing may be off)` : ""}`);
console.log(`  stt wer  p50/p95      ${werPct(50) === null ? "n/a" : werPct(50)!.toFixed(3)} / ${werP95 === null ? "n/a" : werP95.toFixed(3)}   (gate ${MAX_WER}${werBreached ? " — BREACHED" : ""})`);
if (worstLine && worstLine.wer > 0) {
  console.log(`  stt wer  worst line   ${worstLine.wer.toFixed(3)} (${worstLine.turn})`);
  console.log(`      ref: ${JSON.stringify(worstLine.reference)}`);
  console.log(`      stt: ${JSON.stringify(worstLine.hypothesis)}`);
}
console.log("");
for (const { call, eq, eqError } of equivalences) {
  const verdict = eq?.equivalent ? "EQUIVALENT" : "MISMATCH";
  console.log(`  ${call.label} ${verdict} hungUp=${call.hungUp} frames=${call.agentAudioFrames} ${call.durationMs}ms ${call.error ?? ""}`);
  for (const f of eq?.failures ?? []) console.log(`      - ${f}`);
  if (eqError) console.log(`      - equivalence check failed: ${eqError}`);
}

const report = {
  tier: "2-voice",
  livekit_url: process.env["LIVEKIT_URL"] ?? null,
  stt_tts_provider: process.env["STT_TTS_PROVIDER"] ?? "inference",
  speech: lines.describe,
  calls: CALLS,
  agent_hung_up: hungUp,
  equivalence_green: green,
  duration_ms: { p50: pct(50), p95: pct(95), max: durations.at(-1) ?? 0 },
  turn_latency_ms: { n: turnMs.length, unanswered, p50: turnPct(50), p95: turnPct(95), max: turnMs.at(-1) ?? 0 },
  stt_wer: { n: werValues.length, unmatched_transcripts: unmatched, p50: werPct(50), p95: werP95, max: werValues.at(-1) ?? null, gate: MAX_WER, breached: werBreached, worst_line: worstLine },
  reference: { scenario_id: reference.scenarioId, state_path: reference.statePath, tools: reference.tools, final_outcome: reference.finalOutcome },
  results: equivalences.map(({ call, eq, eqError }) => ({
    label: call.label,
    conversation_id: call.conversationId,
    hung_up: call.hungUp,
    agent_audio_frames: call.agentAudioFrames,
    duration_ms: call.durationMs,
    turn_latencies: call.turnLatencies.map((t) => ({ turn: t.turn, ms: t.ms })),
    wer_lines: call.werLines.map((l) => ({ turn: l.turn, wer: l.wer, substitutions: l.substitutions, insertions: l.insertions, deletions: l.deletions })),
    unanswered_turns: call.unansweredTurns,
    call_error: call.error,
    equivalent: eq?.equivalent ?? false,
    failures: eq?.failures ?? (eqError ? [eqError] : ["no equivalence result"]),
    state_path: eq?.statePath ?? [],
    tools: eq?.tools ?? [],
    final_outcome: eq?.finalOutcome ?? null,
  })),
};
mkdirSync(REPORT_DIR, { recursive: true });
const path = `${REPORT_DIR}${new Date().toISOString().slice(0, 10)}-tier2-n${CALLS}.json`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
log(`report written: ${path}`);

// One score model for harness runs and production calls: the fleet's own measurements land in the
// same table the evaluator and judge write to, per call, and show on the Quality page beside them.
for (const { call, eq } of equivalences) {
  if (!call.conversationId) continue;
  await postHarnessScores(
    CONTROL_PLANE_URL,
    call.conversationId,
    buildHarnessScores({
      equivalent: eq?.equivalent === true,
      equivalenceComment: eq?.equivalent ? `matches scenario ${reference.scenarioId}` : (eq?.failures[0] ?? "no equivalence result"),
      werLines: call.werLines,
      turnLatencies: call.turnLatencies,
    }),
  );
}

// The run fails on either gate. Equivalence is correctness and WER is transcription quality; a run
// that stayed correct only because the words happened to survive is not a pass.
if (werBreached) log(`stt wer p95 ${werP95!.toFixed(3)} exceeds the ${MAX_WER} gate: FAIL`);
process.exit(green === CALLS && !werBreached ? 0 : 1);
