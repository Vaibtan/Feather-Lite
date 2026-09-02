/**
 * Tier 3: one seeded scenario, one call, and the numbers it produced (issue #1, D4 — Phase 1).
 *
 * A **composition**, not a second harness (issue #1, user story 29). Everything here already
 * existed: `bootstrapRoom` and `runScriptedCall` join the room and run a `BorrowerScript` (H9), the
 * line cache synthesises the persona's lines (H9), the RMS detector keeps every sample (H1),
 * `withPlayoutTruth` attaches the ledger's playout truth (H11), `turnTakingMetrics` turns the pair
 * into D4's six numbers, `makeRng` makes the stochastic parts reproducible (H7), and the equivalence
 * runner already knows how to compare a call to a scenario. This wires them to a scenario table.
 *
 *   pnpm --filter @feather-lite/voice-worker sim-borrower -- --scenario yes-during-read-back --seed 7
 *
 * The report is `docs/loadtest/${date}-tier3-${scenario}-${label}.json` and it carries the seed, the
 * scenario, the persona and the interruption mode — because a tier-3 number without those four is
 * not reproducible and should not be quoted.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { seedFrom, speechWindows, turnTakingMetrics, withPlayoutTruth } from "@feather-lite/domain";
import { harnessJsonHeaders } from "@feather-lite/load-test/harness-http";
import { loadScriptedLines, runScriptedCall } from "./scripted-call.js";
import { parseSimArgs } from "./harness-args.js";
import { postHarnessScores, turnTakingScores } from "./harness-scores.js";
import { checkExpectedLedger, rngFor, scenarioById, TIER3_SCENARIOS, verdictFor } from "./scenarios-tier3.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

const t0 = Date.now();
const log = (m: string) => console.log(`[tier3] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

/**
 * H6's command line, shared rather than re-invented (`harness-args.ts`).
 *
 * The first cut of this file carried its own `flag()` helper with an optional `--label` defaulting
 * to the scenario id — which is the collision `fleet-args.ts` was written to stop, and which cost a
 * tracked report on 2026-09-02. Two runs of one scenario in a day now have two reports, and a
 * misspelled flag is refused instead of ignored.
 */
const parsed = parseSimArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`[tier3] ${parsed.message}`);
  process.exit(2);
}
const { scenario: scenarioId, seed, seedGiven, persona, label, reportFileName } = parsed.args;

const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const REPORT_DIR = fileURLToPath(new URL("../../../../docs/loadtest/", import.meta.url));

