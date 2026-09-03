import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import {
  ConversationRepo,
  IdGen,
  Orchestrator,
  Queries,
  StaticTurnDeciderLive,
  TurnInProgress,
  WorkflowService,
  FROZEN_NOW,
} from "../../src/index.js";
import type { TurnFrame } from "@feather-lite/contracts";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const gate = await Effect.runPromise(Deferred.make<void>());
const decider = StaticTurnDeciderLive((input) =>
  Stream.fromEffect(Deferred.await(gate)).pipe(
    Stream.flatMap(() =>
      Stream.make(
        decision({ message: `slow reply to ${input.userText}`, toolCall: null, intentSatisfied: false, suggestedNextState: "VERIFYING_IDENTITY" }),
      ),
    ),
  ),
);

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(decider),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

const seed = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550001111", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  const wf = yield* WorkflowService;
  return yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
});

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("concurrent turns", () => {
  it("rejects a second turn while one is in flight, then lets a barge-in supersede it", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        const frames1 = yield* Ref.make<TurnFrame[]>([]);
        const emit = (ref: Ref.Ref<TurnFrame[]>) => (f: TurnFrame) => Ref.update(ref, (xs) => [...xs, f]);

        const fiber1 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "hello" }, emit(frames1)));
        let tries = 0;
        while (!(yield* Ref.get(frames1)).some((f) => f.type === "turn_start") && tries < 200) {
          tries++;
          yield* Effect.sleep("20 millis");
        }

        const rejected = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "wait" }, () => Effect.void).pipe(Effect.either);

        const frames3 = yield* Ref.make<TurnFrame[]>([]);
        const fiber3 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "actually yes this is Jordan", supersede: true }, emit(frames3)));
        tries = 0;
        while (!(yield* Ref.get(frames3)).some((f) => f.type === "turn_start") && tries < 200) {
          tries++;
          yield* Effect.sleep("20 millis");
        }
        yield* Deferred.succeed(gate, void 0);
        const r1 = yield* Fiber.join(fiber1);
        const r3 = yield* Fiber.join(fiber3);
        const q = yield* Queries;
        const detail = yield* q.conversationDetail(started.conversationId);
        return { rejected, r1, r3, f1: yield* Ref.get(frames1), events: detail.events, state: detail.conversation.current_state };
      }),
    );
    expect(out.rejected._tag).toBe("Left");
    if (out.rejected._tag === "Left") expect(out.rejected.left).toBeInstanceOf(TurnInProgress);
    expect(out.f1.some((f) => f.type === "error" && f.code === "SUPERSEDED")).toBe(true);
    expect(out.events.some((e) => e.type === "TURN_SUPERSEDED" && e.payload.turn_id === "t1" && e.payload.superseded_by === "t3")).toBe(true);
    expect(out.events.filter((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "t1")).toHaveLength(0);
    expect(out.r3.turnId).toBe("t3");
    expect(out.events.some((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "t3")).toBe(true);
    expect(out.state).toBe("VERIFYING_IDENTITY");
  });
});
