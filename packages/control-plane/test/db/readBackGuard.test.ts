import { Effect, Layer, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision, promiseReadback, READBACK_INTERRUPTED_DETAIL, READBACK_UNCONFIRMED_DETAIL } from "@feather-lite/domain";
import type { Channel } from "@feather-lite/domain";
import { ConversationRepo, IdGen, Orchestrator, Queries, StaticTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const AMOUNT = "550.00";
const DATE = "2026-09-15";

// Turn ids are `<case>:<step>` so one decider serves every case: the step drives the tool, the case keeps ids unique across conversations.
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
    // The read-back is one segment of the propose turn, and the guard looks for that segment's
    // playout: the turn also spoke the confirmation line, which is not evidence of anything.
    const row = yield* (yield* ConversationRepo).findConversation(id);
    const segmentId = Option.isSome(row) ? (row.value.pendingProposal?.read_back_segment_id ?? "") : "";
    return { id, segmentId };
  });

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

/** What the voice worker posts when a segment's item is delivered: one signal per segment. */
const reportPlayout = (conversationId: string, p: { turnId: string; segmentId?: string; heardText: string; interrupted: boolean }) =>
  Effect.flatMap(Orchestrator, (orch) =>
    orch.processSignal(conversationId, { kind: "playout", turnId: p.turnId, ...(p.segmentId === undefined ? {} : { segmentId: p.segmentId }), heardText: p.heardText, interrupted: p.interrupted }),
  );

describe("the fully-heard read-back guard", () => {
  it("rejects and repeats the read-back when the playout is reported interrupted", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { id, segmentId } = yield* upToReadBack("interrupted", "voice", "+15550003001");
        yield* reportPlayout(id, { turnId: "interrupted:propose", segmentId, heardText: "Just to confirm, I have", interrupted: true });
        yield* (yield* Orchestrator).processTurn({ conversationId: id, turnId: "interrupted:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.finalOutcome).toBeNull();
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0]?.type === "TOOL_REJECTED" && out.rejections[0].payload.detail).toBe(READBACK_INTERRUPTED_DETAIL);
    expect(out.sayText).toContain(promiseReadback({ amount: AMOUNT, date: DATE }));
    expect(out.pendingProposal?.read_back_turn_id).toBe("interrupted:record");
  });

  it("records the promise when the playout is reported heard in full", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { id, segmentId } = yield* upToReadBack("heard", "voice", "+15550003002");
        yield* reportPlayout(id, { turnId: "heard:propose", segmentId, heardText: promiseReadback({ amount: AMOUNT, date: DATE }), interrupted: false });
        yield* (yield* Orchestrator).processTurn({ conversationId: id, turnId: "heard:record", userText: "yes" }, () => Effect.void);
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
        const { id } = yield* upToReadBack("absent", "voice", "+15550003003");
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "absent:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.finalOutcome).toBeNull();
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0]?.type === "TOOL_REJECTED" && out.rejections[0].payload.detail).toBe(READBACK_UNCONFIRMED_DETAIL);
    expect(out.sayText).toContain(promiseReadback({ amount: AMOUNT, date: DATE }));
    expect(out.pendingProposal?.read_back_turn_id).toBe("absent:record");
  });

  it("keeps the vacuous pass on simulated, where nothing reports playouts", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { id } = yield* upToReadBack("sim", "simulated", "+15550003004");
        const orch = yield* Orchestrator;
        yield* orch.processTurn({ conversationId: id, turnId: "sim:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.rejections).toHaveLength(0);
    expect(out.finalOutcome).toBe("PROMISE_TO_PAY");
  });

  it("refuses a playout that reports another segment of the read-back's own turn", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { id } = yield* upToReadBack("othersegment", "voice", "+15550003005");
        // The same turn's other segment played in full; the read-back's has not been reported.
        yield* reportPlayout(id, { turnId: "othersegment:propose", segmentId: "some-other-segment", heardText: "Thank you, Jordan.", interrupted: false });
        yield* (yield* Orchestrator).processTurn({ conversationId: id, turnId: "othersegment:record", userText: "yes" }, () => Effect.void);
        return yield* outcomeOf(id);
      }),
    );
    expect(out.finalOutcome).toBeNull();
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0]?.type === "TOOL_REJECTED" && out.rejections[0].payload.detail).toBe(READBACK_UNCONFIRMED_DETAIL);
  });

  it("accepts a playout with no segment id, which is the shape a `/turn` body and an old ledger both carry", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const { id } = yield* upToReadBack("legacy", "voice", "+15550003006");
        const orch = yield* Orchestrator;
        yield* orch.processTurn(
          {
            conversationId: id,
            turnId: "legacy:record",
            userText: "yes",
            playout: { turnId: "legacy:propose", heardText: promiseReadback({ amount: AMOUNT, date: DATE }), interrupted: false },
          },
          () => Effect.void,
        );
        return yield* outcomeOf(id);
      }),
    );
    expect(out.rejections).toHaveLength(0);
    expect(out.finalOutcome).toBe("PROMISE_TO_PAY");
  });
});
