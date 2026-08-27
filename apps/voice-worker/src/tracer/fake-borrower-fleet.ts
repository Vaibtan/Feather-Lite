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
 * Since 2026-08-27 the borrowers run in their own forked process (`--in-proc` to opt out) and the
 * run reports CPU-seconds and peak RSS per process role, so the fleet finally distinguishes what
 * the worker cost from what the harness cost on the same laptop (spec D1, findings W8).
 *
 * Run: pnpm --filter @feather-lite/voice-worker fake-borrower-fleet -- --calls 5
 */
import { fork } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { TurnLatencyRow } from "@feather-lite/contracts";
import { ttsAggregate } from "@feather-lite/domain";
import { formatResourceReport, perCoreBudget, startResourceSampler, validateReport, WORKER_ROLES, type Role } from "@feather-lite/load-test/resources";
import { checkEquivalence, loadScenarioReference, type EquivalenceResult } from "./equivalence.js";
import { buildHarnessScores, postHarnessScores, summariseWer } from "./harness-scores.js";
import type { ScriptedCallResult } from "./scripted-call.js";
import type { BorrowerProcMessage, BorrowerProcRequest } from "./borrower-proc.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

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
/**
 * Borrowers run in a forked child by default (W8). `--in-proc` keeps the old single-process shape
 * for a quick one-off; every committed measurement uses the forked one, because a run that reports
 * the worker's latency while N Opus encoders share its event loop is measuring the harness.
 */
const IN_PROC = process.argv.includes("--in-proc");
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const REPORT_DIR = fileURLToPath(new URL("../../../../docs/loadtest/", import.meta.url));

const t0 = Date.now();
const log = (m: string) => console.log(`[fleet] +${String(Date.now() - t0).padStart(6)}ms ${m}`);
const authHeaders = (): Record<string, string> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  return { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
};

log(`calls=${CALLS} max-wer=${MAX_WER} borrowers=${IN_PROC ? "in-process" : "forked child"} livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"} stt/tts=${process.env["STT_TTS_PROVIDER"] ?? "inference"}`);

/**
 * Started first so its opening tick is the idle worker tree: that reading is the `idle_rss_tree`
 * term of `mb_per_call`, and it is only idle before the first room is created.
 */
const roleOverrides = new Map<number, Role>([[process.pid, "harness"]]);
const sampler = startResourceSampler({ roleOverrides });
await sampler.awaitFirstSample();

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

const callSpecs = fixtures.map((f, i) => ({ borrowerName: f.name, participantIdentity: `borrower-fleet-${i}`, label: `call${String(i).padStart(2, "0")}` }));

