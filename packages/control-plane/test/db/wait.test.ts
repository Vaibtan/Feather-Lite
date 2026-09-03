import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision, WAIT_WINDOW_BARE_MS, WAIT_WINDOW_ERRAND_MS } from "@feather-lite/domain";
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
    expect(out.r.extendAwayMs).toBe(WAIT_WINDOW_ERRAND_MS);
    expect(deciderCalls).toBe(before);
    expect(out.events.some((e) => e.type === "USER_TURN_FINAL")).toBe(true);
    // Scoped to this turn's id because the call's opening line is already in the ledger.
    expect(out.events.some((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "w1")).toBe(false);
  });

  /**
   * The fleet gate's failure: the STT split "Actually, wait. I can pay 550 dollars on Friday." and
   * the fragment landed as a turn of its own, which the decider read as declining the plan.
   */
  it("waits out a bare fragment, and only for a beat", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        const r = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "w1", userText: "Actually, wait." }, () => Effect.void);
        return { r, result: yield* resultOf(started.conversationId, "w1") };
      }),
    );
    expect(out.result["disposition"]).toBe("wait");
    expect(out.r.agentText).toBe("");
    expect(out.r.extendAwayMs).toBe(WAIT_WINDOW_BARE_MS);
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

/**
 * Only reachable now that the worker re-arms its own clock: the SDK's away timer fired once per
 * call, so a second strike never followed a first and the count was never observed to accumulate.
 */
describe("no-input strikes", () => {
  it("counts consecutively, so a borrower who answers does not carry a strike", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        const first = yield* orch.processNoInput(started.conversationId);
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "n1", userText: "yes this is Jordan" }, () => Effect.void);
        const afterAnswer = yield* orch.processNoInput(started.conversationId);
        return { first, afterAnswer };
      }),
    );
    expect(out.first.endCall).toBe(false);
    expect(out.first.agentText).toMatch(/still there/);
    // A cumulative count would make this the closing strike.
    expect(out.afterAnswer.endCall).toBe(false);
    expect(out.afterAnswer.agentText).toMatch(/still there/);
  });

  it("closes the attempt when the strikes really are consecutive", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        yield* orch.processNoInput(started.conversationId);
        return yield* orch.processNoInput(started.conversationId);
      }),
    );
    expect(out.endCall).toBe(true);
    expect(out.outcome).toBe("NO_ANSWER");
  });
});
