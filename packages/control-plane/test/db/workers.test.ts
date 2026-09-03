import { DateTime, Effect, Layer, Option, Redacted } from "effect";
import { localIsoDate, nextLocalHour } from "@feather-lite/domain";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationRepo,
  IdGen,
  Orchestrator,
  OutboxService,
  Queries,
  SchedulingRepo,
  SchedulingService,
  ScriptedTurnDeciderLive,
  WorkflowService,
  withFrozenClock,
  FROZEN_NOW,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const services = Layer.mergeAll(
  Orchestrator.Default,
  WorkflowService.Default,
  SchedulingService.Default,
  OutboxService.Default,
  Queries.Default,
  ConversationRepo.Default,
  SchedulingRepo.Default,
  IdGen.Default,
).pipe(Layer.provide(ScriptedTurnDeciderLive));

const rt = makeRuntime(services.pipe(Layer.provideMerge(makeInfraLayer())));

/**
 * Port 1 refuses immediately, which is the "LiveKit exists and did not answer" case rather than the
 * "nothing is configured" one.
 */
const rtNoAnswer = makeRuntime(
  services.pipe(
    Layer.provideMerge(
      makeInfraLayer({ livekit: { url: "http://127.0.0.1:1", apiKey: "k", apiSecret: Redacted.make("s"), agentName: "feather-lite-agent", sipOutboundTrunkId: "trunk-for-the-dispatch-test" } }),
    ),
  ),
);

const seedBorrower = (name: string, tz: string, phone: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: tz, status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    return { borrowerId, cpId };
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
  await rtNoAnswer.dispose();
});

describe("scheduled-action worker", () => {
  it("re-dials a NO_ANSWER retry when due, reusing the workflow (attempt 2)", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Retry Person", "America/New_York", "+15550002001");
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const sched = yield* SchedulingService;
        const repo = yield* SchedulingRepo;
        const conv = yield* ConversationRepo;
        const first = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        yield* orch.processSignal(first.conversationId, { kind: "no_answer" });
        const pending = (yield* repo.listForWorkflow(first.workflowExecutionId)).filter((a) => a.status === "PENDING");
        const due = DateTime.unsafeMake(pending[0]!.dueAt);
        const nothing = yield* sched.runOnce(20, DateTime.subtract(due, { minutes: 1 }));
        const later = nextLocalHour(due, "America/New_York", 14);
        const processed = yield* sched.runOnce(20, later);
        const wfRow = yield* conv.findWorkflow(first.workflowExecutionId);
        return { pending, nothing, processed, wfRow };
      }),
    );
    expect(out.pending.map((a) => a.actionType)).toEqual(["RETRY_CALL"]);
    expect(out.nothing).toEqual([]);
    expect(out.processed).toHaveLength(1);
    expect(out.processed[0]?.status).toBe("DONE");
    expect(Option.isSome(out.wfRow) && out.wfRow.value.currentAttemptNo).toBe(2);
    expect(Option.isSome(out.wfRow) && out.wfRow.value.status).toBe("RUNNING");
  });

  it("fails a scheduled voice re-dial with no media plane instead of leaving a call nobody serves", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const { borrowerId, cpId } = yield* seedBorrower("Voice Retry Person", "America/New_York", "+15550002009");
          const ids = yield* IdGen;
          const repo = yield* SchedulingRepo;
          const sched = yield* SchedulingService;
          const orch = yield* Orchestrator;
          // The workflow and its attempt counter come from a real unanswered call rather than a
          // fixture.
          const first = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
          yield* orch.processSignal(first.conversationId, { kind: "no_answer" });
          const wfId = first.workflowExecutionId;
          for (const a of (yield* repo.listForWorkflow(wfId)).filter((x) => x.status === "PENDING")) {
            yield* repo.setActionStatus(a.id, "CANCELED", { canceled_reason: "test" });
          }
          const before = yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversations`;
          yield* repo.insertScheduledAction({
            id: yield* ids.next(),
            workflowExecutionId: wfId,
            actionType: "RETRY_CALL",
            dueAt: DateTime.toDateUtc(DateTime.subtract(FROZEN_NOW, { minutes: 1 })),
            payload: { borrower_id: borrowerId, contact_point_id: cpId, channel: "voice", reason: "no_answer" },
          });
          const processed = yield* sched.runOnce(20, FROZEN_NOW);
          const after = yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversations`;
          const actions = yield* repo.listForWorkflow(wfId);
          return { processed, before: Number(before[0]?.n ?? 0), after: Number(after[0]?.n ?? 0), actions };
      }),
    );

    expect(out.processed).toHaveLength(1);
    expect(out.processed[0]?.status).toBe("FAILED");
    expect(out.processed[0]?.detail).toMatchObject({ reason: "NO_MEDIA_PLANE" });
    expect(out.actions[0]?.status).toBe("FAILED");
    expect(out.after).toBe(out.before);
  });

  it("records a dispatch that the media plane refused, in a transaction of its own", async () => {
    // `dispatchAgent` is an HTTP call and must not be made under a lock, so the refusal is
    // recorded by a second, short transaction after the first has released the conversation row.
    const out = await rtNoAnswer.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const { borrowerId, cpId } = yield* seedBorrower("Refused Dispatch Person", "America/New_York", "+15550002011");
        const ids = yield* IdGen;
        const repo = yield* SchedulingRepo;
        const sched = yield* SchedulingService;
        const orch = yield* Orchestrator;
        const first = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
        yield* orch.processSignal(first.conversationId, { kind: "no_answer" });
        const wfId = first.workflowExecutionId;
        for (const a of (yield* repo.listForWorkflow(wfId)).filter((x) => x.status === "PENDING")) {
          yield* repo.setActionStatus(a.id, "CANCELED", { canceled_reason: "test" });
        }
        const before = yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversations`;
        yield* repo.insertScheduledAction({
          id: yield* ids.next(),
          workflowExecutionId: wfId,
          actionType: "RETRY_CALL",
          dueAt: DateTime.toDateUtc(DateTime.subtract(FROZEN_NOW, { minutes: 1 })),
          payload: { borrower_id: borrowerId, contact_point_id: cpId, channel: "voice", reason: "no_answer" },
        });
        const processed = yield* sched.runOnce(20, FROZEN_NOW);
        const after = yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversations`;
        const actions = yield* repo.listForWorkflow(wfId);
        return { processed, before: Number(before[0]?.n ?? 0), after: Number(after[0]?.n ?? 0), actions };
      }),
    );
    expect(out.processed).toHaveLength(1);
    expect(out.processed[0]?.status).toBe("FAILED");
    expect(out.processed[0]?.detail).toMatchObject({ reason: "DISPATCH_FAILED" });
    expect(out.actions.find((a) => a.status === "FAILED")?.payload["reason"]).toBe("DISPATCH_FAILED");
    // The conversation the first transaction opened is committed and left for the sweeper. That is
    // the deliberate difference from NO_MEDIA_PLANE, where nothing is written at all.
    expect(out.after).toBe(out.before + 1);
  });

  it("reschedules a callback that comes due outside the TCPA window to the next 08:00 local", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Night Owl", "America/Los_Angeles", "+15550002002");
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const sched = yield* SchedulingService;
        const repo = yield* SchedulingRepo;
        const first = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        yield* orch.processTurn({ conversationId: first.conversationId, turnId: "t1", userText: "yes speaking" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: first.conversationId, turnId: "t2", userText: "call me back tomorrow at 10pm" }, () => Effect.void);
        const cb = (yield* repo.listForWorkflow(first.workflowExecutionId)).find((a) => a.actionType === "CALLBACK");
        const at = DateTime.unsafeMake(cb!.dueAt);
        const processed = yield* sched.runOnce(20, at);
        const after = yield* repo.findScheduledAction(cb!.id);
        const realNow = yield* DateTime.now;
        const today = Option.getOrThrow(localIsoDate(realNow, "America/Los_Angeles"));
        return { cb, processed, after, today };
      }),
    );
    const [y, m, d] = out.today.split("-").map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    const expectedDue = DateTime.toDateUtc(DateTime.toUtc(Option.getOrThrow(DateTime.makeZoned({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hours: 22, minutes: 0 }, { timeZone: "America/Los_Angeles", adjustForTimeZone: true }))));
    expect(out.cb?.dueAt.toISOString()).toBe(expectedDue.toISOString()); // 22:00 PDT tomorrow
    expect(out.processed[0]?.status).toBe("RESCHEDULED");
    expect(Option.isSome(out.after) && out.after.value.status).toBe("PENDING");
    const expectedNext = DateTime.toDateUtc(nextLocalHour(DateTime.unsafeMake(expectedDue), "America/Los_Angeles", 8));
    expect(Option.isSome(out.after) && out.after.value.dueAt.toISOString()).toBe(expectedNext.toISOString()); // 08:00 PDT the day after
    expect(expectedNext.toISOString().slice(0, 10) > tomorrowIso).toBe(true);
    expect(Option.isSome(out.after) && out.after.value.payload["retry_count"]).toBe(1);
  });
});

