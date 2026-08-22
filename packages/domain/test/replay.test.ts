import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  buildTranscript,
  decodeEventRecord,
  replay,
  type EventRecord,
} from "../src/index.js";

/** Build a stored event, in the exact JSON shape the DB (and Python) produce. */
const rec = (sequence_no: number, type: string, payload: Record<string, unknown>): EventRecord => {
  const decoded = decodeEventRecord({ sequence_no, created_at: `2026-08-16T10:00:${String(sequence_no).padStart(2, "0")}Z`, type, payload });
  if (Either.isLeft(decoded)) throw new Error(`fixture invalid: ${type} ${JSON.stringify(payload)}`);
  return decoded.right;
};

/** A full happy-path promise-to-pay conversation, as the orchestrator would write it. */
const happyPath: ReadonlyArray<EventRecord> = [
  rec(1, "CALL_STARTED", { workflow_execution_id: "w", call_attempt_id: "a", contact_point_id: "c", channel: "simulated", attempt_no: 1 }),
  rec(2, "STATE_TRANSITION", { from: null, to: "GREETING", triggered_by: "SYSTEM_START" }),
  rec(3, "AGENT_TURN", { text: "This is Feather-Lite... May I speak with Jordan?", state: "GREETING", speak_mode: "non_interruptible" }),
  rec(4, "USER_TURN_FINAL", { text: "yes this is Jordan", turn_id: "t1" }),
  rec(5, "TOOL_CALLED", { name: "confirm_right_party", tool_call_id: "tc1", args: { confirmed: true } }),
  rec(6, "TOOL_RESULT", { name: "confirm_right_party", tool_call_id: "tc1", result: { confirmed: true } }),
  rec(7, "STATE_TRANSITION", { from: "GREETING", to: "VERIFYING_IDENTITY", triggered_by: "LLM_INTENT" }),
  rec(8, "STATE_TRANSITION", { from: "VERIFYING_IDENTITY", to: "DISCUSSING_PAYMENT", triggered_by: "RIGHT_PARTY_CONFIRMED" }),
  rec(9, "AGENT_TURN", { text: "Thanks Jordan. Your balance is 550 dollars...", state: "DISCUSSING_PAYMENT", turn_id: "t1" }),
  rec(10, "USER_TURN_FINAL", { text: "I can pay 550 on Friday", turn_id: "t2" }),
  rec(11, "TOOL_CALLED", { name: "propose_promise_to_pay", tool_call_id: "tc2", args: { amount: "550.00", date: "2026-08-21" } }),
  rec(12, "TOOL_RESULT", { name: "propose_promise_to_pay", tool_call_id: "tc2", result: { amount: "550.00", date: "2026-08-21" } }),
  rec(13, "STATE_TRANSITION", { from: "DISCUSSING_PAYMENT", to: "CONFIRMING_OUTCOME", triggered_by: "PROPOSAL" }),
  rec(14, "AGENT_TURN", { text: "To confirm: you will pay 550 dollars by Friday...", state: "CONFIRMING_OUTCOME", turn_id: "t2", speak_mode: "non_interruptible" }),
  rec(15, "USER_TURN_FINAL", { text: "yes", turn_id: "t3" }),
  rec(16, "TOOL_CALLED", { name: "record_promise_to_pay", tool_call_id: "tc3", args: { confirmed: true } }),
  rec(17, "TOOL_RESULT", { name: "record_promise_to_pay", tool_call_id: "tc3", result: { promised_amount: "550.00", promised_date: "2026-08-21" } }),
  rec(18, "STATE_TRANSITION", { from: "CONFIRMING_OUTCOME", to: "ENDING", triggered_by: "OUTCOME_COMMITTED" }),
  rec(19, "AGENT_TURN", { text: "Thank you. I have recorded your promise...", state: "ENDING", turn_id: "t3" }),
  rec(20, "STATE_TRANSITION", { from: "ENDING", to: "COMPLETED", triggered_by: "CALL_ENDED" }),
  rec(21, "CALL_ENDED", { final_outcome: "PROMISE_TO_PAY" }),
  rec(22, "OUTBOX_ENQUEUED", { job_types: ["SUMMARY", "EVALUATION", "VECTOR_INDEX"] }),
];

