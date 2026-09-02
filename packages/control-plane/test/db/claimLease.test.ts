/**
 * A claim is a lease, not a transfer of ownership (C3).
 *
 * `CLAIMED` was written by both claim statements and read by nothing, and `claimed_at` was written
 * and never read. So a process that died between claiming and finishing — a SIGKILL, an OOM, a
 * container replaced mid-drain — left its rows `CLAIMED` forever: no SUMMARY, so the next call to
 * that borrower loses its `wrap_up`; no EVALUATION and no judge, so the call is invisible to
 * quality; and a scheduled callback that simply never happens. None of it raises anything, because
 * a stuck row and a row in flight look identical.
 *
 * The claim now takes a lease: a row whose claim is older than `CLAIM_LEASE_MS` is claimable
 * again, and the reclaim bumps `retry_count` so a process that dies on the same row repeatedly is
 * visible as a count rather than as silence.
 *
 * The "dead process" is simulated by claiming through the repo and never finishing — which is
 * exactly the state a killed drain leaves behind — and time is moved with the `nowOverride` both
 * tick functions already take for tests.
 */
import { DateTime, Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAIM_LEASE_MS,
  ConversationRepo,
  CrmRepo,
  IdGen,
  Orchestrator,
  OutboxService,
  Queries,
  RecordingLlmClient,
  RECLAIM_BUDGET_EXHAUSTED,
  SchedulingRepo,
  SchedulingService,
  Scores,
  ScoresRepo,
  ScriptedTurnDeciderLive,
  withFrozenClock,
  WorkflowService,
  type LlmDelta,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = Layer.mergeAll(
  Orchestrator.Default,
  WorkflowService.Default,
  OutboxService.Default,
  SchedulingService.Default,
  Queries.Default,
  Scores.Default,
  ScoresRepo.Default,
  ConversationRepo.Default,
  CrmRepo.Default,
  SchedulingRepo.Default,
  IdGen.Default,
).pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

/**
 * A second runtime whose judge is switched on and has nothing to answer with — this suite's way of
 * saying "the judge cannot be reached", borrowed from `judgeJob.test.ts`. It is the only cheap way
 * to get a job that genuinely *fails* rather than one that succeeds, which is what the
 * reclaim-then-failure case needs.
 */
const failingJudge = RecordingLlmClient(
  (): ReadonlyArray<LlmDelta> => [],
  () => null,
);
const judgeRt = makeRuntime(
  Layer.mergeAll(
    Orchestrator.Default,
    WorkflowService.Default,
    OutboxService.Default,
    Queries.Default,
    Scores.Default,
    ScoresRepo.Default,
    ConversationRepo.Default,
    CrmRepo.Default,
    SchedulingRepo.Default,
    IdGen.Default,
  ).pipe(
    Layer.provide(ScriptedTurnDeciderLive),
    Layer.provide(failingJudge.layer),
    Layer.provideMerge(makeInfraLayer({ judge: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium", maxTokens: 4000 } })),
  ),
);

/** 14:00 UTC is 10:00 in America/New_York — inside the TCPA contact window. */
const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");
const afterLease = DateTime.addDuration(NOW, `${CLAIM_LEASE_MS + 60_000} millis`);
const withinLease = DateTime.addDuration(NOW, `${Math.floor(CLAIM_LEASE_MS / 2)} millis`);

const seedBorrower = (name: string, phone: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    const loanId = yield* ids.next();
    yield* sql`INSERT INTO loans ${sql.insert({ id: loanId, borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    return { borrowerId, cpId, loanId };
  });

/** A finished call with its post-call jobs enqueued, then abandoned mid-drain. */
const abandonedDrain = (name: string, phone: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name, phone);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: NOW });
    yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
    // The claim a process took and never came back from.
    const claimed = yield* (yield* SchedulingRepo).claimDueJobs({ now: DateTime.toDateUtc(NOW), limit: 20 });
    return { conversationId: started.conversationId, claimed };
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
  await judgeRt.dispose();
});

describe("an abandoned claim", () => {
  it("is not re-claimed while the lease is still running", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { conversationId, claimed } = yield* abandonedDrain("Still Running", "+15550005001");
          const again = yield* (yield* OutboxService).runOnce(20, withinLease);
          const jobs = yield* (yield* Queries).outboxJobsFor(conversationId);
          return { claimedCount: claimed.length, again: again.length, statuses: jobs.map((j) => j.status) };
        }),
      ),
    );
    expect(out.claimedCount).toBeGreaterThan(0);
    // Half a lease in, the rows still belong to the process that took them.
    expect(out.again).toBe(0);
    expect(out.statuses.every((s) => s === "CLAIMED")).toBe(true);
  });

  it("is re-claimed once the lease expires, and the reclaim is counted", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { conversationId, claimed } = yield* abandonedDrain("Dead Process", "+15550005002");
          // The tick that finds the corpse. It claims *and* processes, so the jobs finish.
          // The tick sweeps every expired claim in the database, including any left by an earlier
          // test, so the count that means something here is this conversation's own rows.
          const recovered = yield* (yield* OutboxService).runOnce(20, afterLease);
          const jobs = yield* (yield* Queries).outboxJobsFor(conversationId);
          const mine = new Set(jobs.map((j) => j.id));
          return {
            claimedCount: claimed.length,
            recovered: recovered.filter((r) => mine.has(r.jobId)).length,
            statuses: jobs.map((j) => j.status),
            retryCounts: jobs.map((j) => Number(j.payload["retry_count"] ?? 0)),
          };
        }),
      ),
    );
    expect(out.recovered).toBe(out.claimedCount);
    // The work actually got done, which is the point: no SUMMARY means the next call has no wrap_up.
    expect(out.statuses.every((s) => s === "DONE")).toBe(true);
    // A reclaim is not free: it says a process died on this row.
    expect(out.retryCounts.every((n) => n === 1)).toBe(true);
  });

  it("stops re-claiming a job that has lost a process every time it was tried", async () => {
    // The failure mode the lease introduces: before it, a stranded claim was inert; after it, a job
    // whose work reliably kills its process would come back every lease period forever. The claim's
    // own count is what bounds it, and the budget is spent purely on reclaims here — the failure
    // path never runs, because a process that dies never reaches a `catchAll`.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { conversationId } = yield* abandonedDrain("Poison Job", "+15550005004");
          const q = yield* Queries;
          const sched = yield* SchedulingRepo;
          // Three more dead processes, each a lease apart: claim, never finish.
          for (let i = 1; i <= 3; i++) {
            yield* sched.claimDueJobs({ now: DateTime.toDateUtc(DateTime.addDuration(NOW, `${(CLAIM_LEASE_MS + 60_000) * i} millis`)), limit: 20 });
          }
          const beforeTick = yield* q.outboxJobsFor(conversationId);
          // The tick after the budget is gone: the jobs are failed rather than run again.
          yield* (yield* OutboxService).runOnce(20, DateTime.addDuration(NOW, `${(CLAIM_LEASE_MS + 60_000) * 4} millis`));
          const jobs = yield* q.outboxJobsFor(conversationId);
          return {
            retryCountsBefore: beforeTick.map((j) => Number(j.payload["retry_count"] ?? 0)),
            statuses: jobs.map((j) => j.status),
            errors: jobs.map((j) => j.error),
          };
        }),
      ),
    );
    // Three reclaims, counted.
    expect(out.retryCountsBefore.every((n) => n === 3)).toBe(true);
    expect(out.statuses.every((s) => s === "FAILED")).toBe(true);
    // And it says why, rather than leaving an operator to infer it from a count.
    expect(out.errors.every((e) => e === RECLAIM_BUDGET_EXHAUSTED)).toBe(true);
  });

  it("counts a dead process and a failed attempt separately", async () => {
    // The two bumps are deliberate and they are not the same event. A reclaim says a process died
    // holding the row; the failure path says the work ran and raised. A job that suffered both has
    // had two bad attempts, and spends two of its budget for them.
    const out = await judgeRt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { borrowerId, cpId } = yield* seedBorrower("Crashed Then Failed", "+15550005005");
          const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: NOW });
          yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          const sched = yield* SchedulingRepo;
          // One dead process.
          yield* sched.claimDueJobs({ now: DateTime.toDateUtc(NOW), limit: 20 });
          // Then a tick that runs the work, where the judge cannot be reached.
          yield* (yield* OutboxService).runOnce(20, afterLease);
          const jobs = yield* (yield* Queries).outboxJobsFor(started.conversationId);
          const judge = jobs.find((j) => j.jobType === "JUDGE");
          return { retryCount: Number(judge?.payload["retry_count"] ?? 0), status: judge?.status };
        }),
      ),
    );
    // One for the crash, one for the failure.
    expect(out.retryCount).toBe(2);
    expect(out.status).toBe("PENDING");
  });

  it("re-claims a scheduled action whose worker died holding it", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { borrowerId, cpId, loanId } = yield* seedBorrower("Stranded Callback", "+15550005003");
          const sched = yield* SchedulingRepo;
          const ids = yield* IdGen;
          const sql = yield* PgClient.PgClient;
          const wfId = yield* ids.next();
          yield* sql`INSERT INTO workflow_executions ${sql.insert({ id: wfId, borrowerId, loanId, workflowType: "COLLECTIONS", status: "RUNNING" })}`;
          yield* sched.insertScheduledAction({
            id: yield* ids.next(),
            workflowExecutionId: wfId,
            actionType: "CALLBACK",
            dueAt: DateTime.toDateUtc(NOW),
            payload: { borrower_id: borrowerId, contact_point_id: cpId, channel: "simulated" },
          });
          // A worker claims it and dies.
          const first = yield* sched.claimDue({ now: DateTime.toDateUtc(NOW), limit: 20 });
          const withinLeaseClaim = yield* sched.claimDue({ now: DateTime.toDateUtc(withinLease), limit: 20 });
          const afterLeaseClaim = yield* sched.claimDue({ now: DateTime.toDateUtc(afterLease), limit: 20 });
          return { first: first.length, withinLease: withinLeaseClaim.length, afterLease: afterLeaseClaim.length };
        }),
      ),
    );
    expect(out.first).toBe(1);
    expect(out.withinLease).toBe(0);
    expect(out.afterLease).toBe(1);
  });
});

describe("the agents list ages out what has stopped reporting (P6)", () => {
  it("drops a heartbeat older than a day and keeps a recent one", async () => {
    /**
     * A `feather-lite-agent-container` row from 2026-08-28 was still listed on `/status` on
     * 2026-09-02, five days after that container last existed. `online` is computed from
     * `last_seen_at`, so it read `false` — correct, and still misleading: an operator scanning the
     * status page cannot tell a worker that died this minute from one retired last week, and the
     * list grows a row per name anyone ever ran.
     */
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sched = yield* SchedulingRepo;
        yield* sql`TRUNCATE agent_heartbeats`;
        const now = new Date();
        const old = new Date(now.getTime() - 26 * 60 * 60_000);
        yield* sql`INSERT INTO agent_heartbeats (agent_name, last_seen_at, meta) VALUES ('retired-container', ${old}, '{}'::jsonb), ('live-worker', ${now}, '{}'::jsonb)`;
        const beats = yield* sched.listHeartbeats();
        // camelCase: `transformResultNames: snakeToCamel` is on the client, and `Queries.heartbeats`
        // is what maps back to the wire shape.
        return beats.map((b) => b.agentName);
      }),
    );
    expect(out).toEqual(["live-worker"]);
  });
});