describe("outbox worker", () => {
  it("processes SUMMARY / EVALUATION / VECTOR_INDEX for a completed call and records OUTBOX_PROCESSED", async () => {
    // 14:00 EDT == 23:30 IST -> outside window; 09:00Z == 14:30 IST is inside it.
    const FROZEN = DateTime.unsafeMake("2026-08-16T09:00:00Z");
    const out = await rt.runPromise(
      withFrozenClock(FROZEN)(Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Outbox Person", "Asia/Kolkata", "+919800002003");
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const outbox = yield* OutboxService;
        const q = yield* Queries;
        const first = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated" });
        yield* orch.processTurn({ conversationId: first.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
        const results = yield* outbox.runOnce(20);
        const again = yield* outbox.runOnce(20);
        const detail = yield* q.conversationDetail(first.conversationId);
        const jobs = yield* q.outboxJobsFor(first.conversationId);
        return { results, again, detail, jobs, frozen: DateTime.toDateUtc(FROZEN) };
      })),
    );
    expect(out.results.length).toBeGreaterThanOrEqual(3);
    expect(out.results.every((r) => r.status === "DONE")).toBe(true);
    expect(out.again).toEqual([]);
    expect(out.jobs.every((j) => j.status === "DONE")).toBe(true);
    const processed = out.detail.events.filter((e) => e.type === "OUTBOX_PROCESSED");
    expect(processed).toHaveLength(3);
    const evaluation = out.jobs.find((j) => j.jobType === "EVALUATION");
    expect(evaluation?.result["compliance_ok"]).toBe(true);
    // Every job must be stamped from the same instant the claim query asks about: a second clock
    // creeping in fails here rather than as "0 jobs claimed" three layers away.
    expect(out.jobs.map((j) => j.availableAt.toISOString())).toEqual(out.jobs.map(() => out.frozen.toISOString()));
  });
});
