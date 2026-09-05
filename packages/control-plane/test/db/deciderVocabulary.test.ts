/**
 * The call records which decider served it and each turn records what decided that turn. Two
 * vocabularies for one thing drift, so this pins the pair on a real call rather than in a comment.
 */
import { Effect, Layer, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, deciderSourceFor, IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const decider = StaticTurnDeciderLive((input) => Stream.make(decision({ message: "go on", toolCall: null, intentSatisfied: false, suggestedNextState: input.state })));

// `TURN_DECIDER=openai` is what the call records; the decider under test is static, because the
// question here is the two names for one arm and not what the model would have said.
const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(decider),
  Layer.provideMerge(makeInfraLayer({ turnDecider: "openai" })),
);
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("the decider vocabulary", () => {
  it("pairs the name on the call with the name on its turns", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550006601", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
        yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);

        const calls = yield* sql<{ readonly decider: string | null }>`SELECT decider FROM conversations WHERE id = ${started.conversationId}`;
        const turn = yield* (yield* ConversationRepo).findTurn({ conversationId: started.conversationId, turnId: "t1" });
        return {
          onTheCall: calls[0]?.decider ?? null,
          onTheTurn: Option.isSome(turn) ? ((turn.value.result as { disposition?: string; decider?: string } | null)?.decider ?? null) : null,
        };
      }),
    );

    expect(out.onTheCall).toBe("openai");
    expect(out.onTheTurn).toBe("model");
    // The pairing, not two literals that happen to be written down twice.
    expect(deciderSourceFor("openai")).toBe(out.onTheTurn);
  }, 30_000);

  it("uses one word for the scripted decider, because that arm has nothing to translate", () => {
    expect(deciderSourceFor("scripted")).toBe("scripted");
  });
});
