/** Run: pnpm --filter @feather-lite/voice-worker fake-borrower-fleet -- --calls 5 */
import { fork } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { TurnLatencyRow } from "@feather-lite/contracts";
import { percentile, ttsAggregate } from "@feather-lite/domain";
import { formatResourceReport, perCoreBudget, startResourceSampler, validateReport, WORKER_CONTAINERS, WORKER_ROLES, type Role } from "@feather-lite/load-test/resources";
import { checkEquivalence, loadScenarioReference, type EquivalenceResult } from "./equivalence.js";
import { buildHarnessScores, postHarnessScores, summariseEntities, summariseWer } from "./harness-scores.js";
import type { ScriptedCallResult } from "./scripted-call.js";
import type { BorrowerProcMessage, BorrowerProcRequest } from "./borrower-proc.js";
import { harnessJsonHeaders } from "@feather-lite/load-test/harness-http";
import { parseFleetArgs, reportFileName } from "./fleet-args.js";
import { speechWindows, turnTakingMetrics, withPlayoutTruth } from "@feather-lite/domain";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const PARSED = parseFleetArgs(process.argv);
if (!PARSED.ok) {
  process.stderr.write(`${PARSED.message}
`);
  process.exit(2);
}
const ARGS = PARSED.ok ? PARSED.args : null!;

const CALLS = ARGS.calls;
/**
 * 0.20, from measurement: two of the three scripted lines transcribe at 0.000, and the third is
 * the barge-in, where the overlap costs the STT a word (0.111). That loss is structural to the
 * script, so the gate has to clear it with room above.
 */
const MAX_WER = ARGS.maxWer;
/** Every committed measurement uses the forked borrowers; `--in-proc` is for a one-off. */
const IN_PROC = ARGS.inProc;
/**
 * A dev-mode run is a refusal rather than a footnote. What it costs here is `tsx` instead of the
 * bundle and the framework's development defaults — not load shedding, which is `--simulation`.
 */
const ALLOW_DEV = ARGS.allowDev;
const ALLOW_NO_SHEDDING = ARGS.allowNoShedding;
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const REPORT_DIR = fileURLToPath(new URL("../../../../docs/loadtest/", import.meta.url));

