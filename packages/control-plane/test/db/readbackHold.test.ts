/**
 * The promise read-back is a line the borrower may not talk over (issue #1, D1 — Phase 2).
 *
 * The whole chain in one assertion: the read-back is written `non_interruptible`, so
 * `unreportedNonInterruptible` finds it while it is playing, so `held` parks a turn that arrives
 * during it — and the borrower's "yes" is answered once instead of triggering a second read-back.
 *
 * Until Phase 2 the read-back was `allowInterruptions: true`, which made F2's mechanism correct and
 * unreachable: tier 3's `yes-during-read-back` counted two read-backs on every green run.
 */
import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const decider = StaticTurnDeciderLive((input) =>
  input.turnId === "t1"
    ? Stream.make(decision({ message: "", toolCall: { name: "confirm_right_party", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "DISCUSSING_PAYMENT" }))
    : Stream.make(decision({ message: "", toolCall: { name: "propose_promise_to_pay", args: { amount: "550.00", date: "2026-09-04" } }, intentSatisfied: true, suggestedNextState: "CONFIRMING_OUTCOME" })),
);

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

let phone = 71000;
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
  return yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
});

describe("the promise read-back", () => {
  it("is spoken as a segment the borrower may not talk over, and is therefore holdable", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
        const events = yield* (yield* ConversationRepo).listEvents(started.conversationId);
        const readback = events.find((e) => e.type === "AGENT_TURN" && /say yes to confirm/i.test(String(e.payload.text ?? "")));
        // And the mechanism can see it: this is the join D1 depends on.
        const segment = yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
        return { mode: readback?.type === "AGENT_TURN" ? readback.payload.speak_mode : null, segment };
      }),
    );
    expect(out.mode).toBe("non_interruptible");
    expect(out.segment).not.toBeNull();
  });
});
