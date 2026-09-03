import { describe, expect, it } from "vitest";
import { holdRequest } from "../src/holdRequest.js";

describe("holdRequest", () => {
  const holds = [
    "hold on",
    "Hold on.",
    "hold on a second",
    "one second",
    "one sec",
    "just a second",
    "hang on",
    "hang on a minute",
    "let me check",
    "let me go get my card",
    "give me a minute",
    "just a moment",
    "wait",
    "wait a moment",
    "um, hold on",
    "Actually, wait.",
    "actually hold on",
    "oh, hang on",
    "hmm, let me check",
    "right, one second",
  ];
  for (const t of holds) it(`treats ${JSON.stringify(t)} as a hold`, () => expect(holdRequest(t)).not.toBeNull());

  const notHolds = [
    "hold on, I can pay Friday",
    "hold on, that's not my account",
    "wait, that's the wrong amount",
    "actually, that's the wrong amount",
    "oh, that's not my account",
    "right, that's not my account",
    "give me a minute to explain why this is wrong",
    "yes",
    "yes this is Jordan",
    "I can pay 550 on Friday",
    "no",
    "",
    "   ",
    "let me check my calendar and I will call you back tomorrow afternoon",
  ];
  for (const t of notHolds) it(`does not treat ${JSON.stringify(t)} as a hold`, () => expect(holdRequest(t)).toBeNull());

  it("is insensitive to case, punctuation and filler", () => {
    expect(holdRequest("  HOLD ON!!  ")).not.toBeNull();
    expect(holdRequest("uh, one second...")).not.toBeNull();
  });

  it("reports the phrase that matched, not the leading filler", () => {
    expect(holdRequest("Actually, wait.")?.phrase).toBe("wait");
    expect(holdRequest("oh, hang on a minute")?.phrase).toBe("hang on");
  });

  const bare = ["wait", "Actually, wait.", "hold on", "one second", "just a moment", "bear with me"];
  for (const t of bare) it(`reads ${JSON.stringify(t)} as a bare hold`, () => expect(holdRequest(t)?.kind).toBe("bare"));

  const errand = ["hold on, let me get my card", "let me check", "let me find my wallet", "give me a minute", "hang on a minute", "one second, let me grab my phone"];
  for (const t of errand) it(`reads ${JSON.stringify(t)} as an errand hold`, () => expect(holdRequest(t)?.kind).toBe("errand"));
});