const t0 = Date.now();
const log = (m: string) => console.log(`[fleet] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

log(`calls=${CALLS} max-wer=${MAX_WER} borrowers=${IN_PROC ? "in-process" : "forked child"} livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"} stt/tts=${process.env["STT_TTS_PROVIDER"] ?? "inference"}`);

/** Started first, so its opening tick is the idle worker tree that `mb_per_call` subtracts. */
const roleOverrides = new Map<number, Role>([[process.pid, "harness"]]);
const sampler = startResourceSampler({ roleOverrides });
await sampler.awaitFirstSample();

interface WorkerMode {
  /** Null when no online worker is reporting at all — a different fact from "dev mode". */
  readonly production: boolean | null;
  readonly simulation: boolean;
  /** `loadThreshold` resolved to `Infinity`, so the worker can never report itself busy. */
  readonly sheddingDisabled: boolean;
  readonly maxJobs: number | null;
  readonly idleProcesses: number | null;
  readonly idleConfigured: number | null;
}
const workerMode = await (async (): Promise<WorkerMode> => {
  const res = await fetch(`${CONTROL_PLANE_URL}/api/system/status`, { headers: harnessJsonHeaders() });
  if (!res.ok) throw new Error(`status ${String(res.status)}: ${await res.text()}`);
  const status = (await res.json()) as { agents: Array<{ agent_name: string; online: boolean; meta: Record<string, unknown> }> };
  // The main worker, not a job process: only the main one reports `production`.
  const main = status.agents.filter((a) => a.online).map((a) => a.meta).find((m) => typeof m["production"] === "boolean");
  const num = (k: string): number | null => (main !== undefined && typeof main[k] === "number" ? (main[k] as number) : null);
  return {
    production: main === undefined ? null : (main["production"] as boolean),
    simulation: main?.["simulation"] === true,
    sheddingDisabled: main?.["load_shedding_disabled"] === true,
    maxJobs: num("max_jobs"),
    idleProcesses: num("idle_processes"),
    idleConfigured: num("idle_processes_configured"),
  };
})();
log(`worker: production=${String(workerMode.production)} simulation=${String(workerMode.simulation)} max_jobs=${String(workerMode.maxJobs)} idle_processes=${String(workerMode.idleProcesses)}/${String(workerMode.idleConfigured)}`);
if (workerMode.production !== true && !ALLOW_DEV) {
  console.error(
    workerMode.production === null
      ? "[fleet] no online worker is reporting its mode. Start it with `pnpm start:worker` (production), or pass --allow-dev to measure anyway."
      : "[fleet] the worker is in dev mode: `tsx` rather than the bundle, debug logging, and the framework's development defaults. Every number from this run would be unattributable. Use `pnpm start:worker`, or pass --allow-dev deliberately.",
  );
  process.exit(1);
}
/**
 * Separate from the dev-mode gate: `start --simulation` is `production: true` and would pass that
 * one, and it is the mode in which `ServerOptions` forces `loadThreshold` to `Infinity`.
 */
if (workerMode.sheddingDisabled && !ALLOW_NO_SHEDDING) {
  console.error("[fleet] the worker is running under --simulation, where loadThreshold is Infinity and it can never ask the SFU to prefer somebody else. Restart it without --simulation, or pass --allow-no-shedding deliberately.");
  process.exit(1);
}
if (workerMode.idleProcesses !== null && workerMode.idleConfigured !== null && workerMode.idleProcesses < workerMode.idleConfigured) {
  // A short pool means the first calls pay a ~1.8 s cold start inside the call.
  log(`warning: the warm pool is ${String(workerMode.idleProcesses)} of a configured ${String(workerMode.idleConfigured)}; the first calls will pay a cold start.`);
}
if (workerMode.maxJobs !== null && CALLS > Math.floor(workerMode.maxJobs * 0.75)) {
  /**
   * A refusal, not a warning: a run configured past the ceiling by accident has its surplus refused
   * and its report then reads as a quality failure rather than a capacity one.
   */
  const admitted = Math.floor(workerMode.maxJobs * 0.75);
  const detail =
    `${String(CALLS)} calls exceeds the worker's admitted concurrency (~${String(admitted)} at max_jobs=${String(workerMode.maxJobs)}): ` +
    `the surplus is refused, finalizes NEVER_SERVED with no transcript, and scores WER 1.000 — so the run reads as a quality failure rather than a capacity one.`;
  if (!ARGS.allowShed) {
    console.error(`[fleet] refusing to start: ${detail}`);
    console.error(`[fleet] raise WORKER_MAX_JOBS to ${String(Math.ceil(CALLS / 0.75))} to carry ${String(CALLS)} calls, or pass --allow-shed to measure the shedding point on purpose.`);
    process.exit(1);
  }
  log(`warning (--allow-shed): ${detail}`);
}

const fixturesRes = await fetch(`${CONTROL_PLANE_URL}/api/demo/load-fixtures`, {
  method: "POST",
  headers: harnessJsonHeaders(),
  body: JSON.stringify({ count: CALLS, prefix: `voice-${Date.now().toString(36)}` }),
});
if (!fixturesRes.ok) throw new Error(`load-fixtures ${fixturesRes.status}: ${await fixturesRes.text()}`);
const fixtures = (await fixturesRes.json()) as Array<{ borrower_id: string; name: string; timezone: string }>;
log(`minted ${fixtures.length} fixture borrowers (tz=${fixtures[0]?.timezone ?? "?"})`);

log("running the reference simulation scenario...");
const reference = await loadScenarioReference(CONTROL_PLANE_URL);
log(`reference: states=${JSON.stringify(reference.statePath)} tools=${JSON.stringify(reference.tools)} outcome=${String(reference.finalOutcome)}`);

const callSpecs = fixtures.map((f, i) => ({ borrowerName: f.name, participantIdentity: `borrower-fleet-${i}`, label: `call${String(i).padStart(2, "0")}` }));

const runBorrowers = async (): Promise<{ results: ScriptedCallResult[]; speech: string; dispose: () => void }> => {
  if (IN_PROC) {
    // Imported here, not at the top: with the borrowers in a child this process never touches the
    // media stack, and loading it would add hundreds of megabytes to the box being measured.
    const { initializeLogger } = await import("@livekit/agents");
    initializeLogger({ pretty: true, level: "warn" });
    const { loadScriptedLines, runScriptedCall } = await import("./scripted-call.js");
    const lines = await loadScriptedLines();
    log(`borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"}): ${lines.describe}`);
    log(`starting ${CALLS} concurrent calls in this process...`);
    const results = await Promise.all(callSpecs.map((c) => runScriptedCall({ lines, controlPlaneUrl: CONTROL_PLANE_URL, ...c })));
    return { results, speech: lines.describe, dispose: () => undefined };
  }
  // The harnesses run under `tsx`, so pick whichever of the two entry points exists.
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
        // Left alive until the sampler has stopped, or its last second of CPU is lost.
        resolve({ results: [...m.results], speech, dispose: () => child.kill() });
      } else reject(new Error(`borrower process failed: ${m.error}`));
    });
    // A child that dies without answering must fail the run loudly.
    child.on("exit", (code, signal) => {
      if (signal === null && code !== 0) reject(new Error(`borrower process exited ${String(code)} before reporting results`));
    });
    child.on("error", reject);
  });
};