const scenario = scenarioById(scenarioId);
if (!scenario) {
  console.error(`[tier3] no scenario ${JSON.stringify(scenarioId)}. Known: ${TIER3_SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}
if (scenario.needs.length > 0) {
  // Refused rather than run-and-pass: a scenario that cannot exercise what it asserts would report a
  // green it did not earn, which is the one thing a harness must never do.
  console.error(`[tier3] ${scenario.id} cannot run yet — it needs: ${scenario.needs.join("; ")}`);
  process.exit(2);
}

/**
 * A throwaway borrower per run, minted the way the fleet mints its own.
 *
 * Tier 3 dialled the seeded demo borrower on every scenario and the sixth run of the day was
 * refused with `FREQUENCY_CAP` — a real pre-call rule doing its job, and a harness that cannot be
 * run twice is not a harness. `TRACER_BORROWER` still overrides, for the case where the point is to
 * call a particular borrower.
 */
const mintBorrower = async (): Promise<string> => {
  const named = process.env["TRACER_BORROWER"];
  if (named !== undefined && named.length > 0) return named;
  const res = await fetch(`${CONTROL_PLANE_URL}/api/demo/load-fixtures`, {
    method: "POST",
    headers: harnessJsonHeaders(),
    body: JSON.stringify({ count: 1, prefix: `tier3-${scenario.id}-${Date.now().toString(36)}` }),
  });
  if (!res.ok) throw new Error(`load-fixtures ${String(res.status)}: ${await res.text()}`);
  const [fixture] = (await res.json()) as Array<{ name: string }>;
  if (!fixture) throw new Error("load-fixtures returned no borrower");
  return fixture.name;
};
const borrowerName = await mintBorrower();
/** Amendment 8: every tier-3 number is a VAD-interruption number until the A/B says otherwise. */
const INTERRUPTION_MODE = process.env["WORKER_INTERRUPTION_MODE"] ?? "vad";

log(`borrower=${borrowerName}`);
log(`scenario=${scenario.id} seed=${seedGiven}(${String(seed)}) persona=${persona ?? "(default)"} label=${label}`);
log(scenario.what);

const lines = await loadScriptedLines(persona);
log(`borrower lines ready (${lines.cached ? "cached" : "synthesised"}, ${lines.describe})`);

const call = await runScriptedCall({
  lines,
  controlPlaneUrl: CONTROL_PLANE_URL,
  borrowerName,
  participantIdentity: `borrower-sim-${String(seed)}`,
  label: scenario.id,
  /**
   * The one thing that keeps this call out of the window the product's latency claim is made from
   * (issue #1, D4). A tier-3 call is `channel: "voice"` served by the real decider — exactly what
   * the default SLO segment selects — so neither of the other two columns can tell it apart.
   */
  harness: "sim",
  log,
  script: scenario.script(rngFor(seed)),
});

if (!call.conversationId) {
  console.error(`[tier3] the call never opened a conversation${call.error ? `: ${call.error}` : ""}`);
  process.exit(1);
}

/** The ledger, for the expected shape and for the playout truth the metrics need. */
const detailRes = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${call.conversationId}`, { headers: harnessJsonHeaders() });
if (!detailRes.ok) {
  console.error(`[tier3] could not read the conversation back: ${detailRes.status}`);
  process.exit(1);
}
const detail = (await detailRes.json()) as {
  conversation: { final_outcome: string | null; harness: string | null };
  event_timeline: Array<{ type: string; created_at: string; payload: Record<string, unknown> }>;
};

const tools = detail.event_timeline.filter((e) => e.type === "TOOL_CALLED").map((e) => String(e.payload["name"]));
const agentLines = detail.event_timeline.filter((e) => e.type === "AGENT_TURN").map((e) => String(e.payload["text"] ?? ""));
const playouts = detail.event_timeline
  .filter((e) => e.type === "AGENT_TURN_PLAYOUT")
  .map((e) => ({ atMs: Date.parse(e.created_at), interrupted: e.payload["interrupted"] === true }))
  .filter((p) => Number.isFinite(p.atMs));

const failures = checkExpectedLedger(scenario.expected, { finalOutcome: detail.conversation.final_outcome, tools, agentLines, playouts });

/** D4's six numbers, from the stretches this call actually produced. */
const agent = withPlayoutTruth(speechWindows(call.rmsSamples), playouts);
const metrics = turnTakingMetrics({ borrower: call.borrowerEvents, agent });

console.log("");
console.log(`  scenario              ${scenario.id}  seed=${seedGiven}  persona=${persona ?? "(default)"}`);
const verdict = verdictFor(failures, scenario.expectedToFail);
console.log(`  ledger shape          ${verdict.line}`);
for (const f of failures) console.log(`      - ${f}`);
for (const gap of scenario.notYetAsserted ?? []) console.log(`  not yet asserted      ${gap}`);
console.log(`  outcome               ${String(detail.conversation.final_outcome)}`);
console.log(`  read-backs            ${String(agentLines.filter((l) => /say yes to confirm/i.test(l)).length)}`);
console.log(`  turn-taking (VAD)     response ${String(metrics.response_rate)}  yield ${String(metrics.yield_rate)}  yield_ms ${String(metrics.yield_latency_ms)}`);
console.log(`                        false_interrupt ${String(metrics.false_interrupt_rate)}  agent_interrupt ${String(metrics.agent_interrupt_rate)}  selectivity ${String(metrics.selectivity)}`);
console.log(`                        ${String(metrics.counts.unknown_truncation)} stretch(es) had no playout behind them and are excluded (H11)`);
console.log(`  agent stretches       ${String(call.liveStretchCount)} live, ${String(agent.length)} post-hoc`);

/**
 * The six numbers as scores, under H8's names (D4: "all are harness scores with the same 'harness
 * metric' labelling as WER"). Posted before the report is written, so the report can carry what the
 * ledger actually accepted rather than what was offered.
 */
await postHarnessScores(
  CONTROL_PLANE_URL,
  call.conversationId,
  turnTakingScores(metrics, { scenario: scenario.id, seed, persona: persona ?? null, interruption_mode: INTERRUPTION_MODE }),
  log,
);

/**
 * The two gates that lived only in README prose (P2), now in the file.
 *
 * **The SLO block is about the window this call is excluded from, and that is the point.** A tier-3
 * call is `channel: "voice"` served by the real decider, so without `harness` it would land in the
 * window the product's latency claim is made from — with audio deliberately harder than a real
 * call's. Reporting the default segment's verdict beside `excluded_from_segment: true` is how a
 * reader sees the exclusion held, rather than taking it on trust.
 */
const slo = await (async () => {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/system/quality?calls=50`, { headers: harnessJsonHeaders() });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    const q = (await res.json()) as { window: { conversations: number }; slo: { verdict: string; segment: unknown; breaches: string[]; insufficient: string[] } };
    return {
      /** Of the real-call window, which this call must not be in. */
      verdict: q.slo.verdict,
      segment: q.slo.segment,
      breaches: q.slo.breaches,
      insufficient: q.slo.insufficient,
      window_conversations: q.window.conversations,
      /**
       * The rule's claim, not this run's measurement — and labelled so nobody reads it as the
       * latter. `latencyAggregateForSegment` filters `harness IS NOT DISTINCT FROM null`, so every
       * window that does not ask for a harness excludes this call; the proof is the DB test
       * "keeps a simulator call out of the real-call SLO window" in `quality.test.ts`, not this
       * field. What this run does establish is the precondition beside it: `harness` came back
       * `"sim"`, so the column the rule reads was actually written.
       */
      excluded_by_rule: "harness IS NOT DISTINCT FROM null (Queries.latencyAggregateForSegment)",
    };
  } catch (e) {
    // Never fails the run: the scenario's verdict is the ledger shape, not the reporting of it.
    return { error: String(e) };
  }
})();

/**
 * The deterministic compliance checks for **this** conversation, from the ledger's own evaluator —
 * not recomputed here, because a harness that grades itself is not a gate.
 */
const compliance = await (async () => {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${call.conversationId}/scores`, { headers: harnessJsonHeaders() });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    const rows = (await res.json()) as Array<{ name: string; value: number; comment: string | null }>;
    const checks = rows.filter((r) => r.name.startsWith("compliance."));
    return {
      checks: Object.fromEntries(checks.map((r) => [r.name, r.value === 1])),
      /** Empty is not a pass: it means the evaluator had not run when this was read. */
      failed: checks.filter((r) => r.value !== 1).map((r) => r.name),
      count: checks.length,
    };
  } catch (e) {
    return { error: String(e) };
  }
})();

