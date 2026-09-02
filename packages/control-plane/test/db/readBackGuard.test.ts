/**
 * The fully-heard read-back guard (C1).
 *
 * PRD §5.2.8: a promise is recorded only after the borrower has confirmed a read-back they
 * actually heard. The guard's evidence is the `AGENT_TURN_PLAYOUT` the voice worker reports for
 * the read-back turn. Three cases, and the third is the one this file exists for:
 *
 *  - reported `interrupted` -> rejected, read-back repeated;
 *  - reported heard        -> recorded;
 *  - **never reported**    -> on a voice call there is no evidence the borrower heard anything,
 *    so it is rejected too. A worker killed after speaking, a failed signal POST or a dead job
 *    process all produce exactly this shape, and ADR 0008's cross-check covers a report that
 *    arrives *wrong*, not one that never arrives.
 *
 * On `simulated` there is no playout reporter by design (the scenario runner drives the
 * orchestrator directly), so the absence keeps its vacuous pass — the fourth case.
 */
import { Effect, Layer, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision, promiseReadback, READBACK_INTERRUPTED_DETAIL, READBACK_UNCONFIRMED_DETAIL } from "@feather-lite/domain";
import type { Channel } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, Queries, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const AMOUNT = "550.00";
const DATE = "2026-09-15";

/**
 * Turn ids are `<case>:<step>` so one decider serves every case: the step drives the tool and the
 * case keeps the ids unique across conversations.
 */
const decider = StaticTurnDeciderLive((input) => {
  const step = input.turnId.slice(input.turnId.indexOf(":") + 1);
  switch (step) {
    case "rpc":
      return Stream.make(
        decision({ message: "", toolCall: { name: "confirm_right_party", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "DISCUSSING_PAYMENT" }),
      );
    case "propose":
      return Stream.make(
        decision({ message: "", toolCall: { name: "propose_promise_to_pay", args: { amount: AMOUNT, date: DATE } }, intentSatisfied: true, suggestedNextState: "CONFIRMING_OUTCOME" }),
      );
    case "record":
      return Stream.make(
        decision({ message: "", toolCall: { name: "record_promise_to_pay", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: "CONFIRMING_OUTCOME" }),
      );
    default:
      return Stream.make(decision({ message: `reply to ${input.userText}`, toolCall: null, intentSatisfied: false, suggestedNextState: input.state }));
  }
});

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(decider),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

/** A conversation driven as far as the read-back: the proposal is pending on turn `<case>:propose`. */
const upToReadBack = (caseId: string, channel: Channel, phone: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: AMOUNT, dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;

    const wf = yield* WorkflowService;
    const orch = yield* Orchestrator;
    const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel, now: FROZEN_NOW });
    const id = started.conversationId;
    yield* orch.processTurn({ conversationId: id, turnId: `${caseId}:rpc`, userText: "yes this is Jordan" }, () => Effect.void);
    yield* orch.processTurn({ conversationId: id, turnId: `${caseId}:propose`, userText: `I can pay ${AMOUNT} on Friday` }, () => Effect.void);
    return id;
  });

/** What the ledger says after the record attempt. */
const outcomeOf = (conversationId: string) =>
  Effect.gen(function* () {
    const q = yield* Queries;
    const conv = yield* ConversationRepo;
    const detail = yield* q.conversationDetail(conversationId);
    const row = yield* conv.findConversation(conversationId);
    const sayText = detail.events
      .filter((e) => e.type === "AGENT_TURN")
      .map((e) => (e.type === "AGENT_TURN" ? e.payload.text : ""))
      .join(" | ");
    return {
      finalOutcome: Option.isSome(row) ? row.value.finalOutcome : null,
      rejections: detail.events.filter((e) => e.type === "TOOL_REJECTED" && e.payload.name === "record_promise_to_pay"),
      pendingProposal: Option.isSome(row) ? row.value.pendingProposal : null,
      sayText,
    };
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("the fully-heard read-back guard", () => {
  it("rejects and repeats the read-back when the playout is reported interrupted", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* upToReadBack("interrupted", "voice", "+15550003001");
        const orch = yield* Orchestrator;
        yield* orch.processTurn(
          {
            conversationId: id,
            turnId: "interrupted:record",
            userText: "yes",
            playout: { turnId: "interrupted:propose", heardText: "Just to confirm, I have", interrupted: true },
          },
          () => Effect.void,
        );
        return yield* outcomeOf(id);
      }),
    );
    expect(out.finalOutcome).toBeNull();
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0]?.type === "TOOL_REJECTED" && out.rejections[0].payload.detail).toBe(READBACK_INTERRUPTED_DETAIL);
    // The guard's recovery: the read-back is spoken again, re-armed on this turn.
    expect(out.sayText).toContain(promiseReadback({ amount: AMOUNT, date: DATE }));
    expect(out.pendingProposal?.read_back_turn_id).toBe("interrupted:record");
  });

  it("records the promise when the playout is reported heard in full", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* upToReadBack("heard", "voice", "+15550003002");
        const orch = yield* Orchestrator;
        yield* orch.processTurn(
          {
            conversationId: id,
            turnId: "heard:record",
            userText: "yes",
            playout: { turnId: "heard:propose", heardText: promiseReadback({ amount: AMOUNT, date: DATE }), interrupted: false },
          },
          () => Effect.void,
        );
        return yield* outcomeOf(id);
      }),
    );
    expect(out.rejections).toHaveLength(0);
    expect(out.finalOutcome).toBe("PROMISE_TO_PAY");
    expect(out.pendingProposal).toBeNull();
  });

  it("rejects a voice read-back whose playout was never reported at all", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* upToReadBack("absent", "voice", "+15550003003");
        const orch = yield* Orchestrator;
        // No `playout` on the turn: the worker died after speaking, or the signal never landed.
        yield* orch.processTurn({ conversationId: id, turnId: "absent:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.finalOutcome).toBeNull();
    expect(out.rejections).toHaveLength(1);
    // The ledger says which of the two failures it was: nothing reported, not a barge-in. An
    // operator reading the call needs to tell "the borrower talked over it" from "the worker died".
    expect(out.rejections[0]?.type === "TOOL_REJECTED" && out.rejections[0].payload.detail).toBe(READBACK_UNCONFIRMED_DETAIL);
    expect(out.sayText).toContain(promiseReadback({ amount: AMOUNT, date: DATE }));
    expect(out.pendingProposal?.read_back_turn_id).toBe("absent:record");
  });

  it("keeps the vacuous pass on simulated, where nothing reports playouts", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const id = yield* upToReadBack("sim", "simulated", "+15550003004");
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "sim:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.rejections).toHaveLength(0);
    expect(out.finalOutcome).toBe("PROMISE_TO_PAY");
  });
});
