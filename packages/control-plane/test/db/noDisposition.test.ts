import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, Queries, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

// Two turns first: `CONFIRMING_OUTCOME` is the only state a goodbye can legally close from.
const decider = StaticTurnDeciderLive((input) => {
  switch (input.turnId) {
    case "t1":
      return Stream.make(
        decision({ message: "", toolCall: { name: "confirm_right_party", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "DISCUSSING_PAYMENT" }),
      );
    case "t2":
      return Stream.make(
        decision({ message: "", toolCall: { name: "propose_promise_to_pay", args: { amount: "550.00", date: "2026-09-15" } }, intentSatisfied: true, suggestedNextState: "CONFIRMING_OUTCOME" }),
      );
    default:
      return Stream.make(decision({ message: "Thank you for your time. Goodbye.", toolCall: null, intentSatisfied: true, suggestedNextState: "ENDING" }));
  }
});

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(decider),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("a call the model closes without an outcome tool", () => {
  it("is recorded as NO_DISPOSITION, schedules no re-dial, and counts the attempt COMPLETED", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550010001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "actually never mind, goodbye" }, () => Effect.void);

        const row = yield* (yield* ConversationRepo).findConversation(started.conversationId);
        const retries = yield* sql<{ readonly action_type: string }>`
          SELECT a.action_type FROM scheduled_actions a
          JOIN workflow_executions w ON w.id = a.workflow_execution_id
          WHERE w.borrower_id = ${borrowerId}`;
        const attempts = yield* sql<{ readonly attemptStatus: string }>`
          SELECT a.attempt_status FROM call_attempts a
          JOIN workflow_executions w ON w.id = a.workflow_execution_id
          WHERE w.borrower_id = ${borrowerId}`;
        return { outcome: row._tag === "Some" ? row.value.finalOutcome : null, retries, attempts };
      }),
    );

    expect(out.outcome).toBe("NO_DISPOSITION");
    expect(out.retries).toHaveLength(0);
    expect(out.attempts.map((a) => a.attemptStatus)).toEqual(["COMPLETED"]);
  });
});
