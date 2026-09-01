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
 * Two arrival shapes, because they answer different questions:
 *
 *   closed loop (`--concurrency C`)   C borrowers each drive their script to completion. Latency at
 *                                     a known concurrency; this is where the knee and the
 *                                     throughput ceiling live.
 *   open loop   (`--rate R --duration S`)  conversations start at a fixed rate for S seconds
 *                                     regardless of whether the earlier ones finished. This is the
 *                                     soak: it is the only mode that can show the outbox falling
 *                                     behind, the `TurnRunner` retention map growing, or RSS
 *                                     climbing, because a 7-second closed-loop burst never gets
 *                                     far enough into any of them to tell.
 *
 * Every run reports CPU-seconds and peak RSS per process role beside the latency (spec D1), so
 * "faster" and "cheaper" stop being the same number.
 *
 * Run: pnpm --filter @feather-lite/load-test tier1 -- --concurrency 100 --ramp 5
 *      pnpm --filter @feather-lite/load-test tier1 -- --rate 30 --duration 300
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { harnessBypassConfigured, harnessJsonHeaders } from "./harness-http.js";
import { formatResourceReport, perCoreBudget, SERVER_CONTAINERS, SERVER_ROLES, startResourceSampler, validateReport } from "./resources.js";

/* ------------------------------- config ------------------------------- */

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};

const CONCURRENCY = Number(flag("concurrency", "10"));
const RAMP_SECONDS = Number(flag("ramp", "2"));
/** Open-loop arrival rate in *turns* per second (the script is 3 turns, so conversations/s is a third of it). */
const RATE = Number(flag("rate", "0"));
const DURATION_SECONDS = Number(flag("duration", "300"));
const MODE: "closed" | "soak" = RATE > 0 ? "soak" : "closed";
/** Appended to the report filename so runs at the same C but different server config stay distinct. */
const LABEL = flag("label", "");
const BASE = (process.env["LOAD_TEST_API"] ?? flag("api", "http://127.0.0.1:8080")).replace(/\/$/, "");
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5434/feather_lite";
const REPORT_DIR = fileURLToPath(new URL("../../../docs/loadtest/", import.meta.url));

/** The scripted conversation every virtual borrower drives to its natural outcome. */
const SCRIPT = ["yes this is Jordan", "I can pay 550 on Friday", "yes"] as const;

/** How many conversations this run will drive, in either mode. */
const CONVERSATIONS = MODE === "soak" ? Math.ceil((RATE / SCRIPT.length) * DURATION_SECONDS) : CONCURRENCY;

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
      headers: { ...harnessJsonHeaders(), accept: "text/event-stream" },
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
      headers: harnessJsonHeaders(),
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

console.log(
  MODE === "soak"
    ? `[tier1] api=${BASE} soak rate=${RATE} turns/s duration=${DURATION_SECONDS}s script=${SCRIPT.length} turns`
    : `[tier1] api=${BASE} concurrency=${CONCURRENCY} ramp=${RAMP_SECONDS}s script=${SCRIPT.length} turns`,
);

// Started before anything else so its first tick is taken with the server idle: that tick is the
// `idle_rss_tree` term of the per-core budget, and it has to be a real idle reading, not the
// reference scenario already running.
const sampler = startResourceSampler();
await sampler.awaitFirstSample();

const status = (await (await fetch(`${BASE}/api/system/status`)).json()) as { turn_decider: string; judge?: { enabled: boolean; model: string } };
if (status.turn_decider !== "scripted") {
  console.warn(`[tier1] WARNING: turn_decider=${status.turn_decider}. Latency will be dominated by the LLM and the run will cost money. Set TURN_DECIDER=scripted.`);
}
/**
 * Refuses to run against a server that would judge every conversation (O13).
 *
 * Cost discipline was documented and nothing enforced it: a C=50 run against a server with
 * `JUDGE_ENABLED=true` enqueues fifty reasoning-model calls, and the only sign is the bill. A
 * warning is not enough here, because the run is unattended by design and the money is spent by
 * the time anyone reads the log. `--allow-judge` is the deliberate override.
 */
