/**
 * Concurrent turns (plan rev.2 R8): a second turn while one is in flight is rejected with
 * TurnInProgress unless it supersedes (barge-in), in which case the in-flight turn is marked
 * SUPERSEDED, a TURN_SUPERSEDED event is written, and its late commit is discarded.
 */
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

// A decider that blocks until released, so we can hold a turn "in flight".
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

        // Turn 1 starts and blocks in the decider (T1 committed, active_turn_id = t1).
        const fiber1 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "hello" }, emit(frames1)));
        // Wait until T1 has committed: the turn_start frame is emitted right after T1.
        let tries = 0;
        while (!(yield* Ref.get(frames1)).some((f) => f.type === "turn_start") && tries < 200) {
          tries++;
          yield* Effect.sleep("20 millis");
        }

        // Turn 2 without supersede -> TurnInProgress
        const rejected = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "wait" }, () => Effect.void).pipe(Effect.either);

        // Turn 3 with supersede (barge-in) -> takes over; also blocks in the decider until released.
        const frames3 = yield* Ref.make<TurnFrame[]>([]);
        const fiber3 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "actually yes this is Jordan", supersede: true }, emit(frames3)));
        tries = 0;
        while (!(yield* Ref.get(frames3)).some((f) => f.type === "turn_start") && tries < 200) {
          tries++;
          yield* Effect.sleep("20 millis");
        }
        // Release both deciders. t1's T2 must notice it is no longer the active turn.
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
    // t1 was superseded: no AGENT_TURN for it, an error frame instead of turn_end.
    expect(out.f1.some((f) => f.type === "error" && f.code === "SUPERSEDED")).toBe(true);
    expect(out.events.some((e) => e.type === "TURN_SUPERSEDED" && e.payload.turn_id === "t1" && e.payload.superseded_by === "t3")).toBe(true);
    expect(out.events.filter((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "t1")).toHaveLength(0);
    // t3 completed normally.
    expect(out.r3.turnId).toBe("t3");
    expect(out.events.some((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "t3")).toBe(true);
    expect(out.state).toBe("VERIFYING_IDENTITY");
  });
});
