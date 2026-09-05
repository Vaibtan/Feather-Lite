/**
 * What the decider is told the borrower heard before they talked over the agent. Read from the
 * ledger, because the worker reports playout as a signal of its own rather than on the next turn.
 */
import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const heardByTurn = new Map<string, string | null>();
const decider = StaticTurnDeciderLive((input) => {
  heardByTurn.set(input.turnId, input.heardAgentText);
  return Stream.make(decision({ message: "go on", toolCall: null, intentSatisfied: false, suggestedNextState: input.state }));
});

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, ConversationRepo.Default, IdGen.Default).pipe(
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

let phone = 77000;
const startVoiceCall = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  phone += 1;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555${String(phone).padStart(7, "0")}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  return (yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW })).conversationId;
});

const reportPlayout = (conversationId: string, p: { turnId: string; segmentId: string; heardText: string; interrupted: boolean }) =>
  Effect.flatMap(Orchestrator, (orch) => orch.processSignal(conversationId, { kind: "playout", ...p }));

describe("the heard agent text the decider is given", () => {
  it("is the segment the borrower cut, not the last segment the turn reported", async () => {
    const heard = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* startVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "t1", userText: "hello" }, () => Effect.void);
        // The turn spoke twice: the borrower talked over the first segment, and the second played out.
        yield* reportPlayout(id, { turnId: "t1", segmentId: "cut", heardText: "Your balance is 550 dollars and", interrupted: true });
        yield* reportPlayout(id, { turnId: "t1", segmentId: "played", heardText: "Are you able to make a payment?", interrupted: false });
        yield* orch.processTurn({ conversationId: id, turnId: "t2", userText: "sorry, how much was that" }, () => Effect.void);
        return heardByTurn.get("t2") ?? null;
      }),
    );
    expect(heard).toBe("Your balance is 550 dollars and");
  });

  it("is null when nothing about that turn was cut short", async () => {
    const heard = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* startVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "u1", userText: "hello" }, () => Effect.void);
        yield* reportPlayout(id, { turnId: "u1", segmentId: "played", heardText: "Are you able to make a payment?", interrupted: false });
        yield* orch.processTurn({ conversationId: id, turnId: "u2", userText: "go on" }, () => Effect.void);
        return heardByTurn.get("u2") ?? null;
      }),
    );
    expect(heard).toBeNull();
  });
});
