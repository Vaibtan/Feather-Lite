/**
 * The deterministic post-call evaluator (spec 2026-08-26, D2).
 *
 * Everything it reports is already in the ledger, so these are event fixtures in and facts out —
 * no database, no LLM. The fixtures follow `replay.test.ts`: build the events in the exact JSON
 * shape the orchestrator writes, then assert on the derived facts.
 */
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeEventRecord, disclosesProtectedDetail, evaluateCall, openingScript, PROTECTED_DISCLOSURE_PATTERNS, thirdPartyClose, wrongNumberClose, type EventRecord } from "../src/index.js";

const rec = (sequence_no: number, type: string, payload: Record<string, unknown>, secondOffset = sequence_no): EventRecord => {
  const decoded = decodeEventRecord({ sequence_no, created_at: `2026-08-16T10:00:${String(secondOffset).padStart(2, "0")}.000Z`, type, payload });
  if (Either.isLeft(decoded)) throw new Error(`fixture invalid: ${type} ${JSON.stringify(payload)}`);
  return decoded.right;
};

/** A compliant happy path: disclosure first, verified, promise read back in full and heard. */
const happyPath: ReadonlyArray<EventRecord> = [
  rec(1, "CALL_STARTED", { workflow_execution_id: "w", call_attempt_id: "a", contact_point_id: "c", channel: "voice", attempt_no: 1 }, 0),
  rec(2, "STATE_TRANSITION", { from: null, to: "GREETING", triggered_by: "SYSTEM_START" }, 0),
  rec(3, "AGENT_TURN", { text: "This is Ava calling from Feather-Lite Collections. This is an attempt to collect a debt, and any information obtained will be used for that purpose. May I please speak with Jordan?", state: "GREETING", speak_mode: "non_interruptible" }, 1),
  rec(4, "USER_TURN_FINAL", { text: "yes this is Jordan", turn_id: "t1" }, 5),
  rec(5, "TOOL_CALLED", { name: "confirm_right_party", tool_call_id: "tc1", args: { confirmed: true } }, 5),
  rec(6, "TOOL_RESULT", { name: "confirm_right_party", tool_call_id: "tc1", result: { confirmed: true } }, 5),
  rec(7, "STATE_TRANSITION", { from: "GREETING", to: "DISCUSSING_PAYMENT", triggered_by: "RIGHT_PARTY_CONFIRMED" }, 5),
  rec(8, "AGENT_TURN", { text: "Thank you Jordan. Your balance due is 550 dollars.", state: "DISCUSSING_PAYMENT", turn_id: "t1" }, 6),
  rec(9, "AGENT_TURN_PLAYOUT", { turn_id: "t1", heard_text: "Thank you Jordan. Your balance due is 550 dollars.", interrupted: false }, 9),
  rec(10, "USER_TURN_FINAL", { text: "I can pay 550 on Friday", turn_id: "t2" }, 12),
  rec(11, "TOOL_CALLED", { name: "propose_promise_to_pay", tool_call_id: "tc2", args: { amount: "550.00", date: "2026-08-21" } }, 12),
  rec(12, "TOOL_RESULT", { name: "propose_promise_to_pay", tool_call_id: "tc2", result: { amount: "550.00", date: "2026-08-21" } }, 12),
  rec(13, "STATE_TRANSITION", { from: "DISCUSSING_PAYMENT", to: "CONFIRMING_OUTCOME", triggered_by: "PROPOSAL" }, 12),
  rec(14, "AGENT_TURN", { text: "To confirm: you will pay 550 dollars by Friday, August 21, 2026. Is that correct?", state: "CONFIRMING_OUTCOME", turn_id: "t2" }, 13),
  rec(15, "AGENT_TURN_PLAYOUT", { turn_id: "t2", heard_text: "To confirm: you will pay 550 dollars by Friday, August 21, 2026. Is that correct?", interrupted: false }, 18),
  rec(16, "USER_TURN_FINAL", { text: "yes", turn_id: "t3" }, 20),
  rec(17, "TOOL_CALLED", { name: "record_promise_to_pay", tool_call_id: "tc3", args: { confirmed: true } }, 20),
  rec(18, "TOOL_RESULT", { name: "record_promise_to_pay", tool_call_id: "tc3", result: { recorded: true } }, 20),
  rec(19, "AGENT_TURN", { text: "Thank you. I have recorded your promise to pay 550 dollars by Friday, August 21, 2026. Goodbye.", state: "CONFIRMING_OUTCOME", turn_id: "t3" }, 21),
  rec(20, "CALL_ENDED", { final_outcome: "PROMISE_TO_PAY" }, 25),
];

