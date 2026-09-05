/**
 * `resume` — the agent was paused by a backchannel and carried on — was a declared disposition that
 * nothing ever assigned; the only evidence was an array of durations on the turn's metrics.
 */
import { Effect, Layer, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const decider = StaticTurnDeciderLive((input) => Stream.make(decision({ message: "go on", toolCall: null, intentSatisfied: false, suggestedNextState: input.state })));

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

let phone = 66000;
const aVoiceCall = Effect.gen(function* () {
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

const dispositionOf = (conversationId: string, turnId: string) =>
  Effect.map(
    Effect.flatMap(ConversationRepo, (conv) => conv.findTurn({ conversationId, turnId })),
    Option.match({ onNone: () => null, onSome: (t) => (t.result as { disposition?: string } | null)?.disposition ?? null }),
  );

describe("the resume disposition", () => {
  it("is assigned to a turn the agent was paused during and carried on through", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* aVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        const before = yield* dispositionOf(id, "t1");
        yield* orch.processSignal(id, { kind: "turn_metrics", turnId: "t1", eouDelayMs: 578, resumedMs: [412] });
        return { before, after: yield* dispositionOf(id, "t1") };
      }),
    );
    expect(out.before).toBe("respond");
    expect(out.after).toBe("resume");
  });

  it("leaves a turn that was never paused alone", async () => {
    const after = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* aVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processSignal(id, { kind: "turn_metrics", turnId: "t1", eouDelayMs: 578 });
        return yield* dispositionOf(id, "t1");
      }),
    );
    expect(after).toBe("respond");
  });

  it("is not assigned on an empty list, which says the worker sent the key and nothing else", async () => {
    const after = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* aVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processSignal(id, { kind: "turn_metrics", turnId: "t1", eouDelayMs: 578, resumedMs: [] });
        return yield* dispositionOf(id, "t1");
      }),
    );
    expect(after).toBe("respond");
  });

  it("does not overwrite a wait, which is a decision the control plane made rather than an observation", async () => {
    const after = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* aVoiceCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        yield* orch.processTurn({ conversationId: id, turnId: "t2", userText: "hold on, let me get my card" }, () => Effect.void);
        yield* orch.processSignal(id, { kind: "turn_metrics", turnId: "t2", eouDelayMs: 578, resumedMs: [412] });
        return yield* dispositionOf(id, "t2");
      }),
    );
    expect(after).toBe("wait");
  });
});