/** Run the fleet in a forked child so its CPU is attributable, or in this process on `--in-proc`. */
const runBorrowers = async (): Promise<{ results: ScriptedCallResult[]; speech: string; dispose: () => void }> => {
  if (IN_PROC) {
    // Imported here, not at the top: with the borrowers in a child this process never touches the
    // media stack, and a harness that loads `@livekit/agents` and `rtc-node` to measure a worker is
    // adding hundreds of megabytes to the box it is measuring.
    const { initializeLogger } = await import("@livekit/agents");
    initializeLogger({ pretty: true, level: "warn" });
    const { loadScriptedLines, runScriptedCall } = await import("./scripted-call.js");
    const lines = await loadScriptedLines();
    log(`borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"}): ${lines.describe}`);
    log(`starting ${CALLS} concurrent calls in this process...`);
    const results = await Promise.all(callSpecs.map((c) => runScriptedCall({ lines, controlPlaneUrl: CONTROL_PLANE_URL, ...c })));
    return { results, speech: lines.describe, dispose: () => undefined };
  }
  // The tracer harnesses run under `tsx`, so the child is the `.ts` source; the `.js` sibling is
  // what a bundled build would leave. Pick whichever exists rather than assuming the toolchain.
  const tsPath = fileURLToPath(new URL("./borrower-proc.ts", import.meta.url));
  const childPath = existsSync(tsPath) ? tsPath : fileURLToPath(new URL("./borrower-proc.js", import.meta.url));
  const child = fork(childPath, [], { execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  roleOverrides.set(child.pid ?? -1, "harness-borrower");
  log(`borrower process forked (pid ${String(child.pid)}); starting ${CALLS} concurrent calls...`);
  let speech = "(not reported)";
  return await new Promise((resolve, reject) => {
    const request: BorrowerProcRequest = { controlPlaneUrl: CONTROL_PLANE_URL, calls: callSpecs };
    child.on("message", (m: BorrowerProcMessage) => {
      if (m.kind === "ready") child.send(request);
      else if (m.kind === "log") {
        if (m.line.startsWith("borrower lines ready")) speech = m.line.slice(m.line.indexOf("): ") + 3);
        log(m.line);
      } else if (m.kind === "results") {
        // Left alive until the sampler has stopped: killing it here would drop up to a second of
        // its CPU from the report, which is the one number this whole change exists to produce.
        resolve({ results: [...m.results], speech, dispose: () => child.kill() });
      } else reject(new Error(`borrower process failed: ${m.error}`));
    });
    // A child that dies without answering must fail the run loudly; a fleet that silently reported
    // zero calls would read as "nothing went wrong".
    child.on("exit", (code, signal) => {
      if (signal === null && code !== 0) reject(new Error(`borrower process exited ${String(code)} before reporting results`));
    });
    child.on("error", reject);
  });
};

sampler.mark();
const { results, speech: speechDescribe, dispose: disposeBorrowers } = await runBorrowers();
// Stopped the moment the calls end. The equivalence sweep and the ledger reads that follow are the
// harness's own work; leaving them inside the window would stretch the wall clock the per-core
// budget divides by and flatter every figure derived from it.
const resources = await sampler.stop();
disposeBorrowers();
const callMinutes = results.reduce((a, r) => a + r.durationMs, 0) / 60_000;
const budget = perCoreBudget(resources, { roles: WORKER_ROLES, calls: CALLS, callMinutes });

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

/**
 * TTS heuristics over the fleet (D5). Read from the ledger's turn rows rather than measured here:
 * the worker is what knows how much audio it produced for how many characters, and it already
 * reports both on the `turn_metrics` signal. The harness only knows that *some* audio arrived.
 *
 * Scoped to this run's own conversations, not "the last N calls" — the fleet runs a reference
 * simulation scenario of its own before starting, and a window that swept that in would be
 * describing a different set of calls than every other number in this report.
 */
const turnRows: TurnLatencyRow[] = [];
for (const { call } of equivalences) {
  if (!call.conversationId) continue;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${call.conversationId}/latency`, { headers: authHeaders() });
    if (res.ok) turnRows.push(...((await res.json()) as TurnLatencyRow[]));
    else log(`latency fetch for ${call.label} failed: ${res.status}`);
  } catch (e) {
    log(`latency fetch for ${call.label} failed: ${String(e)}`);
  }
}
const tts = ttsAggregate(turnRows.map((r) => ({ turnId: r.turn_id, audioMs: r.tts_audio_ms, chars: r.tts_chars, silent: r.tts_silent, ttfbMs: r.tts_ttfb_ms })));

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
// Labelled "heuristic" on the line itself, not only in the docs: this is an outlier flag, not a
// measure of how the speech sounded, and the console is the wrong place to learn that distinction.
console.log(`  tts silent playouts   ${tts.silentPlayouts}/${tts.turns}${tts.silentPlayoutRate === null ? "" : `  (${(tts.silentPlayoutRate * 100).toFixed(1)}%)`}`);
console.log(`  tts ttfb p50/p95      ${tts.ttfbMs.p50 ?? "n/a"}ms / ${tts.ttfbMs.p95 ?? "n/a"}ms   over ${tts.ttfbMs.n} turn(s)`);
console.log(
  `  tts chars/s (heur.)   median ${tts.charsPerSecond.median === null ? "n/a" : tts.charsPerSecond.median.toFixed(1)}` +
    ` over ${tts.charsPerSecond.n} turn(s), ${tts.outliers.length} beyond ±${(tts.outlierBand * 100).toFixed(0)}%`,
);
for (const o of tts.outliers.slice(0, 3)) {
  console.log(`      outlier ${o.turnId} ${o.charsPerSecond.toFixed(1)} chars/s (${o.deviation > 0 ? "+" : ""}${(o.deviation * 100).toFixed(0)}%)`);
}
console.log("");
console.log(formatResourceReport(resources, budget));
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
  speech: speechDescribe,
  calls: CALLS,
  agent_hung_up: hungUp,
  equivalence_green: green,
  duration_ms: { p50: pct(50), p95: pct(95), max: durations.at(-1) ?? 0 },
  turn_latency_ms: { n: turnMs.length, unanswered, p50: turnPct(50), p95: turnPct(95), max: turnMs.at(-1) ?? 0 },
  stt_wer: { n: werValues.length, unmatched_transcripts: unmatched, p50: werPct(50), p95: werP95, max: werValues.at(-1) ?? null, gate: MAX_WER, breached: werBreached, worst_line: worstLine },
  /**
   * Heuristics, not a quality score, and not gated: a chars-per-second outlier is a turn worth
   * listening to, not a failure. Silent playouts are a real defect but already fail the run through
   * equivalence — a read-back nobody heard cannot record a promise (ADR 0008).
   */
  tts_heuristics: {
    turns: tts.turns,
    silent_playouts: tts.silentPlayouts,
    silent_playout_rate: tts.silentPlayoutRate,
    chars_per_second: tts.charsPerSecond,
    ttfb_ms: tts.ttfbMs,
    outlier_band: tts.outlierBand,
    baseline_readings: tts.baselineReadings,
    outliers: tts.outliers,
  },
  borrowers: IN_PROC ? "in-process" : "forked-child",
  resources,
  per_core: budget,
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
// A report without its resources block looks like a measurement and is not; the next phase would
// cite it. Fail the run rather than write one.
const reportProblems = validateReport(report);
if (reportProblems.length > 0) throw new Error(`report is not a valid measurement: ${reportProblems.join("; ")}`);
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