describe("evaluateCall — compliance", () => {
  it("passes every check on a compliant call", () => {
    const e = evaluateCall(happyPath);
    expect(e.miniMirandaFirst).toBe(true);
    expect(e.noProtectedBeforeRpc).toBe(true);
    expect(e.noPromiseWithoutReadback).toBe(true);
    expect(e.complianceOk).toBe(true);
    expect(e.issues).toEqual([]);
  });

  it("fails the Mini-Miranda check when the first agent line omits the disclosure", () => {
    const events = happyPath.map((ev) => (ev.sequence_no === 3 ? rec(3, "AGENT_TURN", { text: "Hi, is Jordan there?", state: "GREETING" }, 1) : ev));
    const e = evaluateCall(events);
    expect(e.miniMirandaFirst).toBe(false);
    expect(e.issues).toContain("MINI_MIRANDA_MISSING");
    expect(e.complianceOk).toBe(false);
  });

  it("catches account detail spoken before right-party confirmation", () => {
    // The balance line moves ahead of the RIGHT_PARTY_CONFIRMED transition.
    const events = [
      ...happyPath.slice(0, 3),
      rec(4, "AGENT_TURN", { text: "Your balance due is 550 dollars and you are 15 days delinquent.", state: "GREETING" }, 2),
      ...happyPath.slice(3),
    ];
    const e = evaluateCall(events);
    expect(e.noProtectedBeforeRpc).toBe(false);
    expect(e.issues).toContain("PROTECTED_CONTEXT_BEFORE_VERIFICATION");
  });

  it("does not treat the promise read-back's own amount as a protected-data leak", () => {
    // The read-back is spoken after verification; the check must be positional, not textual.
    const e = evaluateCall(happyPath);
    expect(e.noProtectedBeforeRpc).toBe(true);
  });

  it("fails the read-back check when the promise was recorded after an interrupted read-back", () => {
    // Same events, but the borrower talked over the read-back — the ledger says it was not heard in
    // full, so a promise recorded anyway means the fully-heard guard did not hold.
    const events = happyPath.map((ev) =>
      ev.sequence_no === 15 ? rec(15, "AGENT_TURN_PLAYOUT", { turn_id: "t2", heard_text: "To confirm: you will pay", interrupted: true }, 18) : ev,
    );
    const e = evaluateCall(events);
    expect(e.noPromiseWithoutReadback).toBe(false);
    expect(e.issues).toContain("PROMISE_WITHOUT_READBACK");
    expect(e.complianceOk).toBe(false);
  });

  it("checks the read-back, not whatever the agent said last, when a side-question intervenes", () => {
    // The borrower asks something in CONFIRMING_OUTCOME and the agent answers: a plain AGENT_TURN
    // with no tool call, whose own playout the borrower legitimately talked over. The read-back
    // before it was heard in full, so the promise is compliant. Identifying the read-back as "the
    // last agent line before the record" would fail this call, so the sequence numbers here put the
    // side-question strictly between the read-back and the record.
    const events: ReadonlyArray<EventRecord> = [
      ...happyPath.slice(0, 15), // ... up to and including the read-back's playout (seq 15)
      rec(16, "USER_TURN_FINAL", { text: "wait, will this show on my credit report?", turn_id: "t2b" }, 19),
      rec(17, "AGENT_TURN", { text: "I am not able to advise on credit reporting. Shall I go ahead?", state: "CONFIRMING_OUTCOME", turn_id: "t2b" }, 19),
      rec(18, "AGENT_TURN_PLAYOUT", { turn_id: "t2b", heard_text: "I am not able to advise on", interrupted: true }, 19),
      rec(19, "USER_TURN_FINAL", { text: "yes", turn_id: "t3" }, 20),
      rec(20, "TOOL_CALLED", { name: "record_promise_to_pay", tool_call_id: "tc3", args: { confirmed: true } }, 20),
      rec(21, "TOOL_RESULT", { name: "record_promise_to_pay", tool_call_id: "tc3", result: { recorded: true } }, 20),
      rec(22, "AGENT_TURN", { text: "Thank you. I have recorded your promise to pay 550 dollars by Friday, August 21, 2026. Goodbye.", state: "CONFIRMING_OUTCOME", turn_id: "t3" }, 21),
      rec(23, "CALL_ENDED", { final_outcome: "PROMISE_TO_PAY" }, 25),
    ];
    const e = evaluateCall(events);
    expect(e.noPromiseWithoutReadback).toBe(true);
    expect(e.issues).toEqual([]);
  });

  it("checks the repeated read-back after a rejection, not the first one", () => {
    // The first read-back was talked over, the guard rejected the record, the agent repeated it,
    // and the repeat was heard in full. The promise that follows is compliant.
    const events: ReadonlyArray<EventRecord> = [
      ...happyPath.slice(0, 14),
      rec(140, "AGENT_TURN", { text: "To confirm: you will pay 550 dollars by Friday, August 21, 2026.", state: "CONFIRMING_OUTCOME", turn_id: "t2" }, 13),
      rec(141, "AGENT_TURN_PLAYOUT", { turn_id: "t2", heard_text: "To confirm: you will", interrupted: true }, 14),
      rec(142, "USER_TURN_FINAL", { text: "yes", turn_id: "t3" }, 15),
      rec(143, "TOOL_CALLED", { name: "record_promise_to_pay", tool_call_id: "tcA", args: { confirmed: true } }, 15),
      rec(144, "TOOL_REJECTED", { name: "record_promise_to_pay", tool_call_id: "tcA", state: "CONFIRMING_OUTCOME", reason: "INVALID_ARGS", detail: "read-back was interrupted; repeating it" }, 15),
      rec(145, "AGENT_TURN", { text: "Let me repeat that. To confirm: you will pay 550 dollars by Friday, August 21, 2026.", state: "CONFIRMING_OUTCOME", turn_id: "t3" }, 16),
      rec(146, "AGENT_TURN_PLAYOUT", { turn_id: "t3", heard_text: "Let me repeat that. To confirm: you will pay 550 dollars by Friday, August 21, 2026.", interrupted: false }, 21),
      rec(147, "USER_TURN_FINAL", { text: "yes", turn_id: "t4" }, 23),
      rec(148, "TOOL_CALLED", { name: "record_promise_to_pay", tool_call_id: "tcB", args: { confirmed: true } }, 23),
      rec(149, "TOOL_RESULT", { name: "record_promise_to_pay", tool_call_id: "tcB", result: { recorded: true } }, 23),
      rec(150, "AGENT_TURN", { text: "Thank you. I have recorded your promise to pay 550 dollars by Friday, August 21, 2026. Goodbye.", state: "CONFIRMING_OUTCOME", turn_id: "t4" }, 24),
      rec(151, "CALL_ENDED", { final_outcome: "PROMISE_TO_PAY" }, 25),
    ];
    const e = evaluateCall(events);
    expect(e.noPromiseWithoutReadback).toBe(true);
    expect(e.toolRejectionCount).toBe(1);
    expect(e.toolRejections).toEqual({ INVALID_ARGS: 1 });
  });

  it("reports the read-back check as not applicable when no promise was recorded", () => {
    const events = happyPath.filter((ev) => ev.sequence_no < 17);
    const e = evaluateCall(events);
    expect(e.noPromiseWithoutReadback).toBeNull();
    expect(e.issues).toEqual([]);
  });

  it("does not fault a simulated call that has no playout events at all", () => {
    // A JSON simulation records no audio, so "was it heard in full" has no evidence either way.
    const events = happyPath.filter((ev) => ev.type !== "AGENT_TURN_PLAYOUT");
    const e = evaluateCall(events);
    expect(e.noPromiseWithoutReadback).toBeNull();
    expect(e.complianceOk).toBe(true);
  });
});

