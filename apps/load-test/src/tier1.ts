/**
 * Tier-1 load test: the control plane under hundreds of concurrent conversations.
 *
 * What it exercises, and why that is the interesting number: every conversation goes through the
 * real three-phase turn (T1 claim -> decide -> T2 commit) against real Postgres, so this measures
 * the row locks, the `active_turn_id` CAS, the ledger append and the outbox/scheduled-action
 * workers running in-process on the server. That is where the concurrency thesis lives
 * (ADR 0001/0003). `TURN_DECIDER=scripted` keeps it deterministic and free — no LLM latency
 * smearing the distribution and no token bill.
 *
 * Correctness is the gate; latency is reported. A run "passes" when every conversation's final
 * ledger matches the reference simulation scenario (state path, tool sequence, outcome). A slow
 * run is a fact to write down; a wrong one is a bug.
 *
 * Run: pnpm --filter @feather-lite/load-test tier1 -- --concurrency 100 --ramp 5
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/* ------------------------------- config ------------------------------- */

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};

const CONCURRENCY = Number(flag("concurrency", "10"));
const RAMP_SECONDS = Number(flag("ramp", "2"));
/** Appended to the report filename so runs at the same C but different server config stay distinct. */
const LABEL = flag("label", "");
const BASE = (process.env["LOAD_TEST_API"] ?? flag("api", "http://127.0.0.1:8080")).replace(/\/$/, "");
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5434/feather_lite";
const REPORT_DIR = fileURLToPath(new URL("../../../docs/loadtest/", import.meta.url));

/** The scripted conversation every virtual borrower drives to its natural outcome. */
const SCRIPT = ["yes this is Jordan", "I can pay 550 on Friday", "yes"] as const;