sampler.mark();
const { results, speech: speechDescribe, dispose: disposeBorrowers } = await runBorrowers();
// Stopped the moment the calls end: the equivalence sweep that follows is the harness's own work,
// and leaving it in would stretch the wall clock every per-core figure divides by.
const resources = await sampler.stop();
disposeBorrowers();
const callMinutes = results.reduce((a, r) => a + r.durationMs, 0) / 60_000;
// `containers` is the fallback for a `--profile app` run, where the worker is not a host process.
const budget = perCoreBudget(resources, { roles: WORKER_ROLES, containers: WORKER_CONTAINERS, calls: CALLS, callMinutes });

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
// The domain's nearest-rank rule rather than a fourth local copy of it.
const pct = (p: number) => percentile(durations, p) ?? 0;

// Per-turn latency, not `durationMs`, which is dominated by the scripted sleeps.
const turnMs = results.flatMap((r) => r.turnLatencies.map((t) => t.ms)).sort((a, b) => a - b);
const turnPct = (p: number) => percentile(turnMs, p) ?? 0;
const unanswered = results.reduce((n, r) => n + r.unansweredTurns.length, 0);

/**
 * From the calls a worker actually served: a call the SFU never assigned finalizes `NEVER_SERVED`
 * with no transcript, so its lines score WER 1.000 against a hypothesis nobody produced, turning a
 * capacity failure into a quality one. "Served" is `agentAudioFrames > 0`, and the excluded calls
 * are counted rather than dropped.
 */
const servedResults = results.filter((r) => r.agentAudioFrames > 0);
const neverServedCalls = results.length - servedResults.length;
const werValues = servedResults
  .flatMap((r) => r.werLines.map((l) => l.wer))
  .filter((v): v is number => v !== null)
  .sort((a, b) => a - b);
const werPct = (p: number) => percentile(werValues, p);
const worstLine = servedResults.flatMap((r) => r.werLines).reduce<{ turn: string; wer: number; reference: string; hypothesis: string } | null>(
  (worst, l) => (l.wer !== null && (worst === null || l.wer > worst.wer) ? { turn: l.turn, wer: l.wer, reference: l.reference, hypothesis: l.hypothesis } : worst),
  null,
);
/**
 * VAD-interruption numbers, labelled as such because an A/B has to compare against a baseline that
 * names the mode. `truncated: null` is excluded from every rate and counted, so a thin denominator
 * is visible.
 */