describe("evaluateCall — call facts", () => {
  it("counts the shape of the call", () => {
    const e = evaluateCall(happyPath);
    expect(e.rightPartyVerified).toBe(true);
    expect(e.voicemail).toBe(false);
    expect(e.agentTurns).toBe(4);
    expect(e.borrowerTurns).toBe(3);
    expect(e.bargeInCount).toBe(0);
    expect(e.noInputCount).toBe(0);
    expect(e.degradedTurns).toBe(0);
    expect(e.toolRejectionCount).toBe(0);
    // CALL_STARTED at :00 to CALL_ENDED at :25.
    expect(e.durationMs).toBe(25_000);
  });

  it("counts barge-ins, no-input strikes, degraded turns and tool rejections by reason", () => {
    const events: ReadonlyArray<EventRecord> = [
      ...happyPath.slice(0, 4),
      rec(100, "TURN_SUPERSEDED", { turn_id: "t1", superseded_by: "t1b" }, 6),
      rec(101, "TURN_SUPERSEDED", { turn_id: "t1b", superseded_by: "t1c" }, 7),
      rec(102, "NO_INPUT", { state: "DISCUSSING_PAYMENT", count: 1 }, 30),
      rec(103, "AGENT_TURN", { text: "I'm sorry, could you say that again?", state: "DISCUSSING_PAYMENT", degraded: true }, 31),
      rec(104, "TOOL_REJECTED", { name: "record_promise_to_pay", state: "DISCUSSING_PAYMENT", reason: "NOT_ALLOWED", detail: "wrong state" }, 32),
      rec(105, "TOOL_REJECTED", { name: "record_promise_to_pay", state: "CONFIRMING_OUTCOME", reason: "INVALID_ARGS", detail: "read-back was interrupted" }, 33),
      rec(106, "TOOL_REJECTED", { name: "invent_discount", state: "DISCUSSING_PAYMENT", reason: "UNKNOWN_TOOL", detail: "no such tool" }, 34),
      rec(107, "TOOL_REJECTED", { name: "record_promise_to_pay", state: "CONFIRMING_OUTCOME", reason: "INVALID_ARGS", detail: "read-back was interrupted" }, 35),
    ];
    const e = evaluateCall(events);
    expect(e.bargeInCount).toBe(2);
    expect(e.noInputCount).toBe(1);
    expect(e.degradedTurns).toBe(1);
    expect(e.toolRejectionCount).toBe(4);
    expect(e.toolRejections).toEqual({ NOT_ALLOWED: 1, INVALID_ARGS: 2, UNKNOWN_TOOL: 1 });
  });

  it("reads voicemail from the AMD result, not from the outcome", () => {
    const events: ReadonlyArray<EventRecord> = [
      happyPath[0]!,
      rec(2, "AMD_RESULT", { result: "MACHINE", confidence: 0.9 }, 1),
      rec(3, "AGENT_TURN", { text: "Hello, this is Ava from Feather-Lite Collections. Please return our call.", state: "VOICEMAIL" }, 2),
      rec(4, "CALL_ENDED", { final_outcome: "VOICEMAIL_LEFT" }, 10),
    ];
    const e = evaluateCall(events);
    expect(e.voicemail).toBe(true);
    expect(e.rightPartyVerified).toBe(false);
    // A voicemail is FDCPA-safe precisely by NOT reciting the Mini-Miranda, so the check must not
    // fire on one — it is scored as not applicable rather than as a failure.
    expect(e.miniMirandaFirst).toBeNull();
    expect(e.issues).toEqual([]);
  });

  it("returns a null duration when the call has not ended", () => {
    const e = evaluateCall(happyPath.filter((ev) => ev.type !== "CALL_ENDED"));
    expect(e.durationMs).toBeNull();
  });
});