// Fail closed, as D2 says: "refuses to start unless the server reports `judge.enabled=false`". A
// server that does not report judge state at all is an older or misconfigured one, and assuming it
// is cheap is the assumption that costs money.
if (status.judge?.enabled !== false && !process.argv.includes("--allow-judge")) {
  console.error(`[tier1] refusing to start: the server ${status.judge === undefined ? "does not report judge state" : `has the judge enabled (${status.judge.model})`}.`);
  console.error(`[tier1] a run of ${String(CONVERSATIONS)} conversations would enqueue that many reasoning-model calls.`);
  console.error(`[tier1] set JUDGE_ENABLED=false in the SERVER process env, or pass --allow-judge if you mean it.`);
  process.exit(2);
}

// The reference outcome comes from the scenario suite, not from a constant in this file.
const refRes = await fetch(`${BASE}/api/testing/scenarios/happy-path-promise-to-pay/run`, { method: "POST", headers: harnessJsonHeaders() });
if (!refRes.ok) throw new Error(`reference scenario failed: ${refRes.status} ${await refRes.text()}`);
const reference = (await refRes.json()) as { passed: boolean; actual_state_path: string[]; actual_tools: string[]; final_outcome: string | null };
if (!reference.passed) throw new Error("the reference scenario did not pass its own assertions; fix that before load testing");
console.log(`[tier1] reference outcome=${String(reference.final_outcome)} states=${reference.actual_state_path.length} tools=${reference.actual_tools.join(",")}`);

/**
 * One borrower per conversation: a borrower may hold only one live conversation at a time, so a
 * soak that recycled them would measure the pre-call rule rejecting starts rather than the turn
 * path. Minted in batches because a soak needs thousands and one request for all of them is a
 * minutes-long transaction the server is not being asked to survive here.
 */
