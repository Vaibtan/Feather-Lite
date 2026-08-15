import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_STATES,
  IsoDate,
  IsoDateTime,
  MoneyAmount,
  TOOL_NAMES,
  TOOL_STATE_MATRIX,
  toolAllowed,
  toolsForState,
  validateToolCall,
} from "../src/index.js";

describe("tool-state matrix (SPEC §10.6)", () => {
  it("record_promise_to_pay is only callable in CONFIRMING_OUTCOME", () => {
    for (const s of CONVERSATION_STATES) {
      expect(toolAllowed("record_promise_to_pay", s)).toBe(s === "CONFIRMING_OUTCOME");
    }
  });

  it("propose_promise_to_pay is only callable in DISCUSSING_PAYMENT", () => {
    for (const s of CONVERSATION_STATES) {
      expect(toolAllowed("propose_promise_to_pay", s)).toBe(s === "DISCUSSING_PAYMENT");
    }
  });

  it("no protected-data tool is visible before verification states", () => {
    for (const s of ["GREETING", "VERIFYING_IDENTITY"] as const) {
      const visible = toolsForState(s);
      expect(visible).not.toContain("get_account_context");
      expect(visible).not.toContain("propose_promise_to_pay");
      expect(visible).not.toContain("record_promise_to_pay");
      expect(visible).not.toContain("schedule_callback");
    }
  });

  it("every tool has at least one eligible state and terminal states expose no tools", () => {
    for (const t of TOOL_NAMES) expect(TOOL_STATE_MATRIX[t].size).toBeGreaterThan(0);
    expect(toolsForState("COMPLETED")).toEqual([]);
    expect(toolsForState("ENDING")).toEqual([]);
  });
});

describe("validateToolCall — fails closed", () => {
  it("rejects a tool outside its state without touching args", () => {
    const r = validateToolCall(
      { name: "record_promise_to_pay", args: { confirmed: true } },
      "GREETING",
    );
    expect(Either.isLeft(r) && r.left._tag === "ToolNotAllowed").toBe(true);
  });

  it("rejects invalid args with a readable detail", () => {
    const r = validateToolCall(
      { name: "propose_promise_to_pay", args: { date: "2026-02-30", amount: "500" } },
      "DISCUSSING_PAYMENT",
    );
    expect(Either.isLeft(r) && r.left._tag === "ToolArgsInvalid").toBe(true);
    if (Either.isLeft(r)) expect(r.left.message).toMatch(/calendar date/);
  });

  it("record_promise_to_pay only accepts confirmed=true (amount/date come from the pending proposal)", () => {
    expect(Either.isRight(validateToolCall({ name: "record_promise_to_pay", args: { confirmed: true } }, "CONFIRMING_OUTCOME"))).toBe(true);
    expect(Either.isLeft(validateToolCall({ name: "record_promise_to_pay", args: { confirmed: false } }, "CONFIRMING_OUTCOME"))).toBe(true);
    expect(Either.isLeft(validateToolCall({ name: "record_promise_to_pay", args: { amount: "500", date: "2026-08-21" } }, "CONFIRMING_OUTCOME"))).toBe(true);
  });

  it("normalises money and dates on the way in", () => {
    const r = validateToolCall(
      { name: "propose_promise_to_pay", args: { date: "2026-08-21", amount: "$1,200" } },
      "DISCUSSING_PAYMENT",
    );
    expect(Either.isRight(r)).toBe(true);
    if (Either.isRight(r)) {
      expect(r.right.amount).toBe("1200.00");
      expect(r.right.date).toBe("2026-08-21");
    }
  });
});

describe("value schemas", () => {
  const money = Schema.decodeUnknownEither(MoneyAmount);
  const date = Schema.decodeUnknownEither(IsoDate);
  const dt = Schema.decodeUnknownEither(IsoDateTime);

  it("MoneyAmount", () => {
    expect(money(550)).toEqual(Either.right("550.00"));
    expect(money("550.5")).toEqual(Either.right("550.50"));
    expect(money("$1,200.25")).toEqual(Either.right("1200.25"));
    expect(Either.isLeft(money("two hundred"))).toBe(true);
    expect(Either.isLeft(money("0"))).toBe(true);
    expect(Either.isLeft(money("-5"))).toBe(true);
    expect(Either.isLeft(money("5.999"))).toBe(true);
  });

  it("IsoDate rejects impossible dates", () => {
    expect(Either.isRight(date("2026-02-28"))).toBe(true);
    expect(Either.isLeft(date("2026-02-30"))).toBe(true);
    expect(Either.isLeft(date("21-08-2026"))).toBe(true);
    expect(Either.isLeft(date("2026-8-1"))).toBe(true);
  });

  it("IsoDateTime requires an explicit zone and normalises to UTC", () => {
    expect(dt("2026-03-25T15:00:00+05:30")).toEqual(Either.right("2026-03-25T09:30:00Z"));
    expect(dt("2026-03-25T15:00Z")).toEqual(Either.right("2026-03-25T15:00:00Z"));
    expect(Either.isLeft(dt("2026-03-25T15:00:00"))).toBe(true); // no zone: ambiguous
    expect(Either.isLeft(dt("tomorrow at 3"))).toBe(true);
  });
});