describe("protected-disclosure patterns", () => {
  const ctx = {
    agent_name: "Ava",
    company: "Feather-Lite Collections",
    callback_number: "+1 800 555 0100",
    workflow_type: "PAYMENT_REMINDER",
    attempt_no: 1,
    local_time_description: "Friday, 21 August 2026, 2:05 PM",
    borrower_first_name: "Jordan",
  };

  /**
   * Everything the agent is allowed to say *before* right-party confirmation. A pattern that fires
   * on any of these would fail every compliant call, and an alert that cries wolf gets ignored —
   * which is worse than not having it.
   */
  it("does not fire on any line the agent may speak before verification", () => {
    for (const line of [openingScript(ctx), thirdPartyClose(), wrongNumberClose(), "May I please speak with Jordan?", "I can hold if now is a bad time."]) {
      expect(disclosesProtectedDetail(line)).toBe(false);
    }
  });

  it("fires on the account talk each protected field is spoken as", () => {
    expect(disclosesProtectedDetail("Your balance is 550 dollars.")).toBe(true);
    expect(disclosesProtectedDetail("The amount due is 550 dollars.")).toBe(true);
    expect(disclosesProtectedDetail("Your due date was the first.")).toBe(true);
    expect(disclosesProtectedDetail("The account is delinquent.")).toBe(true);
    expect(disclosesProtectedDetail("You are 15 days late.")).toBe(true);
    expect(disclosesProtectedDetail("You previously promised to pay on the tenth.")).toBe(true);
  });

  /**
   * The map is keyed by protected field so the two halves of "protected" cannot drift. A new field
   * on `ProtectedContext` fails to compile here until someone decides how it sounds; this asserts
   * the deliberate `null` is a decision rather than an oversight.
   */
  it("has an entry for every protected field, with the name deliberately structural", () => {
    expect(Object.keys(PROTECTED_DISCLOSURE_PATTERNS).sort()).toEqual([
      "balance_due",
      "borrower_full_name",
      "delinquency_days",
      "due_date",
      "last_promise_date",
      "loan_status",
    ]);
    expect(PROTECTED_DISCLOSURE_PATTERNS.borrower_full_name).toBeNull();
  });
});
