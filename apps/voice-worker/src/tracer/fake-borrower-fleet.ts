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
import { percentile, ttsAggregate } from "@feather-lite/domain";
import { formatResourceReport, perCoreBudget, startResourceSampler, validateReport, WORKER_CONTAINERS, WORKER_ROLES, type Role } from "@feather-lite/load-test/resources";
import { checkEquivalence, loadScenarioReference, type EquivalenceResult } from "./equivalence.js";
import { buildHarnessScores, postHarnessScores, summariseWer } from "./harness-scores.js";
import type { ScriptedCallResult } from "./scripted-call.js";
import type { BorrowerProcMessage, BorrowerProcRequest } from "./borrower-proc.js";
import { harnessJsonHeaders } from "@feather-lite/load-test/harness-http";
import { parseFleetArgs, reportFileName } from "./fleet-args.js";
import { speechWindows, turnTakingMetrics, withPlayoutTruth } from "@feather-lite/domain";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

/**
 * Parsed rather than scanned (H6). The old `flag()` read one name at a time and never looked at what
 * else was on the line, so an unknown flag — `--label` included — was accepted and ignored.
 */
const PARSED = parseFleetArgs(process.argv);
if (!PARSED.ok) {
  process.stderr.write(`${PARSED.message}
`);
  process.exit(2);
}
const ARGS = PARSED.ok ? PARSED.args : null!;

const CALLS = ARGS.calls;
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
const MAX_WER = ARGS.maxWer;
/**
 * Borrowers run in a forked child by default (W8). `--in-proc` keeps the old single-process shape
 * for a quick one-off; every committed measurement uses the forked one, because a run that reports
 * the worker's latency while N Opus encoders share its event loop is measuring the harness.
 */
const IN_PROC = ARGS.inProc;
/**
 * Every fleet number taken before 2026-08-27 was measured against a `dev`-mode worker and nothing
 * said so, which is why a `dev`-mode run is a refusal rather than a footnote. `--allow-dev` is
 * there for a deliberate one, and it is recorded in the report.
 *
 * What dev mode actually costs here is `tsx` instead of the bundle, debug logging and the
 * framework's development defaults — **not** load shedding. That claim (repeated in the Dockerfile
 * and in the refusal message) was wrong: `ServerOptions` forces `loadThreshold` to `Infinity` only
 * under `--simulation` (`agents/dist/worker.js:166`), and this worker passes 0.75 explicitly, which
 * survives dev mode. `--simulation` is its own refusal with its own flag, below: it is a different
 * fact — a `--simulation` worker is `production: true` — and one flag must not wave through two.
 */
const ALLOW_DEV = ARGS.allowDev;
/** Deliberately measuring a worker that can never ask the SFU to prefer somebody else. */
const ALLOW_NO_SHEDDING = ARGS.allowNoShedding;
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const REPORT_DIR = fileURLToPath(new URL("../../../../docs/loadtest/", import.meta.url));

