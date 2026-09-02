/**
 * A voice re-dial needs somewhere to dial (C4).
 *
 * `prepare` checked `hasMediaPlane` — is there a LiveKit at all — and then dispatched the retry in
 * `sip` mode. But the SIP trunk is worker-side configuration the control plane never saw, so on the
 * self-hosted profile, which has no trunk, the loop ran like this: the retry is scheduled, a
 * conversation and a room are created, an agent is dispatched, the worker finds no trunk and hangs
 * up `sip_not_configured`, the call finalizes `NO_ANSWER`, and `NO_ANSWER` schedules another retry.
 * Round and round to the 7-in-7 cap, each lap taking a room, a dispatch and a worker job slot that
 * counts against `WORKER_MAX_JOBS` — so a fleet run sharing the box loses capacity to calls that
 * never had anywhere to go. Observed live on 2026-09-02: 55 done and 26 pending `RETRY_CALL` rows,
 * and `sip_not_configured` in the worker log about every four minutes.
 *
 * The media plane and the ability to dial out are two different questions, and this asserts the
 * second is now asked before anything is written.
 */
import { DateTime, Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationRepo,
  CrmRepo,
  IdGen,
  NO_SIP_TRUNK,
  Queries,
  SchedulingRepo,
  SchedulingService,
  ScriptedTurnDeciderLive,
  withFrozenClock,
  WorkflowService,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

/** A media plane exists. Whether it can place an outbound call is the separate question. */
const LIVEKIT = { url: "ws://localhost:7880", apiKey: "devkey", apiSecret: Redacted.make("secret"), agentName: "feather-lite-agent" };

const services = Layer.mergeAll(
  SchedulingService.Default,
  WorkflowService.Default,
  Queries.Default,
  ConversationRepo.Default,
  CrmRepo.Default,
  SchedulingRepo.Default,
  IdGen.Default,
);

/** A media plane, and no SIP trunk — the self-hosted profile this repo actually runs. */
const noTrunk = makeRuntime(services.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer({ livekit: { ...LIVEKIT, sipOutboundTrunkId: null } }))));

let phone = 8000;
const seedRetry = (name: string, channel: "voice" | "simulated") =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    const loanId = yield* ids.next();
    const wfId = yield* ids.next();
    phone += 1;
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555000${phone}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: loanId, borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    yield* sql`INSERT INTO workflow_executions ${sql.insert({ id: wfId, borrowerId, loanId, workflowType: "PAYMENT_REMINDER", status: "RUNNING" })}`;
    const actionId = yield* ids.next();
    yield* (yield* SchedulingRepo).insertScheduledAction({
      id: actionId,
      workflowExecutionId: wfId,
      actionType: "RETRY_CALL",
      dueAt: DateTime.toDateUtc(NOW),
      payload: { borrower_id: borrowerId, contact_point_id: cpId, channel, reason: "no_answer" },
    });
    return { actionId, borrowerId };
  });

/** Conversations opened for this borrower — the row a failed re-dial must not leave behind. */
const conversationsFor = (borrowerId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<{ readonly id: string }>`SELECT id FROM conversations WHERE borrower_id = ${borrowerId}`;
  });

beforeAll(async () => {
  await noTrunk.runPromise(truncateAll);
});
afterAll(async () => {
  await noTrunk.dispose();
});

describe("a scheduled voice re-dial with no SIP trunk", () => {
  it("settles FAILED and leaves no conversation behind", async () => {
    const out = await noTrunk.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { actionId, borrowerId } = yield* seedRetry("No Trunk Person", "voice");
          const results = yield* (yield* SchedulingService).runOnce(20, NOW);
          const action = yield* (yield* SchedulingRepo).findScheduledAction(actionId);
          const sql = yield* PgClient.PgClient;
          const attempts = yield* sql<{ readonly id: string }>`
            SELECT a.id FROM call_attempts a
            JOIN workflow_executions w ON w.id = a.workflow_execution_id
            WHERE w.borrower_id = ${borrowerId}`;
          return { results, conversations: yield* conversationsFor(borrowerId), attempts, action };
        }),
      ),
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.status).toBe("FAILED");
    expect(out.results[0]?.detail).toMatchObject({ reason: NO_SIP_TRUNK });
    // The whole point: the guard runs before `startCall`, so nothing is written that the sweeper
    // will later book as an orphaned call, and the funnel does not count an attempt that was never
    // placed. Without the guard the run gets as far as `DISPATCH_FAILED`, which is after both rows.
    expect(out.conversations).toHaveLength(0);
    expect(out.attempts).toHaveLength(0);
  });

  it("does not reschedule itself, so the loop stops", async () => {
    const out = await noTrunk.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { borrowerId } = yield* seedRetry("Loop Stopper", "voice");
          const sql = yield* PgClient.PgClient;
          yield* (yield* SchedulingService).runOnce(20, NOW);
          return yield* sql<{ readonly status: string }>`
            SELECT a.status FROM scheduled_actions a
            JOIN workflow_executions w ON w.id = a.workflow_execution_id
            WHERE w.borrower_id = ${borrowerId}`;
        }),
      ),
    );
    // One row, terminal. Not a PENDING one waiting to do it all again.
    expect(out.map((r) => r.status)).toEqual(["FAILED"]);
  });

  it("still runs a simulated re-dial, which needs no trunk at all", async () => {
    const out = await noTrunk.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { borrowerId } = yield* seedRetry("Simulated Person", "simulated");
          const results = yield* (yield* SchedulingService).runOnce(20, NOW);
          return { results, conversations: yield* conversationsFor(borrowerId) };
        }),
      ),
    );
    expect(out.results[0]?.status).toBe("DONE");
    expect(out.conversations).toHaveLength(1);
  });
});
