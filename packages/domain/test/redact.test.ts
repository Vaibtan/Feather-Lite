/**
 * What may not leave for the observability vendor, and — just as important — what must survive so
 * a redacted trace is still worth reading (D3).
 */
import { describe, expect, it } from "vitest";
import { redactAccountData, redactAccountDataDeep } from "../src/redact.js";

describe("redactAccountData", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["ISO date, the form the tools use", "I can pay on 2026-08-21.", "I can pay on [date]."],
    ["slashed date", "Let's say 8/21 then.", "Let's say [date] then."],
    ["slashed date with year", "Due 08/21/2026.", "Due [date]."],
    ["spoken month first", "That would be August 21st, 2026.", "That would be [date]."],
    ["abbreviated month", "Aug 21 works.", "[date] works."],
    ["spoken day first", "The 21st of August is fine.", "The [date] is fine."],
    ["currency symbol", "Your balance is $1,250.00 today.", "Your balance is [amount] today."],
    ["currency symbol, no decimals", "That's $550.", "That's [amount]."],
    ["spoken currency", "You owe 550 dollars.", "You owe [amount]."],
    ["bare two-decimal amount", "The amount is 550.00 and it is due soon.", "The amount is [amount] and it is due soon."],
    ["delinquency", "The account is 45 days past due.", "The account is [count] days past due."],
    ["account number", "Reference 4485939201 for the loan.", "Reference [digits] for the loan."],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(redactAccountData(input)).toBe(expected);
    });
  }

  it("leaves the conversation readable — the subject matter survives, only the facts go", () => {
    const spoken = "This is Ava from Feather-Lite Collections calling about your account. Your balance is $550.00 and it was due 2026-08-01.";
    expect(redactAccountData(spoken)).toBe("This is Ava from Feather-Lite Collections calling about your account. Your balance is [amount] and it was due [date].");
  });

  it("does not redact the borrower's name, which is a decision and not an oversight", () => {
    // A name has no shape to match, `visibleContext` is the control that keeps it out of a prompt
    // before verification, and the agent says it aloud after. See the module comment.
    expect(redactAccountData("Am I speaking with Jordan Reyes?")).toBe("Am I speaking with Jordan Reyes?");
  });

  it("leaves a borrower's own scheduling alone", () => {
    // "in three days" is when to call back, not how far behind the account is.
    expect(redactAccountData("Call me back in 3 days.")).toBe("Call me back in 3 days.");
  });

  it("leaves small whole numbers alone, so counts and durations still read", () => {
    expect(redactAccountData("This is attempt 2 of 5.")).toBe("This is attempt 2 of 5.");
  });

  it("is idempotent, so a doubly-masked payload is not mangled", () => {
    const once = redactAccountData("Balance $550.00 due 2026-08-21.");
    expect(redactAccountData(once)).toBe(once);
  });
});

describe("redactAccountData: the phrasing the fleet actually uses (review #13)", () => {
  const masked: ReadonlyArray<readonly [string, string, string]> = [
    ["a bare amount after a payment verb", "I can pay 550 on Friday.", "I can pay [amount] on Friday."],
    ["with a hedge in between", "I could probably do about 300 next week.", "I could probably do about [amount] next week."],
    ["what is owed", "You owe 1,250 on this account.", "You owe [amount] on this account."],
    ["a noun instead of a verb", "The balance is 1250 as of today.", "The balance is [amount] as of today."],
    ["the minimum", "Your minimum payment of 75 is due soon.", "Your minimum payment of [amount] is due soon."],
    ["a phone number", "Call me on 555-123-4567 instead.", "Call me on [digits] instead."],
    ["a hyphenated account reference", "The reference is 4485-9392-01.", "The reference is [digits]."],
  ];
  for (const [name, input, expected] of masked) {
    it(name, () => {
      expect(redactAccountData(input)).toBe(expected);
    });
  }

  const survives: ReadonlyArray<readonly [string, string]> = [
    // The counter-cases are the point. A redactor that ate these would be the instrument-that-lies
    // problem in a different place: a masked measurement is worse than an unmasked one.
    ["a turn count", "This is attempt 2 of 5."],
    ["the borrower's own scheduling", "I can pay in 3 days."],
    ["a duration", "Give me 5 minutes to find the card."],
    ["a proportion", "That covers 40 percent of it."],
    ["a latency, written out", "The turn took 1234 ms."],
    ["a date the agent read back", "Call me on the 21st."],
  ];
  for (const [name, input] of survives) {
    it(`leaves ${name} alone`, () => {
      expect(redactAccountData(input)).toBe(input);
    });
  }

  it("still knows a hyphenated date from a hyphenated identifier", () => {
    expect(redactAccountData("Due 8-21-2026.")).toBe("Due [date].");
  });
});

describe("redactAccountDataDeep", () => {
  it("walks a prompt's message array and leaves the measurements intact", () => {
    const input = {
      messages: [
        { role: "system", content: "Balance due: $550.00. Due date: 2026-08-21." },
        { role: "user", content: "I can pay 550 dollars on Friday." },
      ],
      ttft_ms: 1234,
      cached_tokens: 1792,
      superseded: false,
      nothing: null,
    };
    expect(redactAccountDataDeep(input)).toEqual({
      messages: [
        { role: "system", content: "Balance due: [amount]. Due date: [date]." },
        { role: "user", content: "I can pay [amount] on Friday." },
      ],
      ttft_ms: 1234,
      cached_tokens: 1792,
      superseded: false,
      nothing: null,
    });
  });


  it("masks an account fact that arrives as a number under its own key (review #13)", () => {
    // A tool result is a structure, not a sentence: `{"balance_due": 1250}` carries the balance
    // with none of the shape the text rules match on. The key is the evidence, so the allowlist is
    // of keys — and it is an allowlist, not a pattern, so widening it is a decision someone makes.
    expect(
      redactAccountDataDeep({
        balance_due: 1250,
        minimum_payment: 75,
        days_past_due: 45,
        account_number: 4485939201,
        // Not account facts. These are the measurements, and they must come through untouched.
        ttft_ms: 1234,
        cached_tokens: 1792,
        turn_index: 3,
      }),
    ).toEqual({
      balance_due: "[amount]",
      minimum_payment: "[amount]",
      days_past_due: "[count]",
      account_number: "[digits]",
      ttft_ms: 1234,
      cached_tokens: 1792,
      turn_index: 3,
    });
  });

  it("masks the same fact when the tool serialised it as a string", () => {
    expect(redactAccountDataDeep({ balance_due: "1250" })).toEqual({ balance_due: "[amount]" });
  });

  it("reaches an account fact nested in a tool result", () => {
    expect(redactAccountDataDeep({ tool: "get_account", result: { account: { balance_due: 1250 } } })).toEqual({
      tool: "get_account",
      result: { account: { balance_due: "[amount]" } },
    });
  });

  it("never touches keys, only values", () => {
    expect(redactAccountDataDeep({ "2026-08-21": "x" })).toEqual({ "2026-08-21": "x" });
  });
});
