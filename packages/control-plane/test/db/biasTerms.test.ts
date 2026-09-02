/**
 * The recogniser is told what to expect only after the borrower is verified (issue #1, D3).
 *
 * The gate is the point. A keyterm list carrying the borrower's name and balance is account data
 * leaving the system just as surely as a sentence is, so it goes out through the **same** protected-
 * context unlock the prompt uses — never before `confirm_right_party`.
 */
import { Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "@feather-lite/domain";
import { IdGen, Orchestrator, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import type { TurnFrame } from "@feather-lite/contracts";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const decider = StaticTurnDeciderLive((input) =>
  input.turnId === "t1"
    ? Stream.make(decision({ message: "", toolCall: { name: "confirm_right_party", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "DISCUSSING_PAYMENT" }))
    : Stream.make(decision({ message: "Understood.", toolCall: null, intentSatisfied: true, suggestedNextState: "VERIFYING_IDENTITY" })),
);

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, IdGen.Default).pipe(Layer.provide(decider), Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

let phone = 66000;
const startCall = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  phone += 1;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555${String(phone).padStart(7, "0")}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-09-04", status: "DELINQUENT", delinquencyDays: 10 })}`;
  return yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
});

const turnEndOf = (frames: TurnFrame[]) => frames.find((f) => f.type === "turn_end");

describe("contextual biasing", () => {
  it("sends nothing before right-party verification", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const frames: TurnFrame[] = [];
        // `t2` does not confirm anything, so the conversation stays locked.
        yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "who is this" }, (f) => Effect.sync(() => void frames.push(f)));
        return turnEndOf(frames);
      }),
    );
    expect(out?.type === "turn_end" && out.bias_terms).toBeUndefined();
  });

  it("sends the account's terms on the turn that verifies the borrower", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const frames: TurnFrame[] = [];
        yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, (f) => Effect.sync(() => void frames.push(f)));
        return turnEndOf(frames);
      }),
    );
    const bias = out?.type === "turn_end" ? out.bias_terms : undefined;
    expect(bias?.keyterms).toContain("Jordan");
    expect(bias?.keyterms).toContain("Avery");
    expect(bias?.keywords).toContain("550:2");
    expect(bias?.keywords).toContain("september:2");
    expect(bias?.numerals).toBe(true);
  });

  it("does not repeat them on later turns, because updating re-opens the STT socket", async () => {
    /**
     * Verified in the installed plugin (`stt.js:284`): `updateOptions` calls `#resetWS.resolve()`,
     * which tears down and re-opens the Deepgram websocket. Sending the same list every turn would
     * reconnect the recogniser on every turn of the call.
     */
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startCall;
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
        const frames: TurnFrame[] = [];
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "okay" }, (f) => Effect.sync(() => void frames.push(f)));
        return turnEndOf(frames);
      }),
    );
    expect(out?.type === "turn_end" && out.bias_terms).toBeUndefined();
  });
});