const report = {
  tier: "3-sim",
  scenario: scenario.id,
  /** All four, because a tier-3 number without them is not reproducible (D4). */
  seed: { given: seedGiven, resolved: seed },
  persona: persona ?? null,
  interruption_mode: INTERRUPTION_MODE,
  label,
  conversation_id: call.conversationId,
  harness: detail.conversation.harness,
  expected: {
    failures,
    verdict: verdict.line,
    exit_code: verdict.exitCode,
    expected_to_fail: scenario.expectedToFail ?? null,
    outcome: detail.conversation.final_outcome,
    tools,
    not_yet_asserted: scenario.notYetAsserted ?? [],
  },
  turn_taking: metrics,
  slo,
  compliance,
  /**
   * Placeholder, and named as one. `stt.entity_er` — the error rate on the amounts, dates and names
   * a collections call turns on — is issue #1's D3, and a zero here would read as "no entity errors"
   * rather than "not measured yet". The key exists so the schema does not change under Phase 3.
   */
  entities: { measured: false, entity_er: null, note: "stt.entity_er is D3 (Phase 3); not measured" },
  agent_stretches: { live: call.liveStretchCount, post_hoc: agent.length },
  stt_wer: call.werLines.map((l) => ({ turn: l.turn, wer: l.wer })),
  duration_ms: call.durationMs,
};

mkdirSync(REPORT_DIR, { recursive: true });
const path = `${REPORT_DIR}${reportFileName(new Date().toISOString().slice(0, 10))}`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
log(`report written: ${path}`);

process.exit(verdict.exitCode);
