/**
 * A turn re-sent under its own id while it is still running (C5).
 *
 * The voice worker re-sends a turn after a reconnect, and `TurnRunner` attaches such a request to
 * the copy already in flight — but only in this process, and only while the entry survives
 * (`TURN_MAX_LIFETIME_SECONDS`, 300 s). Past that, or from a second replica, the request reached
 * the orchestrator, where T1's own guard treats `activeTurnId === turnId` as *not* a conflict and
 * `claimTurn` then refused it anyway on `active_turn_id IS NULL` — so the caller was told its own
 * turn was blocking it.
 *
 * What it must not do is run the turn twice: the borrower's line and the agent's would both be
 * appended a second time. So the re-send waits for the copy that is running and replays its result,
 * which is what the `DONE` branch already gives a reconnect that arrives a moment later.
 */
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, Queries, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

/** Held so the first copy of `t1` is still in flight when the re-send arrives. */
const gate = await Effect.runPromise(Deferred.make<void>());
let deciderCalls = 0;

const decider = StaticTurnDeciderLive((input) => {
  deciderCalls += 1;
  const reply = Stream.make(decision({ message: `reply to ${input.userText}`, toolCall: null, intentSatisfied: false, suggestedNextState: "VERIFYING_IDENTITY" }));
  return Stream.fromEffect(Deferred.await(gate)).pipe(Stream.flatMap(() => reply));
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

describe("the same turn id, sent twice while the first is still running", () => {
  it("attaches to the running copy and replays its result, without running the turn twice", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550007001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });

        // The first copy claims the turn and blocks in the decider.
        const first = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "hello" }, () => Effect.void));
        // Wait until T1 has committed, so the re-send genuinely races a RUNNING turn.
        let tries = 0;
        while (tries < 200) {
          const row = yield* (yield* ConversationRepo).findConversation(started.conversationId);
          if (row._tag === "Some" && row.value.activeTurnId === "t1") break;
          tries += 1;
          yield* Effect.sleep("20 millis");
        }

        // The re-send. It must not fail, and it must not start a second copy.
        const resend = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "hello" }, () => Effect.void));
        yield* Effect.sleep("300 millis");
        yield* Deferred.succeed(gate, void 0);

        const a = yield* Fiber.join(first);
        const b = yield* Fiber.join(resend).pipe(Effect.either);
        const detail = yield* (yield* Queries).conversationDetail(started.conversationId);
        return {
          first: a,
          resend: b,
          deciderCalls,
          userLines: detail.events.filter((e) => e.type === "USER_TURN_FINAL" && e.payload.turn_id === "t1").length,
          agentLines: detail.events.filter((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "t1").length,
        };
      }),
    );

    // It attached rather than 409ing...
    expect(out.resend._tag).toBe("Right");
    // ...and got the same answer the running copy produced.
    if (out.resend._tag === "Right") expect(out.resend.right.agentText).toBe(out.first.agentText);
    // The turn ran once. Two USER_TURN_FINALs would put the borrower's line in the transcript twice,
    // which is the failure the obvious fix (relaxing `claimTurn`) would have introduced.
    expect(out.userLines).toBe(1);
    expect(out.agentLines).toBe(1);
    expect(out.deciderCalls).toBe(1);
  });
});
