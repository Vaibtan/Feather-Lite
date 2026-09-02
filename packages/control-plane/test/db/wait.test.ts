/**
 * `wait`: the borrower asks for a moment and the agent says nothing (issue #1, D1 — Phase 2).
 *
 * The decider is not consulted. The borrower's line is still appended, because the ledger is the
 * truth about what was said (Q4); the control plane simply declines to answer and asks the worker
 * for more away time. A second consecutive hold is answered, so a borrower cannot park the call.
 */
import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

let deciderCalls = 0;
const decider = StaticTurnDeciderLive(() => {
  deciderCalls += 1;
  return Stream.make(decision({ message: "Understood.", toolCall: null, intentSatisfied: true, suggestedNextState: "VERIFYING_IDENTITY" }));
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

let phone = 99000;
const startCall = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  phone += 1;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555${String(phone).padStart(7, "0")}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  return yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
});

const resultOf = (conversationId: string, turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly result: Record<string, unknown> }>`
      SELECT result FROM conversation_turns WHERE conversation_id = ${conversationId} AND turn_id = ${turnId}`;
    return rows[0]?.result ?? {};
  });

describe("a borrower asking for a moment", () => {
  it("is answered with silence, an extended away timer, and no call to the decider", async () => {
    const before = deciderCalls;
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        const r = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w1", userText: "hold on, let me get my card" }, () => Effect.void);
        return { r, result: yield* resultOf(started.conversationId, "w1"), events: yield* (yield* ConversationRepo).listEvents(started.conversationId) };
      }),
    );
    expect(out.result["disposition"]).toBe("wait");
    expect(out.r.agentText).toBe("");
    // The worker is told to wait longer rather than firing a no-input strike into the silence.
    expect(out.r.extendAwayMs).toBeGreaterThan(0);
    // Not consulted: a hold is a lexicon decision, not a model one (Q3).
    expect(deciderCalls).toBe(before);
    // The borrower's words still reach the ledger — Q4: the ledger is the truth about what was said.
    expect(out.events.some((e) => e.type === "USER_TURN_FINAL")).toBe(true);
    // And the agent said nothing *on this turn* — the call's opening line is already in the ledger,
    // which is why this asks about `w1` rather than about agent turns in general.
    expect(out.events.some((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "w1")).toBe(false);
  });

  it("answers the second consecutive hold, so a borrower cannot park the call indefinitely", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w1", userText: "hold on" }, () => Effect.void);
        const second = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w2", userText: "one second" }, () => Effect.void);
        return { second, result: yield* resultOf(started.conversationId, "w2") };
      }),
    );
    expect(out.result["disposition"]).toBe("respond");
    expect(out.second.agentText.length).toBeGreaterThan(0);
  });

  it("does not treat a hold phrase carrying an offer as a hold", async () => {
    // "hold on, I can pay Friday" is an offer that opens politely. Waiting on it would drop the
    // offer entirely, which is the worst outcome this lexicon can produce.
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w1", userText: "hold on, I can pay 550 on Friday" }, () => Effect.void);
        return yield* resultOf(started.conversationId, "w1");
      }),
    );
    expect(out["disposition"]).toBe("respond");
  });

  it("records `respond` on an ordinary turn, so the field is never absent", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w1", userText: "yes this is Jordan" }, () => Effect.void);
        return yield* resultOf(started.conversationId, "w1");
      }),
    );
    expect(out["disposition"]).toBe("respond");
  });
});
