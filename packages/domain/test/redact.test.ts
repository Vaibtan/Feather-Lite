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

  it("never touches keys, only values", () => {
    expect(redactAccountDataDeep({ "2026-08-21": "x" })).toEqual({ "2026-08-21": "x" });
  });
});
