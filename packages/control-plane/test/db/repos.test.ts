import { Effect, Layer, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepo, CrmRepo, SchedulingRepo } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = Layer.mergeAll(CrmRepo.Default, ConversationRepo.Default, SchedulingRepo.Default).pipe(
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("persistence layer against real Postgres", () => {
  it("migrates, inserts CRM rows with camel<->snake transforms, and reads them back typed", async () => {
    const result = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const crm = yield* CrmRepo;
        const borrowerId = uuid();
        const cpId = uuid();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15551230001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: uuid(), borrowerId, principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 })}`;
        const borrower = yield* crm.findBorrower(borrowerId);
        const loan = yield* crm.primaryLoanForBorrower(borrowerId);
        const link = yield* crm.findLink({ borrowerId, contactPointId: cpId });
        const version = yield* crm.ensureActiveAgentVersion(uuid(), "collections-v2", "bootstrap");
        return { borrower, loan, link, version };
      }),
    );
    expect(Option.isSome(result.borrower)).toBe(true);
    if (Option.isSome(result.borrower)) {
      expect(result.borrower.value.name).toBe("Jordan Avery");
      expect(result.borrower.value.preferredLanguage).toBe("en");
      expect(result.borrower.value.createdAt).toBeInstanceOf(Date);
    }
    expect(Option.isSome(result.loan)).toBe(true);
    if (Option.isSome(result.loan)) {
      expect(result.loan.value.balanceDue).toBe("550.00"); // numeric as string
      expect(result.loan.value.dueDate).toBe("2026-08-01"); // date as text
      expect(result.loan.value.lastPromiseDate).toBeNull();
    }
    expect(Option.isSome(result.link)).toBe(true);
    expect(result.version.status).toBe("ACTIVE");
  });

  it("appends events with a race-free monotonic sequence_no under the row lock", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const conv = yield* ConversationRepo;
        const crm = yield* CrmRepo;
        const borrowerId = uuid();
        const cpId = uuid();
        const loanId = uuid();
        const wfId = uuid();
        const attemptId = uuid();
        const convId = uuid();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Priya Nair", timezone: "Asia/Kolkata", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+919800000001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: loanId, borrowerId, principal: "5000.00", balanceDue: "300.00", dueDate: "2026-08-05", status: "DELINQUENT", delinquencyDays: 11 })}`;
        const version = yield* crm.ensureActiveAgentVersion(uuid(), "collections-v2", "bootstrap");
        yield* conv.insertWorkflow({ id: wfId, borrowerId, loanId, workflowType: "PAYMENT_REMINDER" });
        const { currentAttemptNo } = yield* conv.incrementAttemptNo(wfId);
        const now = new Date("2026-08-16T10:00:00Z");
        yield* conv.insertAttempt({ id: attemptId, workflowExecutionId: wfId, contactPointId: cpId, direction: "OUTBOUND", startedAt: now });
        yield* conv.insertConversation({ id: convId, callAttemptId: attemptId, borrowerId, agentVersionId: version.id, startedAt: now, channel: "simulated", origin: "simulated", decider: "scripted" });

        // 20 concurrent appends, each in its own transaction holding the row lock -> 1..20 with no gaps.
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* conv.lockConversation(convId);
                yield* conv.appendEvent({
                  id: uuid(),
                  conversationId: convId,
                  event: { type: "USER_TURN_FINAL", payload: { text: `turn ${i}` } },
                  createdAt: new Date(now.getTime() + i),
                });
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const events = yield* conv.listEvents(convId);
        const claimed1 = yield* conv.claimTurn(convId, "t1");
        const claimed2 = yield* conv.claimTurn(convId, "t2");
        yield* conv.releaseTurn(convId, "t1");
        const claimed3 = yield* conv.claimTurn(convId, "t3");
        const found = yield* conv.findConversation(convId);
        return { currentAttemptNo, events, claimed1, claimed2, claimed3, found };
      }),
    );
    expect(out.currentAttemptNo).toBe(1);
    expect(out.events.map((e) => e.sequence_no)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(out.events.every((e) => e.type === "USER_TURN_FINAL")).toBe(true);
    expect(out.claimed1).toBe(true);
    expect(out.claimed2).toBe(false); // CAS: second claim rejected
    expect(out.claimed3).toBe(true);
    expect(Option.isSome(out.found) && out.found.value.activeTurnId).toBe("t3");
  });

  it("claims due scheduled actions and outbox jobs with SKIP LOCKED, once each", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sched = yield* SchedulingRepo;
        const conv = yield* ConversationRepo;
        const crm = yield* CrmRepo;
        const borrowerId = uuid();
        const loanId = uuid();
        const wfId = uuid();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Sam Ortiz", timezone: "America/Chicago", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: loanId, borrowerId, principal: "1.00", balanceDue: "1.00", dueDate: "2026-08-01", status: "CURRENT", delinquencyDays: 0 })}`;
        yield* conv.insertWorkflow({ id: wfId, borrowerId, loanId, workflowType: "PAYMENT_REMINDER" });
        const cpId = uuid();
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15551230099", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        const version = yield* crm.ensureActiveAgentVersion(uuid(), "collections-v2", "bootstrap");
        const attemptId = uuid();
        const convId = uuid();
        yield* conv.insertAttempt({ id: attemptId, workflowExecutionId: wfId, contactPointId: cpId, direction: "OUTBOUND", startedAt: new Date() });
        yield* conv.insertConversation({ id: convId, callAttemptId: attemptId, borrowerId, agentVersionId: version.id, startedAt: new Date(), channel: "simulated", origin: "simulated", decider: "scripted" });

        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 3_600_000);
        yield* sched.insertScheduledAction({ id: uuid(), workflowExecutionId: wfId, actionType: "RETRY_CALL", dueAt: past, payload: { reason: "no_answer" } });
        yield* sched.insertScheduledAction({ id: uuid(), workflowExecutionId: wfId, actionType: "CALLBACK", dueAt: future, payload: {} });
        const conflicts = yield* sched.countPendingConflicts(borrowerId);
        const [claimA, claimB] = yield* Effect.all(
          [sched.claimDue({ now: new Date(), limit: 10 }), sched.claimDue({ now: new Date(), limit: 10 })],
          { concurrency: "unbounded" },
        );
        yield* sched.insertOutboxJob({ id: uuid(), conversationId: convId, jobType: "SUMMARY", availableAt: past });
        const jobs = yield* sched.claimDueJobs({ now: new Date(), limit: 10 });
        const jobsAgain = yield* sched.claimDueJobs({ now: new Date(), limit: 10 });
        const canceled = yield* sched.cancelPending({ workflowExecutionId: wfId, reason: "opt_out", actionTypes: null });
        return { conflicts: conflicts.count, claimA, claimB, jobs, jobsAgain, canceled };
      }),
    );
    expect(out.conflicts).toBe(1); // only the pending CALLBACK counts as a conflict
    expect(out.claimA.length + out.claimB.length).toBe(1); // the past-due RETRY claimed exactly once
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.status).toBe("CLAIMED");
    expect(out.jobsAgain).toHaveLength(0);
    expect(out.canceled).toBe(1); // only the future CALLBACK was still PENDING
  });
});
