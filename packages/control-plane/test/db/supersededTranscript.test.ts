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
  WorkflowService,
  FROZEN_NOW,
  type DeciderInput,
} from "../../src/index.js";
import type { TurnFrame } from "@feather-lite/contracts";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const seen: DeciderInput[] = [];
/** Held so t1 is still in flight when t2 barges in. */
const gate = await Effect.runPromise(Deferred.make<void>());

const decider = StaticTurnDeciderLive((input) => {
  seen.push(input);
  const reply = Stream.make(decision({ message: `reply to ${input.userText}`, toolCall: null, intentSatisfied: false, suggestedNextState: "VERIFYING_IDENTITY" }));
  return input.turnId === "t1" ? Stream.fromEffect(Deferred.await(gate)).pipe(Stream.flatMap(() => reply)) : reply;
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

describe("superseded turns and the decider's transcript", () => {
  it("keeps a superseded borrower line out of recentTranscript but in the ledger", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550002222", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        // The text matters: a pure hold request is answered without consulting the decider, so it
        // could never be in flight to be superseded.
        const frames1 = yield* Ref.make<TurnFrame[]>([]);
        const fiber1 = yield* Effect.fork(
          orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "I need to check my account balance first" }, (f) => Ref.update(frames1, (xs) => [...xs, f])),
        );
        let tries = 0;
        while (!(yield* Ref.get(frames1)).some((f) => f.type === "turn_start") && tries < 200) {
          tries++;
          yield* Effect.sleep("20 millis");
        }
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "yes this is Jordan", supersede: true }, () => Effect.void);
        yield* Deferred.succeed(gate, void 0);
        yield* Fiber.join(fiber1).pipe(Effect.either);

        const q = yield* Queries;
        return yield* q.conversationDetail(started.conversationId);
      }),
    );

    const t2Input = seen.find((i) => i.turnId === "t2");
    expect(t2Input).toBeDefined();
    const texts = t2Input!.recentTranscript.map((e) => e.text);
    expect(texts).not.toContain("I need to check my account balance first");
    const speakers = t2Input!.recentTranscript.map((e) => e.speaker);
    expect(speakers.some((s, i) => i > 0 && s === "BORROWER" && speakers[i - 1] === "BORROWER")).toBe(false);
    expect(out.events.some((e) => e.type === "USER_TURN_FINAL" && e.payload.text === "I need to check my account balance first")).toBe(true);
    expect(out.transcript.some((e) => e.text === "I need to check my account balance first")).toBe(true);
    expect(out.events.some((e) => e.type === "TURN_SUPERSEDED" && e.payload.turn_id === "t1")).toBe(true);
  });
});
