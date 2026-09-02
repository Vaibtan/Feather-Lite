/**
 * "Hold on, let me get my card" — the borrower asking for time (issue #1, D1's `wait`).
 *
 * A reviewable lexicon rather than a model (Q3, and user story 24: the classifiers are pure domain
 * functions with table tests, so their lexicons are reviewable and their misses reproducible).
 */
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
  ];
  for (const t of holds) it(`treats ${JSON.stringify(t)} as a hold`, () => expect(holdRequest(t)).toBe(true));

  const notHolds = [
    // The near-miss that matters most: a hold phrase with real content after it is not a hold. If
    // this were a hold the agent would say nothing and the borrower's offer would be dropped.
    "hold on, I can pay Friday",
    "hold on, that's not my account",
    "wait, that's the wrong amount",
    "give me a minute to explain why this is wrong",
    "yes",
    "yes this is Jordan",
    "I can pay 550 on Friday",
    "no",
    "",
    "   ",
    // Long enough to carry content even without a keyword collision.
    "let me check my calendar and I will call you back tomorrow afternoon",
  ];
  for (const t of notHolds) it(`does not treat ${JSON.stringify(t)} as a hold`, () => expect(holdRequest(t)).toBe(false));

  it("is insensitive to case, punctuation and filler", () => {
    expect(holdRequest("  HOLD ON!!  ")).toBe(true);
    expect(holdRequest("uh, one second...")).toBe(true);
  });
});