const t0 = Date.now();
const log = (m: string) => console.log(`[fleet] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

log(`calls=${CALLS} max-wer=${MAX_WER} borrowers=${IN_PROC ? "in-process" : "forked child"} livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"} stt/tts=${process.env["STT_TTS_PROVIDER"] ?? "inference"}`);

/**
 * Started first so its opening tick is the idle worker tree: that reading is the `idle_rss_tree`
 * term of `mb_per_call`, and it is only idle before the first room is created.
 */
const roleOverrides = new Map<number, Role>([[process.pid, "harness"]]);
const sampler = startResourceSampler({ roleOverrides });
await sampler.awaitFirstSample();

/**
 * Which worker is about to serve this run, and in which mode. Read from `/status` rather than
 * asked of the worker directly: the heartbeat is already the only channel between them, and a
 * worker that is not heartbeating is one this run would have waited on anyway.
 */
interface WorkerMode {
  /** Null when no online worker is reporting at all — a different fact from "dev mode". */
  readonly production: boolean | null;
  readonly simulation: boolean;
  /** `loadThreshold` resolved to `Infinity`, so the worker can never report itself busy. */
  readonly sheddingDisabled: boolean;
  readonly maxJobs: number | null;
  /** The pool's real warm count, and the number it was configured with. */
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
 * Separate from the dev-mode gate, because it is a separate fact and the two were conflated.
 *
 * `start --simulation` is `production: true` and would pass the gate above, and it is the mode in
 * which `ServerOptions` forces `loadThreshold` to `Infinity` (`agents/dist/worker.js:166`) — so the
 * worker never tells the SFU it is busy. Dev mode does *not* do that here: this worker passes 0.75
 * explicitly and it survives, which is what the old message claimed the opposite of.
 */
if (workerMode.sheddingDisabled && !ALLOW_NO_SHEDDING) {
  console.error("[fleet] the worker is running under --simulation, where loadThreshold is Infinity and it can never ask the SFU to prefer somebody else. Restart it without --simulation, or pass --allow-no-shedding deliberately.");
  process.exit(1);
}
if (workerMode.idleProcesses !== null && workerMode.idleConfigured !== null && workerMode.idleProcesses < workerMode.idleConfigured) {
  // Now visible because the heartbeat reports the pool's real count rather than the constant it was
  // configured with. A short pool means the first calls pay a ~1.8 s cold start inside the call.
  log(`warning: the warm pool is ${String(workerMode.idleProcesses)} of a configured ${String(workerMode.idleConfigured)}; the first calls will pay a cold start.`);
}
if (workerMode.maxJobs !== null && CALLS > Math.floor(workerMode.maxJobs * 0.75)) {
  /**
   * A refusal now, not a warning (H4).
   *
   * It was a warning on the argument that a run *meant* to find the shedding point is legitimate —
   * which is true, and is what `--allow-shed` is for. What the warning could not stop is the far
   * commoner case: a run configured past the ceiling by accident, whose surplus calls are refused,
   * and whose report then reads as a **quality** failure rather than a capacity one.
   *
   * Measured, on the first N=10 acceptance attempt (2026-09-01): `WORKER_MAX_JOBS=10` served nine
   * calls, the tenth finalized `NEVER_SERVED` with no transcript, and the harness scored its three
   * lines at WER 1.000 — so the run came back "8/10 with the WER gate breached" and the gate that
   * actually failed was the ceiling. The warning was printed and read past.
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
// The domain's nearest-rank rule, not a fourth local copy of it: this harness had the same
// off-by-one the SLO gate had (O1), so a fleet report's p50 could be the larger of two readings.
// `?? 0` keeps the report's numeric shape for an empty sample, which the schema has always had.
const pct = (p: number) => percentile(durations, p) ?? 0;

// Per-turn response latency across every call in the fleet. This — not call durationMs, which is
// dominated by the scripted sleeps — is the number a latency A/B compares.
const turnMs = results.flatMap((r) => r.turnLatencies.map((t) => t.ms)).sort((a, b) => a - b);
const turnPct = (p: number) => percentile(turnMs, p) ?? 0;
const unanswered = results.reduce((n, r) => n + r.unansweredTurns.length, 0);

/**
 * Every borrower line across the fleet — **from the calls a worker actually served** (H4).
 *
 * A call the SFU never assigned finalizes `NEVER_SERVED` with no transcript, so every one of its
 * lines scores WER 1.000: perfect deletions against a hypothesis nobody produced. That is not a
 * transcription result, and folding it into the gate turns a capacity failure into a quality one.
 *
 * Measured, on the first N=10 acceptance attempt (2026-09-01): nine calls served, the tenth never
 * assigned, and the run reported "8/10 with the WER gate breached" — a breach caused entirely by the
 * call that had no audio to transcribe.
 *
 * "Served" is `agentAudioFrames > 0`: the borrower heard the agent speak, so there was something to
 * transcribe. The excluded calls are counted and reported rather than quietly dropped, because a run
 * that silently narrows its own denominator is the other way to get a flattering number.
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
 * The six turn-taking numbers, per call (issue #1, D4 — Phase 1's headline).
 *
 * Every piece was already here and none of them had been joined: H1 keeps the agent's speech
 * stretches, `withPlayoutTruth` attaches the ledger's `AGENT_TURN_PLAYOUT.interrupted` to each, the
 * script records what the borrower did and when, and `turnTakingMetrics` turns the pair into the
 * numbers. This is the joining.
 *
 * **They are VAD-interruption numbers and the report says so** (issue #4, amendment 8). Adaptive
 * interruption has never run on this profile — W1 made the config admit it — so Phase 2's A/B has to
 * compare against a baseline labelled with the mode that produced it.
 *
 * `truncated: null` for a stretch with no playout behind it, excluded from every rate and counted
 * (H11), so a thin denominator is visible rather than flattering.
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
 * The live onset detector against the post-hoc one (issue #4, H1).
 *
 * The harness now counts agent speech stretches twice: live, inside the audio loop, because a
 * scenario has to react to an onset; and afterwards by running `speechWindows()` over the samples it
 * kept. They are the same rule at the same threshold and hangover, so they must agree — and if they
 * ever do not, every turn-taking number computed from the second is describing audio the first did
 * not see, which is the failure that would be least visible and most expensive.
 *
 * Reported, not fatal: a disagreement is a fact about the run worth reading, and failing a fleet run
 * over a metric that gates nothing yet would be the wrong trade. Phase 1 makes it a gate when the
 * numbers it feeds are the ones being reported.
 */
const stretchDisagreements = results.flatMap((r) => {
  const postHoc = speechWindows(r.rmsSamples).length;
  return postHoc === r.liveStretchCount ? [] : [{ call: r.label, live: r.liveStretchCount, postHoc }];
});
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
/** The same rows, kept per conversation, so a harness score can carry the ledger's turn id (O8). */
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
/**
 * Printed as a block per metric rather than per call: six numbers over five calls is a table nobody
 * reads, and the median across the fleet is what a baseline is.
 */
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
  /** What this run was called (H6). In the filename too, so an archived report identifies itself. */
  label: ARGS.label,
  livekit_url: process.env["LIVEKIT_URL"] ?? null,
  stt_tts_provider: process.env["STT_TTS_PROVIDER"] ?? "inference",
  speech: speechDescribe,
  /** Which mode served the run, so no number in this file is ever again unattributable to it (W2). */
  worker: { ...workerMode, allow_dev: ALLOW_DEV, allow_no_shedding: ALLOW_NO_SHEDDING },
  calls: CALLS,
  agent_hung_up: hungUp,
  /** Calls no worker served, excluded from the WER denominator because they have no transcript (H4). */
  never_served_calls: neverServedCalls,
  /** Live vs post-hoc onset detection, per H1. Empty means the two agree on every call. */
  agent_stretch_disagreements: stretchDisagreements,
  /**
   * D4's six numbers per call, and the label that makes them comparable (issue #1 Phase 1, issue #4
   * amendment 8). `interruption_mode` is what the session asked for and what it actually ran, which
   * since W1 are the same thing.
   */
  turn_taking: { interruption_mode: process.env["WORKER_INTERRUPTION_MODE"] ?? "vad", per_call: turnTaking },
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
/**
 * The label is in the filename (H6), so a second run on the same day at the same N cannot overwrite
 * the first. It used to, silently — a tracked report was lost that way on 2026-09-02.
 */
const path = `${REPORT_DIR}${reportFileName(new Date().toISOString().slice(0, 10), CALLS, ARGS.label)}`;
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
      // The ledger's own turns, which this run already fetched for its TTS numbers (O8).
      ledgerTurns: (rowsByConversation.get(call.conversationId) ?? []).map((r) => ({ turn_id: r.turn_id, startedAtMs: Date.parse(r.started_at) })),
      // Closes the last line's join window at the end of its call (H3).
      callEndedAtMs: call.endedAtMs,
      log,
    }),
  );
}

// The run fails on either gate. Equivalence is correctness and WER is transcription quality; a run
// that stayed correct only because the words happened to survive is not a pass.
if (werBreached) log(`stt wer p95 ${werP95!.toFixed(3)} exceeds the ${MAX_WER} gate: FAIL`);
process.exit(green === CALLS && !werBreached ? 0 : 1);