const authHeaders = (): Record<string, string> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  return { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ SSE turn ------------------------------ */

interface TurnEnd {
  readonly new_state: string;
  readonly tool_called: { name: string } | null;
  readonly outcome: string | null;
  readonly end_call: boolean;
  readonly degraded: boolean;
  readonly ttft_ms: number | null;
}

interface TurnObservation {
  readonly ok: boolean;
  readonly status: number;
  readonly wallMs: number;
  readonly ttftMs: number | null;
  readonly end: TurnEnd | null;
  readonly error: string | null;
}

/**
 * Drive one streaming turn and read the frames to completion. `turn_end` only arrives after every
 * durable write has committed, so its arrival is the honest end of the turn.
 */
const runTurn = async (conversationId: string, turnId: string, userText: string): Promise<TurnObservation> => {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/conversations/${conversationId}/turn`, {
      method: "POST",
      headers: { ...authHeaders(), accept: "text/event-stream" },
      body: JSON.stringify({ turn_id: turnId, user_text: userText }),
    });
  } catch (e) {
    return { ok: false, status: 0, wallMs: Date.now() - t0, ttftMs: null, end: null, error: `transport: ${String(e)}` };
  }
  if (!res.ok || !res.body) {
    return { ok: false, status: res.status, wallMs: Date.now() - t0, ttftMs: null, end: null, error: (await res.text()).slice(0, 300) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let end: TurnEnd | null = null;
  let errorFrame: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE records are separated by a blank line; `data:` carries the JSON frame.
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = record.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        const frame = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
        if (frame["type"] === "turn_end") end = frame as unknown as TurnEnd;
        if (frame["type"] === "error") errorFrame = `${String(frame["code"])}: ${String(frame["message"])}`;
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  return {
    ok: end !== null,
    status: res.status,
    wallMs: Date.now() - t0,
    ttftMs: end?.ttft_ms ?? null,
    end,
    error: errorFrame ?? (end ? null : "stream ended without turn_end"),
  };
};

/* --------------------------- one conversation -------------------------- */

interface ConversationRun {
  readonly index: number;
  readonly conversationId: string | null;
  readonly startMs: number;
  readonly turns: ReadonlyArray<TurnObservation>;
  readonly startError: string | null;
}

const runConversation = async (index: number, fixture: { borrower_id: string; contact_point_id: string }): Promise<ConversationRun> => {
  const t0 = Date.now();
  let conversationId: string | null = null;
  try {
    const res = await fetch(`${BASE}/api/calls/start`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ borrower_id: fixture.borrower_id, contact_point_id: fixture.contact_point_id, channel: "simulated" }),
    });
    if (!res.ok) return { index, conversationId: null, startMs: Date.now() - t0, turns: [], startError: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    conversationId = ((await res.json()) as { conversation_id: string }).conversation_id;
  } catch (e) {
    return { index, conversationId: null, startMs: Date.now() - t0, turns: [], startError: `transport: ${String(e)}` };
  }
  const startMs = Date.now() - t0;

  const turns: TurnObservation[] = [];
  for (const [n, text] of SCRIPT.entries()) {
    const obs = await runTurn(conversationId, `t${n + 1}`, text);
    turns.push(obs);
    if (!obs.ok || obs.end?.end_call) break;
  }
  return { index, conversationId, startMs, turns, startError: null };
};

/* ------------------------------ statistics ----------------------------- */

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
};
const summarize = (values: ReadonlyArray<number>) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1) ?? 0, mean: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0 };
};

/* -------------------------------- main --------------------------------- */

console.log(`[tier1] api=${BASE} concurrency=${CONCURRENCY} ramp=${RAMP_SECONDS}s script=${SCRIPT.length} turns`);

const status = (await (await fetch(`${BASE}/api/system/status`)).json()) as { turn_decider: string };
if (status.turn_decider !== "scripted") {
  console.warn(`[tier1] WARNING: turn_decider=${status.turn_decider}. Latency will be dominated by the LLM and the run will cost money. Set TURN_DECIDER=scripted.`);
}

// The reference outcome comes from the scenario suite, not from a constant in this file.
const refRes = await fetch(`${BASE}/api/testing/scenarios/happy-path-promise-to-pay/run`, { method: "POST", headers: authHeaders() });
if (!refRes.ok) throw new Error(`reference scenario failed: ${refRes.status} ${await refRes.text()}`);
const reference = (await refRes.json()) as { passed: boolean; actual_state_path: string[]; actual_tools: string[]; final_outcome: string | null };
if (!reference.passed) throw new Error("the reference scenario did not pass its own assertions; fix that before load testing");
console.log(`[tier1] reference outcome=${String(reference.final_outcome)} states=${reference.actual_state_path.length} tools=${reference.actual_tools.join(",")}`);

const fixturesRes = await fetch(`${BASE}/api/demo/load-fixtures`, {
  method: "POST",
  headers: authHeaders(),
  body: JSON.stringify({ count: CONCURRENCY, prefix: `t1-${Date.now().toString(36)}` }),
});
if (!fixturesRes.ok) throw new Error(`load-fixtures ${fixturesRes.status}: ${await fixturesRes.text()}`);
const fixtures = (await fixturesRes.json()) as Array<{ borrower_id: string; contact_point_id: string }>;
console.log(`[tier1] minted ${fixtures.length} fixture borrowers`);

// Sample pg_stat_activity throughout the run and keep the busiest sample: what the DB looked like
// at peak is the interesting number, and a single timed snapshot misses short runs entirely.
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
interface PgSample {
  backends: number;
  active: number;
  idleInTransaction: number;
  waiting: number;
  samples: number;
}
const pg: { peak: PgSample | null } = { peak: null };
const sampler = setInterval(() => {
  void (async () => {
    try {
      const rows = await sql<Array<{ state: string | null; waiting: boolean; n: string }>>`
        SELECT state, (wait_event_type = 'Lock') AS waiting, count(*)::text AS n
        FROM pg_stat_activity WHERE datname = current_database() GROUP BY state, waiting`;
      const num = (pred: (r: { state: string | null; waiting: boolean }) => boolean) => rows.filter(pred).reduce((a, r) => a + Number(r.n), 0);
      const s: PgSample = {
        backends: num(() => true),
        active: num((r) => r.state === "active"),
        idleInTransaction: num((r) => r.state === "idle in transaction"),
        waiting: num((r) => r.waiting),
        samples: (pg.peak?.samples ?? 0) + 1,
      };
      if (!pg.peak || s.active > pg.peak.active || (s.active === pg.peak.active && s.backends > pg.peak.backends)) pg.peak = s;
      else pg.peak = { ...pg.peak, samples: s.samples };
    } catch {
      /* the snapshot is a nice-to-have; never fail the run for it */
    }
  })();
}, 200);
sampler.unref();

const wallStart = Date.now();
const runs = await Promise.all(
  fixtures.map(async (f, i) => {
    if (RAMP_SECONDS > 0) await sleep(Math.floor((i / Math.max(1, fixtures.length)) * RAMP_SECONDS * 1000));
    return runConversation(i, f);
  }),
);
const wallMs = Date.now() - wallStart;
clearInterval(sampler);

/* ------------------------- correctness assertions ---------------------- */

interface Verdict {
  readonly index: number;
  readonly conversationId: string | null;
  readonly correct: boolean;
  readonly failures: ReadonlyArray<string>;
}

const verdicts: Verdict[] = [];
for (const run of runs) {
  const failures: string[] = [];
  if (!run.conversationId) {
    verdicts.push({ index: run.index, conversationId: null, correct: false, failures: [`start failed: ${run.startError ?? "unknown"}`] });
    continue;
  }
  const detailRes = await fetch(`${BASE}/api/conversations/${run.conversationId}`, { headers: authHeaders() });
  if (!detailRes.ok) {
    verdicts.push({ index: run.index, conversationId: run.conversationId, correct: false, failures: [`detail ${detailRes.status}`] });
    continue;
  }
  const detail = (await detailRes.json()) as {
    conversation?: { final_outcome: string | null };
    event_timeline?: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  // Correctness is the gate, so an unexpected response shape has to fail loudly — silently
  // comparing two empty arrays would report a clean run over a broken one.
  if (!detail.conversation || !Array.isArray(detail.event_timeline)) {
    verdicts.push({ index: run.index, conversationId: run.conversationId, correct: false, failures: [`unexpected detail shape (keys: ${Object.keys(detail).join(", ")})`] });
    continue;
  }
  const statePath = detail.event_timeline.filter((e) => e.type === "STATE_TRANSITION").map((e) => String(e.payload["to"]));
  const tools = detail.event_timeline.filter((e) => e.type === "TOOL_CALLED").map((e) => String(e.payload["name"]));
  if (JSON.stringify(statePath) !== JSON.stringify(reference.actual_state_path)) failures.push(`state path ${JSON.stringify(statePath)}`);
  if (JSON.stringify(tools) !== JSON.stringify(reference.actual_tools)) failures.push(`tools ${JSON.stringify(tools)}`);
  if (detail.conversation.final_outcome !== reference.final_outcome) failures.push(`outcome ${String(detail.conversation.final_outcome)}`);
  verdicts.push({ index: run.index, conversationId: run.conversationId, correct: failures.length === 0, failures });
}

/* -------------------------------- report ------------------------------- */

const allTurns = runs.flatMap((r) => r.turns);
const okTurns = allTurns.filter((t) => t.ok);
const ttft = summarize(okTurns.map((t) => t.ttftMs).filter((v): v is number => v !== null));
const wall = summarize(okTurns.map((t) => t.wallMs));
const starts = summarize(runs.filter((r) => r.conversationId).map((r) => r.startMs));
const errorsByStatus = new Map<number, number>();
for (const t of allTurns.filter((x) => !x.ok)) errorsByStatus.set(t.status, (errorsByStatus.get(t.status) ?? 0) + 1);
const startErrors = runs.filter((r) => r.startError).map((r) => r.startError!);
const correct = verdicts.filter((v) => v.correct).length;

console.log("");
console.log(`  concurrency            ${CONCURRENCY}`);
console.log(`  wall clock             ${(wallMs / 1000).toFixed(1)}s (ramp ${RAMP_SECONDS}s)`);
console.log(`  conversations correct  ${correct}/${CONCURRENCY}`);
console.log(`  turns ok / attempted   ${okTurns.length}/${allTurns.length}`);
console.log(`  throughput             ${(okTurns.length / (wallMs / 1000)).toFixed(1)} turns/s`);
console.log(`  start   p50/p95/p99    ${starts.p50} / ${starts.p95} / ${starts.p99} ms`);
console.log(`  TTFT    p50/p95/p99    ${ttft.p50} / ${ttft.p95} / ${ttft.p99} ms  (max ${ttft.max})`);
console.log(`  turn    p50/p95/p99    ${wall.p50} / ${wall.p95} / ${wall.p99} ms  (max ${wall.max})`);
console.log(`  turn errors by status  ${errorsByStatus.size ? [...errorsByStatus].map(([s, n]) => `${s}:${n}`).join(" ") : "none"}`);
console.log(`  start errors           ${startErrors.length}`);
console.log(`  pg at peak             ${pg.peak ? `${pg.peak.backends} backends, ${pg.peak.active} active, ${pg.peak.idleInTransaction} idle-in-tx, ${pg.peak.waiting} lock-waiting (${pg.peak.samples} samples)` : "(not captured)"}`);
if (startErrors.length) console.log(`  first start error      ${startErrors[0]}`);
for (const v of verdicts.filter((x) => !x.correct).slice(0, 10)) console.log(`  INCORRECT #${v.index} ${v.conversationId ?? "-"}: ${v.failures.join("; ")}`);
console.log("");

const report = {
  tier: "1-control-plane",
  api: BASE,
  label: LABEL || null,
  concurrency: CONCURRENCY,
  ramp_seconds: RAMP_SECONDS,
  turn_decider: status.turn_decider,
  script: SCRIPT,
  wall_ms: wallMs,
  conversations: { total: CONCURRENCY, correct, incorrect: CONCURRENCY - correct },
  turns: { attempted: allTurns.length, ok: okTurns.length, throughput_per_second: Number((okTurns.length / (wallMs / 1000)).toFixed(2)) },
  latency_ms: { start: starts, ttft, turn_wall: wall },
  errors: { by_status: Object.fromEntries(errorsByStatus), start_errors: startErrors.slice(0, 20) },
  pg_at_peak: pg.peak,
  reference: { state_path: reference.actual_state_path, tools: reference.actual_tools, final_outcome: reference.final_outcome },
  incorrect: verdicts.filter((v) => !v.correct).map((v) => ({ index: v.index, conversation_id: v.conversationId, failures: v.failures })),
};
mkdirSync(REPORT_DIR, { recursive: true });
const path = `${REPORT_DIR}${new Date().toISOString().slice(0, 10)}-tier1-c${CONCURRENCY}${LABEL ? `-${LABEL}` : ""}.json`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[tier1] report written: ${path}`);

await sql.end();
process.exit(correct === CONCURRENCY ? 0 : 1);