describe("replay (SPEC §11.3)", () => {
  it("recovers state, unlock, outcome, tools and the state path", () => {
    const snap = replay(happyPath);
    expect(snap.currentState).toBe("COMPLETED");
    expect(snap.protectedContextUnlocked).toBe(true);
    expect(snap.finalOutcome).toBe("PROMISE_TO_PAY");
    expect(snap.executedTools).toEqual(["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"]);
    expect(snap.toolCallIds.has("tc2")).toBe(true);
    expect(snap.statePath).toEqual(["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME", "ENDING", "COMPLETED"]);
    expect(snap.pendingProposal).toBeNull(); // consumed by record_promise_to_pay
    expect(snap.turnCount).toBe(3);
    expect(snap.lastSequenceNo).toBe(22);
  });

  it("is order-independent (events may arrive unsorted)", () => {
    const shuffled = [...happyPath].reverse();
    expect(replay(shuffled)).toEqual(replay(happyPath));
  });

  it("recovers an in-flight conversation after a crash: mid-DISCUSSING_PAYMENT with a pending proposal read back", () => {
    const snap = replay(happyPath.slice(0, 14));
    expect(snap.currentState).toBe("CONFIRMING_OUTCOME");
    expect(snap.finalOutcome).toBeNull();
    expect(snap.pendingProposal).toEqual({
      kind: "PROMISE_TO_PAY",
      amount: "550.00",
      date: "2026-08-21",
      proposedAtSeq: 12,
      readBackAtSeq: 14,
    });
  });

  it("only RIGHT_PARTY_CONFIRMED unlocks protected context — an LLM_INTENT jump does not", () => {
    const sneaky = [
      rec(1, "STATE_TRANSITION", { from: null, to: "GREETING", triggered_by: "SYSTEM_START" }),
      rec(2, "STATE_TRANSITION", { from: "GREETING", to: "VERIFYING_IDENTITY", triggered_by: "LLM_INTENT" }),
      rec(3, "STATE_TRANSITION", { from: "VERIFYING_IDENTITY", to: "DISCUSSING_PAYMENT", triggered_by: "LLM_INTENT" }),
    ];
    expect(replay(sneaky).protectedContextUnlocked).toBe(false);
  });

  it("declining the read-back clears the pending proposal", () => {
    const declined = [
      ...happyPath.slice(0, 14),
      rec(15, "USER_TURN_FINAL", { text: "no, make it 300", turn_id: "t3" }),
      rec(16, "STATE_TRANSITION", { from: "CONFIRMING_OUTCOME", to: "DISCUSSING_PAYMENT", triggered_by: "USER_DECLINED" }),
    ];
    const snap = replay(declined);
    expect(snap.currentState).toBe("DISCUSSING_PAYMENT");
    expect(snap.pendingProposal).toBeNull();
  });

  it("counts NO_INPUT strikes and call-control actions with their idempotency keys", () => {
    const events = [
      rec(1, "STATE_TRANSITION", { from: null, to: "GREETING", triggered_by: "SYSTEM_START" }),
      rec(2, "NO_INPUT", { state: "GREETING", count: 1 }),
      rec(3, "NO_INPUT", { state: "GREETING", count: 2 }),
      rec(4, "CALL_CONTROL", { action: "NO_INPUT_CLOSE", action_id: "a1", count: 2 }),
    ];
    const snap = replay(events);
    expect(snap.noInputCount).toBe(2);
    expect(snap.callControlActions).toEqual(["NO_INPUT_CLOSE"]);
    expect(snap.actionIds.has("a1")).toBe(true);
  });
});