const playoutsByConversation = new Map<string, Array<{ atMs: number; interrupted: boolean }>>();
for (const { call } of equivalences) {
  if (!call.conversationId) continue;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${call.conversationId}`, { headers: harnessJsonHeaders() });
    if (!res.ok) {
      log(`event timeline for ${call.label} failed: ${res.status}`);
      continue;
    }
    const detail = (await res.json()) as { event_timeline: Array<{ type: string; created_at: string; payload: Record<string, unknown> }> };
    playoutsByConversation.set(
      call.conversationId,
      detail.event_timeline
        .filter((e) => e.type === "AGENT_TURN_PLAYOUT")
        .map((e) => ({ atMs: Date.parse(e.created_at), interrupted: e.payload["interrupted"] === true }))
        .filter((p) => Number.isFinite(p.atMs)),
    );
  } catch (e) {
    log(`event timeline for ${call.label} failed: ${String(e)}`);
  }
}

const turnTaking = results.map((r) => {
  const playouts = (r.conversationId ? playoutsByConversation.get(r.conversationId) : undefined) ?? [];
  const agent = withPlayoutTruth(speechWindows(r.rmsSamples), playouts);
  return { label: r.label, metrics: turnTakingMetrics({ borrower: r.borrowerEvents, agent }) };
});

const unmatched = results.reduce((n, r) => n + r.unmatchedTranscripts.length, 0);

/**
 * The live onset detector against the post-hoc one: the same rule at the same threshold, so they
 * must agree, or every turn-taking number describes audio the live one never saw.
 */
const stretchDisagreements = results.flatMap((r) => {
  const postHoc = speechWindows(r.rmsSamples).length;
  return postHoc === r.liveStretchCount ? [] : [{ call: r.label, live: r.liveStretchCount, postHoc }];
});
const werP95 = werPct(95);
const werBreached = werP95 !== null && werP95 > MAX_WER;

/**
 * An amount error is a wrong promise, not a degraded transcript, which is why its budget is zero
 * rather than a rate. The fixtures are minted as "Jordan <prefix>", so the first name is the one
 * name the scripted lines carry.
 */
const entities = summariseEntities(
  servedResults.flatMap((r) => r.werLines.map((l) => ({ reference: l.reference, hypothesis: l.hypothesis }))),
  ["Jordan"],
);
const amountsBreached = entities.amount_errors > ARGS.maxAmountErrors;

/**
 * Read from the ledger rather than measured here: the worker knows how much audio it produced for
 * how many characters. Scoped to this run's conversations, because a reference scenario runs first.
 */
const turnRows: TurnLatencyRow[] = [];
const rowsByConversation = new Map<string, TurnLatencyRow[]>();
for (const { call } of equivalences) {
  if (!call.conversationId) continue;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${call.conversationId}/latency`, { headers: harnessJsonHeaders() });
    if (res.ok) {
      const rows = (await res.json()) as TurnLatencyRow[];
      rowsByConversation.set(call.conversationId, rows);
      turnRows.push(...rows);
    } else {
      log(`latency fetch for ${call.label} failed: ${res.status}`);
    }
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
{
  const med = (pick: (m: (typeof turnTaking)[number]["metrics"]) => number | null): string => {
    const vs = turnTaking.map((t) => pick(t.metrics)).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return vs.length === 0 ? "n/a" : String(percentile(vs, 50) ?? "n/a");
  };
  const unknown = turnTaking.reduce((n, t) => n + t.metrics.counts.unknown_truncation, 0);
  console.log(`  turn-taking (VAD)     response ${med((m) => m.response_rate)}  yield ${med((m) => m.yield_rate)}  yield_ms ${med((m) => m.yield_latency_ms)}`);
  console.log(`                        false_interrupt ${med((m) => m.false_interrupt_rate)}  agent_interrupt ${med((m) => m.agent_interrupt_rate)}  selectivity ${med((m) => m.selectivity)}`);
  console.log(`                        medians over ${String(turnTaking.length)} call(s); ${String(unknown)} agent stretch(es) had no playout behind them and are excluded (H11)`);
  console.log(`                        **VAD-interruption numbers**: adaptive has never run on this profile (W1), so Phase 2's A/B compares against this label.`);
}
if (stretchDisagreements.length > 0) {
  console.log(`  agent stretches       DISAGREE on ${String(stretchDisagreements.length)} call(s): ${stretchDisagreements.map((d) => `${d.call} live=${String(d.live)} post-hoc=${String(d.postHoc)}`).join(", ")}`);
} else {
  const stretches = results.reduce((n, r) => n + r.liveStretchCount, 0);
  console.log(`  agent stretches       ${String(stretches)} over ${String(results.length)} call(s), live and post-hoc agree`);
}
if (neverServedCalls > 0) {
  console.log(`  stt wer  excluded     ${String(neverServedCalls)} call(s) no worker served — no transcript to score, so they are not a transcription result (H4)`);
}
if (worstLine && worstLine.wer > 0) {
  console.log(`  stt wer  worst line   ${worstLine.wer.toFixed(3)} (${worstLine.turn})`);
  console.log(`      ref: ${JSON.stringify(worstLine.reference)}`);
  console.log(`      stt: ${JSON.stringify(worstLine.hypothesis)}`);
}
// Labelled "heuristic" on the line itself: an outlier flag, not a measure of how the speech sounded.
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
  label: ARGS.label,
  livekit_url: process.env["LIVEKIT_URL"] ?? null,
  stt_tts_provider: process.env["STT_TTS_PROVIDER"] ?? "inference",
  speech: speechDescribe,
  /** Which mode served the run, so no number in this file is unattributable to it. */
  worker: { ...workerMode, allow_dev: ALLOW_DEV, allow_no_shedding: ALLOW_NO_SHEDDING },
  calls: CALLS,
  agent_hung_up: hungUp,
  /** Excluded from the WER denominator, because they have no transcript. */
  never_served_calls: neverServedCalls,
  agent_stretch_disagreements: stretchDisagreements,
  turn_taking: { interruption_mode: process.env["WORKER_INTERRUPTION_MODE"] ?? "vad", per_call: turnTaking },
  equivalence_green: green,
  duration_ms: { p50: pct(50), p95: pct(95), max: durations.at(-1) ?? 0 },
  turn_latency_ms: { n: turnMs.length, unanswered, p50: turnPct(50), p95: turnPct(95), max: turnMs.at(-1) ?? 0 },
  stt_entities: { ...entities, gate: ARGS.maxAmountErrors, breached: amountsBreached },
  stt_wer: { n: werValues.length, unmatched_transcripts: unmatched, p50: werPct(50), p95: werP95, max: werValues.at(-1) ?? null, gate: MAX_WER, breached: werBreached, worst_line: worstLine },
  /** Not gated: silent playouts already fail the run through equivalence. */
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
// A report without its resources block looks like a measurement and is not.
const reportProblems = validateReport(report);
if (reportProblems.length > 0) throw new Error(`report is not a valid measurement: ${reportProblems.join("; ")}`);
mkdirSync(REPORT_DIR, { recursive: true });
/** The label is in the filename, so a second run at the same N cannot overwrite the first. */
const path = `${REPORT_DIR}${reportFileName(new Date().toISOString().slice(0, 10), CALLS, ARGS.label)}`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
log(`report written: ${path}`);

// One score model for harness runs and production calls.
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
      ledgerTurns: (rowsByConversation.get(call.conversationId) ?? []).map((r) => ({ turn_id: r.turn_id, startedAtMs: Date.parse(r.started_at) })),
      // Closes the last line's join window at the end of its call.
      callEndedAtMs: call.endedAtMs,
      log,
    }),
  );
}

log(
  `entity errors: ${String(entities.amount_errors)} amount, ${String(entities.date_errors)} date, ` +
    `${String(entities.name_errors)} name over ${String(entities.n)} entities` +
    `${entities.entity_er === null ? "" : ` (er ${entities.entity_er.toFixed(3)})`}`,
);

// The run fails on any gate: staying correct because the words happened to survive is not a pass.
if (werBreached) log(`stt wer p95 ${werP95!.toFixed(3)} exceeds the ${MAX_WER} gate: FAIL`);
if (amountsBreached) log(`${String(entities.amount_errors)} amount error(s) exceeds the ${String(ARGS.maxAmountErrors)} gate: FAIL`);
process.exit(green === CALLS && !werBreached && !amountsBreached ? 0 : 1);
