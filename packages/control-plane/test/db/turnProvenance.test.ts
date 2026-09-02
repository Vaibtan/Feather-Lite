/**
 * Which arm decided a turn, and how the turn ended, are facts the ledger keeps (F3).
 *
 * The decide phase has more than one arm — a deterministic override, the model, and D2's fast path
 * when it lands — and until now the ledger could not tell them apart. A call's `conversations.decider`
 * says which decider *service* was configured for the whole call, which is a different question:
 * every turn of an `openai` call reads `openai` whether the model was consulted or a regex answered
 * in a microsecond. Mixing those in one latency window is how a fast path flatters a p95.
 *
 * `TurnResult` is serialised whole into `conversation_turns.result`, so this needs no migration.
 */
import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { IdGen, Orchestrator, Queries, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const decider = StaticTurnDeciderLive((input) =>
  input.turnId === "t-model"
    ? Stream.make(decision({ message: "", toolCall: { name: "confirm_right_party", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "DISCUSSING_PAYMENT" }))
    : Stream.make(decision({ message: "Understood.", toolCall: null, intentSatisfied: true, suggestedNextState: "VERIFYING_IDENTITY" })),
);

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, IdGen.Default).pipe(Layer.provide(decider), Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

let phone = 77000;
const seed = Effect.gen(function* () {
  phone += 1;
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555${String(phone).padStart(7, "0")}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  return yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
});

/** What the ledger kept for one turn, which is the only place these facts are asserted. */
const resultOf = (conversationId: string, turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly result: Record<string, unknown> }>`
      SELECT result FROM conversation_turns WHERE conversation_id = ${conversationId} AND turn_id = ${turnId}`;
    return rows[0]?.result ?? {};
  });

describe("the ledger records which arm decided a turn (F3)", () => {
  it("names the model when the decider was consulted", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-model", userText: "yes this is Jordan" }, () => Effect.void);
        return yield* resultOf(started.conversationId, "t-model");
      }),
    );
    expect(out["decider"]).toBe("scripted");
    expect(out["disposition"]).toBe("tool");
  });

  it("names the override when a deterministic rule answered without the model", async () => {
    // The point of the field: this turn never reached the decider, so a latency window that treats
    // it as a model turn is averaging a regex into the number the product's claim is made from.
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-override", userText: "who is this? take me off your list" }, () => Effect.void);
        return yield* resultOf(started.conversationId, "t-override");
      }),
    );
    expect(out["decider"]).toBe("override");
  });

  it("carries both fields on every turn, so the predicate never reads undefined", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-plain", userText: "hello there" }, () => Effect.void);
        return yield* resultOf(started.conversationId, "t-plain");
      }),
    );
    expect(typeof out["decider"]).toBe("string");
    expect(typeof out["disposition"]).toBe("string");
  });
});

describe("the SLO window can select turns by which arm decided them (F4)", () => {
  it("separates override turns from model turns of the same call", async () => {
    /**
     * The defect this exists to prevent, one level down from O2's. A fast path that answers in a
     * microsecond and a model turn that takes two seconds are both turns of one `voice`/`openai`
     * call, so no conversation-level facet can part them — and mixing them moves the p95 the
     * product's latency claim is made from without anything getting faster. D2's fast path is what
     * makes this urgent; the override arm is the same shape and exists today.
     */
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        const queries = yield* Queries;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-model", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-override", userText: "who is this? take me off your list" }, () => Effect.void);
        const all = yield* queries.turnRowsFor([started.conversationId]);
        const model = yield* queries.turnRowsFor([started.conversationId], { decider: "scripted" });
        const override = yield* queries.turnRowsFor([started.conversationId], { decider: "override" });
        return { all: all.rows.length, model: model.rows.map((r) => r.turn_id), override: override.rows.map((r) => r.turn_id) };
      }),
    );
    expect(out.all).toBe(2);
    expect(out.model).toEqual(["t-model"]);
    expect(out.override).toEqual(["t-override"]);
  });

  it("a null predicate means do not filter, so the unsegmented window still works", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* seed;
        const orch = yield* Orchestrator;
        const queries = yield* Queries;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t-model", userText: "yes this is Jordan" }, () => Effect.void);
        const both = yield* queries.turnRowsFor([started.conversationId], { decider: null });
        return both.rows.length;
      }),
    );
    expect(out).toBe(1);
  });
});