const prefix = `t1-${Date.now().toString(36)}`;
const fixtures: Array<{ borrower_id: string; contact_point_id: string }> = [];
for (let minted = 0; minted < CONVERSATIONS; ) {
  const batch = Math.min(500, CONVERSATIONS - minted);
  const res = await fetch(`${BASE}/api/demo/load-fixtures`, {
    method: "POST",
    headers: harnessJsonHeaders(),
    body: JSON.stringify({ count: batch, prefix: `${prefix}-${String(minted)}` }),
  });
  if (!res.ok) throw new Error(`load-fixtures ${res.status}: ${await res.text()}`);
  fixtures.push(...((await res.json()) as Array<{ borrower_id: string; contact_point_id: string }>));
  minted += batch;
}
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
const pgSampler = setInterval(() => {
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
pgSampler.unref();

/**
 * The statement ranking (spec D5b): what the run actually asked Postgres to do, per statement.
 *
 * This is the instrument the D5 round-trip work is measured with. "43 statements per turn" is a
 * count somebody made by reading code; `pg_stat_statements` is the same claim taken from the server,
 * and it makes each fix a delta on a named line rather than a wall-clock difference that could be
 * anything.
 *
 * Reset immediately before the load starts so the numbers describe this run and nothing else — the
 * migrations, the fixture minting and any console tab left open all execute statements too.
 */
interface StatementStat {
  readonly query: string;
  readonly calls: number;
  readonly total_ms: number;
  readonly mean_ms: number;
  readonly rows: number;
}
interface StatementReport {
  readonly available: boolean;
  readonly note?: string;
  readonly total_calls?: number;
  readonly total_ms?: number;
  readonly top_by_total_time?: ReadonlyArray<StatementStat>;
  readonly top_by_calls?: ReadonlyArray<StatementStat>;
}
const resetStatements = async (): Promise<boolean> => {
  try {
    await sql`SELECT pg_stat_statements_reset()`;
    return true;
  } catch {
    return false;
  }
};
const readStatements = async (available: boolean): Promise<StatementReport> => {
  if (!available) {
    return {
      available: false,
      note: "pg_stat_statements is not loaded. Add `-c shared_preload_libraries=pg_stat_statements` to the Postgres command and restart it; migration 0005 creates the extension.",
    };
  }
  try {
    const rows = await sql<Array<{ query: string; calls: string; total_ms: string; mean_ms: string; rows: string }>>`
      SELECT query,
             calls::text            AS calls,
             total_exec_time::text  AS total_ms,
             mean_exec_time::text   AS mean_ms,
             rows::text             AS rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC`;
    // One line per statement, trimmed: the shape is what identifies it, not the whitespace the
    // query builder emitted.
    const norm = (r: (typeof rows)[number]): StatementStat => ({
      query: r.query.replace(/\s+/g, " ").trim().slice(0, 220),
      calls: Number(r.calls),
      total_ms: Math.round(Number(r.total_ms) * 100) / 100,
      mean_ms: Math.round(Number(r.mean_ms) * 1000) / 1000,
      rows: Number(r.rows),
    });
    const all = rows.map(norm);
    return {
      available: true,
      total_calls: all.reduce((a, r) => a + r.calls, 0),
      total_ms: Math.round(all.reduce((a, r) => a + r.total_ms, 0) * 100) / 100,
      top_by_total_time: all.slice(0, 10),
      top_by_calls: [...all].sort((a, b) => b.calls - a.calls).slice(0, 10),
    };
  } catch (e) {
    return { available: false, note: `pg_stat_statements read failed: ${String(e)}` };
  }
};

/**
 * Whether migration 0005's other half worked (spec D5b; review §3).
 *
 * `fillfactor = 80` was set so the per-turn updates — the `active_turn_id` claim and release on
 * `conversations`, the `result` merge on `conversation_turns` — become **heap-only tuple** updates
 * that touch no index at all. The migration's own comment names the number to watch
 * (`n_tup_hot_upd / n_tup_upd > 0.9`) and nothing has ever reported it, so the claim has been
 * unverified since it was written.
 *
 * Taken as a **delta across the run**, not as the table's lifetime total, because the migration
 * only changes pages written from now on: a table whose history is pre-fillfactor would otherwise
 * drag the ratio down for ever. `n_dead_tup` is the absolute reading afterwards, since that is a
 * "how much is autovacuum behind right now" question, not a rate.
 */
/** The four write-heavy tables migration 0005 tuned; keep in step with its `ALTER TABLE` loop. */
const HOT_TABLES = ["conversations", "conversation_turns", "outbox_jobs", "scheduled_actions"] as const;
interface TableWrites {
  readonly n_tup_upd: number;
  readonly n_tup_hot_upd: number;
  readonly n_dead_tup: number;
  readonly n_live_tup: number;
}
type TableWriteMap = Readonly<Record<string, TableWrites>>;
const readTableWrites = async (): Promise<TableWriteMap | null> => {
  try {
    const rows = await sql<Array<{ relname: string; n_tup_upd: string; n_tup_hot_upd: string; n_dead_tup: string; n_live_tup: string }>>`
      SELECT relname,
             n_tup_upd::text     AS n_tup_upd,
             n_tup_hot_upd::text AS n_tup_hot_upd,
             n_dead_tup::text    AS n_dead_tup,
             n_live_tup::text    AS n_live_tup
      FROM pg_stat_user_tables
      WHERE relname = ANY(${[...HOT_TABLES]})`;
    return Object.fromEntries(
      rows.map((r) => [r.relname, { n_tup_upd: Number(r.n_tup_upd), n_tup_hot_upd: Number(r.n_tup_hot_upd), n_dead_tup: Number(r.n_dead_tup), n_live_tup: Number(r.n_live_tup) }]),
    );
  } catch {
    return null;
  }
};
interface HotRow {
  readonly table: string;
  readonly updates: number;
  readonly hot_updates: number;
  /** `null` when the run did not update the table at all — a ratio of nothing is not 0. */
  readonly hot_ratio: number | null;
  readonly dead_tuples: number;
  readonly live_tuples: number;
}
const hotReport = (before: TableWriteMap | null, after: TableWriteMap | null): ReadonlyArray<HotRow> | null => {
  if (!before || !after) return null;
  return HOT_TABLES.flatMap((table) => {
    const a = after[table];
    if (!a) return [];
    const b = before[table] ?? { n_tup_upd: 0, n_tup_hot_upd: 0, n_dead_tup: 0, n_live_tup: 0 };
    const updates = a.n_tup_upd - b.n_tup_upd;
    const hot = a.n_tup_hot_upd - b.n_tup_hot_upd;
    return [{ table, updates, hot_updates: hot, hot_ratio: updates > 0 ? Math.round((hot / updates) * 1000) / 1000 : null, dead_tuples: a.n_dead_tup, live_tuples: a.n_live_tup }];
  });
};

/**
 * Wait for the previous run's post-call work to finish before starting this one.
 *
 * Each C=100 run leaves 300 outbox jobs behind, and the loop claims 20 every 5 seconds — 75 seconds
 * of summary, evaluation and vector-index work. Start the next run inside that window and the
 * server is serving turns *and* draining the last run, on the same event loop and the same pool.
 *
 * Found by measurement, not reasoning: two C=100 runs three minutes apart reported 80.5 and 69.8
 * turns/s while the database time between them **fell** 1 521 -> 921 ms. Wall clock was measuring
 * the backlog. This is very likely also what made the five Phase-0 C=100 runs disagree with each
 * other, and it is the kind of thing that would have been blamed on the change under test.
 */
const outboxPending = async (): Promise<number> => {
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM outbox_jobs WHERE status = 'PENDING'`;
  return Number(row?.n ?? 0);
};
const DRAIN_TIMEOUT_MS = 180_000;
const drainStart = Date.now();
let pending = await outboxPending();
const pendingAtArrival = pending;
if (pending > 0) console.log(`[tier1] waiting for ${String(pending)} outbox job(s) from an earlier run to drain...`);
while (pending > 0 && Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
  await sleep(2000);
  pending = await outboxPending();
}
if (pending > 0) console.log(`[tier1] ${String(pending)} outbox job(s) still pending after ${String(Math.round((Date.now() - drainStart) / 1000))}s; measuring anyway, and the report says so`);
else if (pendingAtArrival > 0) console.log(`[tier1] outbox drained in ${String(Math.round((Date.now() - drainStart) / 1000))}s`);

const statementsAvailable = await resetStatements();
if (!statementsAvailable) console.log("[tier1] pg_stat_statements is not loaded; the report will carry no statement ranking (see docs/loadtest/README.md)");
const tableWritesBefore = await readTableWrites();

/**
 * Open-loop arrival: a conversation is launched every `SCRIPT.length / RATE` seconds and the loop
 * does not wait for it. If the server falls behind, in-flight work piles up — which is the finding,
 * not a failure of the harness. The cap exists only so a genuinely wedged server cannot turn the
 * soak into an OOM on the harness side; hitting it is recorded, never silently absorbed.
 */
const MAX_IN_FLIGHT = 4000;
const soak = { launched: 0, inFlightPeak: 0, capHits: 0, firstAt: 0, lastAt: 0 };
const runOpenLoop = async (): Promise<ConversationRun[]> => {
  const gapMs = (SCRIPT.length / RATE) * 1000;
  const settled: ConversationRun[] = [];
  const inFlight = new Set<Promise<void>>();
  const openedAt = Date.now();
  const deadline = openedAt + DURATION_SECONDS * 1000;
  for (let i = 0; i < fixtures.length && Date.now() < deadline; i++) {
    if (inFlight.size >= MAX_IN_FLIGHT) {
      soak.capHits += 1;
      await Promise.race(inFlight);
    }
    // Sleep to the *scheduled* arrival, not for a fixed gap: a fixed gap accumulates every tick of
    // timer drift and quietly turns a 30/s soak into a 27/s one.
    const ahead = openedAt + i * gapMs - Date.now();
    if (ahead > 0) await sleep(ahead);
    if (soak.firstAt === 0) soak.firstAt = Date.now();
    soak.lastAt = Date.now();
    soak.launched += 1;
    const p = runConversation(i, fixtures[i]!).then((r) => {
      settled.push(r);
      inFlight.delete(p);
    });
    inFlight.add(p);
    soak.inFlightPeak = Math.max(soak.inFlightPeak, inFlight.size);
    if (soak.launched % 100 === 0) console.log(`[tier1] soak +${((Date.now() - soak.firstAt) / 1000).toFixed(0)}s launched=${soak.launched} in-flight=${inFlight.size} done=${settled.length}`);
  }
  console.log(`[tier1] arrivals done (${soak.launched}); draining ${inFlight.size} in flight...`);
  await Promise.all([...inFlight]);
  return settled;
};

// From here on the CPU belongs to the load, not to minting fixtures or running the reference.
sampler.mark();
const wallStart = Date.now();
const runs =
  MODE === "soak"
    ? await runOpenLoop()
    : await Promise.all(
        fixtures.map(async (f, i) => {
          if (RAMP_SECONDS > 0) await sleep(Math.floor((i / Math.max(1, fixtures.length)) * RAMP_SECONDS * 1000));
          return runConversation(i, f);
        }),
      );
const wallMs = Date.now() - wallStart;
clearInterval(pgSampler);
const statements = await readStatements(statementsAvailable);
const hotRows = hotReport(tableWritesBefore, await readTableWrites());

/* ------------------------- correctness assertions ---------------------- */

interface Verdict {
  readonly index: number;
  readonly conversationId: string | null;
  readonly correct: boolean;
  readonly failures: ReadonlyArray<string>;
}

// The resource numbers belong to the load, not to the verification sweep that follows it, so the
// sampler is stopped here — before thousands of detail fetches make the server look busy again.
const resources = await sampler.stop();

const verdictFor = async (run: ConversationRun): Promise<Verdict> => {
  const failures: string[] = [];
  if (!run.conversationId) return { index: run.index, conversationId: null, correct: false, failures: [`start failed: ${run.startError ?? "unknown"}`] };
  const detailRes = await fetch(`${BASE}/api/conversations/${run.conversationId}`, { headers: harnessJsonHeaders() });
  if (!detailRes.ok) return { index: run.index, conversationId: run.conversationId, correct: false, failures: [`detail ${detailRes.status}`] };
  const detail = (await detailRes.json()) as {
    conversation?: { final_outcome: string | null };
    event_timeline?: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  // Correctness is the gate, so an unexpected response shape has to fail loudly — silently
  // comparing two empty arrays would report a clean run over a broken one.
  if (!detail.conversation || !Array.isArray(detail.event_timeline)) {
    return { index: run.index, conversationId: run.conversationId, correct: false, failures: [`unexpected detail shape (keys: ${Object.keys(detail).join(", ")})`] };
  }
  const statePath = detail.event_timeline.filter((e) => e.type === "STATE_TRANSITION").map((e) => String(e.payload["to"]));
  const tools = detail.event_timeline.filter((e) => e.type === "TOOL_CALLED").map((e) => String(e.payload["name"]));
  if (JSON.stringify(statePath) !== JSON.stringify(reference.actual_state_path)) failures.push(`state path ${JSON.stringify(statePath)}`);
  if (JSON.stringify(tools) !== JSON.stringify(reference.actual_tools)) failures.push(`tools ${JSON.stringify(tools)}`);
  if (detail.conversation.final_outcome !== reference.final_outcome) failures.push(`outcome ${String(detail.conversation.final_outcome)}`);
  return { index: run.index, conversationId: run.conversationId, correct: failures.length === 0, failures };
};

// Every conversation is checked, including a soak's thousands; eight at a time so the sweep itself
// is not a second load test.
const verdicts: Verdict[] = [];
{
  const queue = [...runs];
  const worker = async () => {
    for (let run = queue.shift(); run !== undefined; run = queue.shift()) verdicts.push(await verdictFor(run));
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  verdicts.sort((a, b) => a.index - b.index);
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

const throughput = Number((okTurns.length / (wallMs / 1000)).toFixed(2));
// `containers` is the fallback for a `--profile app` run, where the server is not a host process.
const budget = perCoreBudget(resources, { roles: SERVER_ROLES, containers: SERVER_CONTAINERS, turnsPerSecond: throughput, turns: okTurns.length });
const achievedRate = MODE === "soak" && soak.lastAt > soak.firstAt ? Number((((soak.launched - 1) * SCRIPT.length) / ((soak.lastAt - soak.firstAt) / 1000)).toFixed(1)) : null;

console.log("");
console.log(
  MODE === "soak"
    ? `  soak                   ${RATE} turns/s target, ${achievedRate ?? "?"} achieved arrival, ${DURATION_SECONDS}s`
    : `  concurrency            ${CONCURRENCY}`,
);
if (MODE === "soak") console.log(`  in-flight peak         ${soak.inFlightPeak}${soak.capHits > 0 ? `  (arrival throttled ${soak.capHits}x at the ${MAX_IN_FLIGHT} cap)` : ""}`);
console.log(`  wall clock             ${(wallMs / 1000).toFixed(1)}s${MODE === "closed" ? ` (ramp ${RAMP_SECONDS}s)` : ""}`);
console.log(`  conversations correct  ${correct}/${runs.length}`);
console.log(`  turns ok / attempted   ${okTurns.length}/${allTurns.length}`);
console.log(`  throughput             ${throughput.toFixed(1)} turns/s`);
console.log(`  start   p50/p95/p99    ${starts.p50} / ${starts.p95} / ${starts.p99} ms`);
console.log(`  TTFT    p50/p95/p99    ${ttft.p50} / ${ttft.p95} / ${ttft.p99} ms  (max ${ttft.max})`);
console.log(`  turn    p50/p95/p99    ${wall.p50} / ${wall.p95} / ${wall.p99} ms  (max ${wall.max})`);
console.log(`  turn errors by status  ${errorsByStatus.size ? [...errorsByStatus].map(([s, n]) => `${s}:${n}`).join(" ") : "none"}`);
console.log(`  start errors           ${startErrors.length}`);
/**
 * A run that the server's own middleware shed is not a measurement of the server, and the failure
 * is silent otherwise: the correctness count simply drops and the report reads like a regression.
 *
 * `RATE_LIMIT_BYPASS_TOKEN`, set on both sides, exempts the harness (O9) — which is better than the
 * old advice of raising the budgets in the server's environment, because that measures a server
 * configured differently from the one being described.
 */
const rateLimited = (errorsByStatus.get(429) ?? 0) + startErrors.filter((e) => e.startsWith("429")).length;
if (rateLimited > 0) {
  console.log(`  !! rate limited        ${rateLimited} request(s) were 429ed by this server's own per-IP limiter.`);
  console.log(
    harnessBypassConfigured()
      ? `                         RATE_LIMIT_BYPASS_TOKEN is set here but the server did not honour it —`
      : `                         Set RATE_LIMIT_BYPASS_TOKEN to the same value in this process and the`,
  );
  console.log(
    harnessBypassConfigured()
      ? `                         check it is the same value in the SERVER process env. Not a baseline.`
      : `                         SERVER process env. This run is not a baseline.`,
  );
}
console.log(`  pg at peak             ${pg.peak ? `${pg.peak.backends} backends, ${pg.peak.active} active, ${pg.peak.idleInTransaction} idle-in-tx, ${pg.peak.waiting} lock-waiting (${pg.peak.samples} samples)` : "(not captured)"}`);
if (statements.available && statements.top_by_total_time) {
  const perTurn = okTurns.length > 0 ? (statements.total_calls ?? 0) / okTurns.length : 0;
  console.log(`  pg statements          ${String(statements.total_calls ?? 0)} calls / ${String(statements.total_ms ?? 0)} ms total, ${perTurn.toFixed(1)} statements per completed turn`);
  console.log(`    top by total time`);
  for (const r of statements.top_by_total_time.slice(0, 8)) {
    console.log(`      ${String(r.total_ms).padStart(9)} ms  ${String(r.calls).padStart(7)}x  ${r.mean_ms.toFixed(3)} ms  ${r.query.slice(0, 90)}`);
  }
} else if (statements.note) {
  console.log(`  pg statements          ${statements.note}`);
}
if (hotRows) {
  // Migration 0005's fillfactor claim, per table, over this run's own writes.
  const shown = hotRows.filter((r) => r.updates > 0);
  console.log(`  pg HOT updates         ${shown.length === 0 ? "(no updates in this run)" : ""}`);
  for (const r of shown) {
    console.log(`      ${r.table.padEnd(20)} ${String(r.hot_updates).padStart(7)}/${String(r.updates).padEnd(7)} HOT (${((r.hot_ratio ?? 0) * 100).toFixed(1)}%, target > 90%), ${String(r.dead_tuples)} dead of ${String(r.live_tuples)} live`);
  }
}
if (startErrors.length) console.log(`  first start error      ${startErrors[0]}`);
for (const v of verdicts.filter((x) => !x.correct).slice(0, 10)) console.log(`  INCORRECT #${v.index} ${v.conversationId ?? "-"}: ${v.failures.join("; ")}`);
console.log(formatResourceReport(resources, budget));
console.log("");

const report = {
  tier: "1-control-plane",
  api: BASE,
  label: LABEL || null,
  mode: MODE,
  concurrency: MODE === "closed" ? CONCURRENCY : null,
  ramp_seconds: MODE === "closed" ? RAMP_SECONDS : null,
  soak:
    MODE === "soak"
      ? {
          rate_target_turns_per_second: RATE,
          rate_achieved_turns_per_second: achievedRate,
          duration_seconds: DURATION_SECONDS,
          launched: soak.launched,
          in_flight_peak: soak.inFlightPeak,
          arrival_cap_hits: soak.capHits,
          arrival_cap: MAX_IN_FLIGHT,
        }
      : null,
  turn_decider: status.turn_decider,
  script: SCRIPT,
  wall_ms: wallMs,
  conversations: { total: runs.length, correct, incorrect: runs.length - correct },
  turns: { attempted: allTurns.length, ok: okTurns.length, throughput_per_second: throughput },
  latency_ms: { start: starts, ttft, turn_wall: wall },
  errors: { by_status: Object.fromEntries(errorsByStatus), start_errors: startErrors.slice(0, 20), rate_limited: rateLimited, rate_limit_bypass: harnessBypassConfigured() },
  pg_at_peak: pg.peak,
  /**
   * The outbox backlog this run started against. Non-zero means the server was draining an earlier
   * run's post-call work while serving this one, and the wall-clock numbers are not comparable.
   */
  outbox_pending_at_start: pending,
  /** What this run asked Postgres to do, per statement (D5b). The denominator of every D5 claim. */
  pg_statements: { ...statements, per_completed_turn: okTurns.length > 0 ? Math.round(((statements.total_calls ?? 0) / okTurns.length) * 100) / 100 : null },
  /**
   * Migration 0005's `fillfactor = 80` claim, checked (D5b): the share of this run's updates that
   * were heap-only, per table, with the dead-tuple backlog autovacuum was carrying at the end.
   */
  pg_hot_updates: hotRows,
  resources,
  per_core: budget,
  reference: { state_path: reference.actual_state_path, tools: reference.actual_tools, final_outcome: reference.final_outcome },
  incorrect: verdicts.filter((v) => !v.correct).map((v) => ({ index: v.index, conversation_id: v.conversationId, failures: v.failures })),
};
// A report without its resources block looks like a measurement and is not; the next phase would
// cite it. Fail the run rather than write one.
const reportProblems = validateReport(report);
if (reportProblems.length > 0) throw new Error(`report is not a valid measurement: ${reportProblems.join("; ")}`);
mkdirSync(REPORT_DIR, { recursive: true });
const stem = MODE === "soak" ? `soak-r${RATE}-d${DURATION_SECONDS}` : `c${CONCURRENCY}`;
const path = `${REPORT_DIR}${new Date().toISOString().slice(0, 10)}-tier1-${stem}${LABEL ? `-${LABEL}` : ""}.json`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[tier1] report written: ${path}`);

await sql.end();
process.exit(correct === runs.length && runs.length > 0 ? 0 : 1);
