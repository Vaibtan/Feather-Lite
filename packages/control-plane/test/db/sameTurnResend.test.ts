import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, Queries, StaticTurnDeciderLive, TurnRunner, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

/** Held so the first copy of `t1` is still in flight when the re-send arrives. */
const gate = await Effect.runPromise(Deferred.make<void>());
const gate2 = await Effect.runPromise(Deferred.make<void>());
/** Counted for `t1` only: the supersede test below shares this decider and has its own turns. */
let deciderCalls = 0;

const decider = StaticTurnDeciderLive((input) => {
  if (input.turnId === "t1") deciderCalls += 1;
  const reply = Stream.make(decision({ message: `reply to ${input.userText}`, toolCall: null, intentSatisfied: false, suggestedNextState: "VERIFYING_IDENTITY" }));
  const held = input.turnId.startsWith("s") ? gate2 : gate;
  return Stream.fromEffect(Deferred.await(held)).pipe(Stream.flatMap(() => reply));
});

const layer = Layer.mergeAll(Orchestrator.Default, TurnRunner.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
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

describe("a turn still in flight when the process stops", () => {
  it("does not leave active_turn_id set on the conversation", async () => {
    // A separate runtime, because the thing under test is what happens when its scope closes.
    const shutdownRt = makeRuntime(layer);
    const conversationId = await shutdownRt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550007003", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        const runner = yield* TurnRunner;
        yield* runner.run({ conversationId: started.conversationId, turnId: "x1", userText: "hello" });
        let tries = 0;
        while (tries < 200) {
          const row = yield* (yield* ConversationRepo).findConversation(started.conversationId);
          if (row._tag === "Some" && row.value.activeTurnId === "x1") break;
          tries += 1;
          yield* Effect.sleep("20 millis");
        }
        return started.conversationId;
      }),
    );
    await shutdownRt.dispose();

    const after = await rt.runPromise(
      Effect.gen(function* () {
        const row = yield* (yield* ConversationRepo).findConversation(conversationId);
        return row._tag === "Some" ? row.value.activeTurnId : "missing";
      }),
    );
    expect(after).toBeNull();
  }, 20_000);
});

describe("a turn id that was superseded", () => {
  it("is refused rather than run again", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550007002", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        const orch = yield* Orchestrator;
        const s1 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "s1", userText: "hello" }, () => Effect.void));
        let tries = 0;
        while (tries < 200) {
          const row = yield* (yield* ConversationRepo).findConversation(started.conversationId);
          if (row._tag === "Some" && row.value.activeTurnId === "s1") break;
          tries += 1;
          yield* Effect.sleep("20 millis");
        }
        const s2 = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "s2", userText: "actually, wait", supersede: true }, () => Effect.void));
        yield* Effect.sleep("100 millis");
        yield* Deferred.succeed(gate2, void 0);
        yield* Fiber.join(s1).pipe(Effect.either);
        yield* Fiber.join(s2).pipe(Effect.either);
        const resend = yield* orch.processTurn({ conversationId: started.conversationId, turnId: "s1", userText: "hello" }, () => Effect.void).pipe(Effect.either);
        const detail = yield* (yield* Queries).conversationDetail(started.conversationId);
        return {
          resend,
          userLines: detail.events.filter((e) => e.type === "USER_TURN_FINAL" && e.payload.turn_id === "s1").length,
          agentLines: detail.events.filter((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "s1").length,
        };
      }),
    );
    expect(out.resend._tag).toBe("Left");
    if (out.resend._tag === "Left") expect(out.resend.left._tag).toBe("TurnSuperseded");
    expect(out.userLines).toBe(1);
    expect(out.agentLines).toBe(0);
  });
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
        const first = yield* Effect.fork(orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "hello" }, () => Effect.void));
        // Wait until the first copy has committed, so the re-send genuinely races a RUNNING turn.
        let tries = 0;
        while (tries < 200) {
          const row = yield* (yield* ConversationRepo).findConversation(started.conversationId);
          if (row._tag === "Some" && row.value.activeTurnId === "t1") break;
          tries += 1;
          yield* Effect.sleep("20 millis");
        }
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
    expect(out.resend._tag).toBe("Right");
    if (out.resend._tag === "Right") expect(out.resend.right.agentText).toBe(out.first.agentText);
    expect(out.userLines).toBe(1);
    expect(out.agentLines).toBe(1);
    expect(out.deciderCalls).toBe(1);
  });
});