describe("event decoding is strict about type but tolerant of the Python wire shape", () => {
  it("accepts Python-shaped CALL_CONTROL and AMD payloads", () => {
    expect(Either.isRight(decodeEventRecord({ sequence_no: 1, created_at: "2026-01-01T00:00:00Z", type: "CALL_CONTROL", payload: { action: "VOICEMAIL_DROP", action_id: "x", confidence: 0.99 } }))).toBe(true);
  });
  it("rejects unknown event types and malformed payloads", () => {
    expect(Either.isLeft(decodeEventRecord({ sequence_no: 1, created_at: "2026-01-01T00:00:00Z", type: "NOT_A_TYPE", payload: {} }))).toBe(true);
    expect(Either.isLeft(decodeEventRecord({ sequence_no: 1, created_at: "2026-01-01T00:00:00Z", type: "STATE_TRANSITION", payload: { to: "NOWHERE", triggered_by: "LLM_INTENT" } }))).toBe(true);
  });
});

describe("transcript and timeline (PRD §5.2.6)", () => {
  it("interleaves borrower and agent lines in sequence order", () => {
    const t = buildTranscript(happyPath);
    expect(t.map((e) => e.speaker)).toEqual(["AGENT", "BORROWER", "AGENT", "BORROWER", "AGENT", "BORROWER", "AGENT"]);
    expect(t[1]?.text).toBe("yes this is Jordan");
  });

  it("prefers what the borrower actually heard when the runtime reports a barge-in truncation", () => {
    const events = [
      rec(1, "AGENT_TURN", { text: "Your balance is 550 dollars and the due date was...", state: "DISCUSSING_PAYMENT", turn_id: "t9" }),
      rec(2, "AGENT_TURN_PLAYOUT", { turn_id: "t9", heard_text: "Your balance is 550 dollars", interrupted: true }),
    ];
    const t = buildTranscript(events);
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe("Your balance is 550 dollars");
    expect(t[0]?.interrupted).toBe(true);
  });

  it("keeps superseded borrower lines by default, and drops them when the decider asks", () => {
    // A barge-in: t1's USER_TURN_FINAL was already appended in T1, then t2 superseded it, so t1
    // never gets an AGENT_TURN and its borrower line is left orphaned.
    const events = [
      rec(1, "AGENT_TURN", { text: "May I speak with Jordan?", state: "GREETING", turn_id: "opening" }),
      rec(2, "USER_TURN_FINAL", { text: "hold on", turn_id: "t1" }),
      rec(3, "TURN_SUPERSEDED", { turn_id: "t1", superseded_by: "t2" }),
      rec(4, "USER_TURN_FINAL", { text: "yes this is Jordan", turn_id: "t2" }),
      rec(5, "AGENT_TURN", { text: "Thank you, Jordan.", state: "VERIFYING_IDENTITY", turn_id: "t2" }),
    ];
    // The ledger view (console, outbox) keeps it: the borrower did say it.
    expect(buildTranscript(events).map((e) => e.text)).toEqual(["May I speak with Jordan?", "hold on", "yes this is Jordan", "Thank you, Jordan."]);
    // The prompt-assembly view drops it, so the decider never sees two borrower lines in a row.
    const forPrompt = buildTranscript(events, { excludeSuperseded: true });
    expect(forPrompt.map((e) => e.text)).toEqual(["May I speak with Jordan?", "yes this is Jordan", "Thank you, Jordan."]);
    expect(forPrompt.map((e) => e.speaker)).toEqual(["AGENT", "BORROWER", "AGENT"]);
  });

  it("excludeSuperseded leaves turns that completed, and lines with no turn_id, alone", () => {
    const events = [
      rec(1, "USER_TURN_FINAL", { text: "no turn id at all" }),
      rec(2, "USER_TURN_FINAL", { text: "a turn that finished", turn_id: "t1" }),
      rec(3, "AGENT_TURN", { text: "ok", state: "GREETING", turn_id: "t1" }),
    ];
    expect(buildTranscript(events, { excludeSuperseded: true })).toHaveLength(3);
  });

  it("timeline keeps every event, in order, with payloads intact", () => {
    const tl = buildTimeline([...happyPath].reverse());
    expect(tl.map((e) => e.sequence_no)).toEqual(happyPath.map((e) => e.sequence_no));
    expect(tl[0]?.type).toBe("CALL_STARTED");
  });
});
