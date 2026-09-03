import { describe, expect, it } from "vitest";
import { spanMask } from "../../src/services/Tracing.js";

describe("spanMask (the Langfuse export boundary)", () => {
  it("masks the account facts in a turn span's input and output", () => {
    const attribute = JSON.stringify({
      input: { user_text: "I can pay 550 dollars on 2026-08-21." },
      output: { agent_text: "Your balance is $550.00, and it was due 2026-08-01.", tool: "record_promise_to_pay", outcome: "PROMISE_TO_PAY" },
    });
    const masked = JSON.parse(spanMask({ data: attribute }) as string) as { input: { user_text: string }; output: { agent_text: string; tool: string; outcome: string } };
    expect(masked.input.user_text).toBe("I can pay [amount] on [date].");
    expect(masked.output.agent_text).toBe("Your balance is [amount], and it was due [date].");
    expect(masked.output.tool).toBe("record_promise_to_pay");
    expect(masked.output.outcome).toBe("PROMISE_TO_PAY");
  });

  it("masks the generation's prompt, which is where the whole protected block lives", () => {
    const attribute = JSON.stringify({
      messages: [
        { role: "system", content: "ACCOUNT\nbalance_due: $1,250.00\ndue_date: 2026-08-01\ndelinquency_days: 45 days past due" },
        { role: "user", content: "How much do I owe?" },
      ],
    });
    const masked = spanMask({ data: attribute }) as string;
    expect(masked).not.toContain("1,250.00");
    expect(masked).not.toContain("2026-08-01");
    expect(masked).toContain("[amount]");
    expect(masked).toContain("[date]");
    expect(masked).toContain("[count] days past due");
  });

  it("leaves the latency metadata alone — a masked measurement is a lying instrument", () => {
    const attribute = JSON.stringify({ latency_decide_ttft_ms: 1234, latency_eou_delay_ms: 578, state: "DISCUSSING_PAYMENT", superseded: false });
    expect(JSON.parse(spanMask({ data: attribute }) as string)).toEqual({ latency_decide_ttft_ms: 1234, latency_eou_delay_ms: 578, state: "DISCUSSING_PAYMENT", superseded: false });
  });

  it("masks the phrasing the fleet actually speaks, and the shapes a tool actually returns", () => {
    const attribute = JSON.stringify({
      input: { user_text: "I can pay 550, call me on 555-123-4567." },
      output: { tool: "record_promise_to_pay", args: { balance_due: 1250, days_past_due: 45 } },
    });
    const masked = JSON.parse(spanMask({ data: attribute }) as string) as {
      input: { user_text: string };
      output: { tool: string; args: { balance_due: unknown; days_past_due: unknown } };
    };
    expect(masked.input.user_text).toBe("I can pay [amount], call me on [digits].");
    expect(masked.output.args).toEqual({ balance_due: "[amount]", days_past_due: "[count]" });
    expect(masked.output.tool).toBe("record_promise_to_pay");
  });

  it("still leaves every measurement alone, which is the counter-case the new rules risk", () => {
    const attribute = JSON.stringify({
      latency_decide_ttft_ms: 1234,
      turn_index: 3,
      agent_text: "This is attempt 2 of 5. Call me back in 3 days, that covers 40 percent.",
    });
    expect(JSON.parse(spanMask({ data: attribute }) as string)).toEqual({
      latency_decide_ttft_ms: 1234,
      turn_index: 3,
      agent_text: "This is attempt 2 of 5. Call me back in 3 days, that covers 40 percent.",
    });
  });

  it("returns valid JSON, so a redaction can never break the attribute it edits", () => {
    const attribute = JSON.stringify({ agent_text: 'She said "pay $550.00 by 2026-08-21" — right?' });
    expect(() => JSON.parse(spanMask({ data: attribute }) as string)).not.toThrow();
    expect(JSON.parse(spanMask({ data: attribute }) as string)).toEqual({ agent_text: 'She said "pay [amount] by [date]" — right?' });
  });

  it("masks a plain string attribute that is not JSON at all", () => {
    expect(spanMask({ data: "balance $550.00" })).toBe("balance [amount]");
  });

  it("masks a structure handed over unserialised", () => {
    expect(spanMask({ data: { note: "due 2026-08-21" } })).toEqual({ note: "due [date]" });
  });
});
