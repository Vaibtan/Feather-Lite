import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { OVERRIDE_PRECEDENCE, matchOverride, normalizeUtterance } from "../src/index.js";

const reasonOf = (text: string, name?: string) =>
  Option.getOrNull(matchOverride(text, { borrowerFirstName: name }))?.reason ?? null;

describe("normalizeUtterance", () => {
  it("expands contractions and strips punctuation so STT variants converge", () => {
    expect(normalizeUtterance("I can't afford it!")).toBe("i cannot afford it");
    expect(normalizeUtterance("I can not afford it")).toBe("i cannot afford it");
    expect(normalizeUtterance("Don’t call me again.")).toBe("do not call me again");
    expect(normalizeUtterance("  I'm   NOT Jordan,   ok?  ")).toBe("i am not jordan ok");
  });
});

describe("matchOverride — the phrases the Python stub missed (review §5.6)", () => {
  it.each([
    ["please don't call me anymore", "OPT_OUT"],
    ["stop calling me", "OPT_OUT"],
    ["remove my number from your list", "OPT_OUT"],
    ["this is harassment, stop", "OPT_OUT"],
    ["I do not owe you anything", "DISPUTE"],
    ["I dispute this debt", "DISPUTE"],
    ["that's not my debt", "DISPUTE"],
    ["prove I owe this", "DISPUTE"],
    ["I already paid this off last month", "DISPUTE"],
    ["talk to my lawyer", "DISPUTE"],
    ["I'm unemployed right now", "HARDSHIP"],
    ["I lost my job and cannot afford this", "HARDSHIP"],
    ["I can't afford it", "HARDSHIP"],
    ["I'm going through bankruptcy", "HARDSHIP"],
    ["I've been in the hospital", "HARDSHIP"],
    ["you've got the wrong guy", "WRONG_NUMBER"],
    ["wrong number", "WRONG_NUMBER"],
    ["there's no one by that name here", "WRONG_NUMBER"],
    ["he doesn't live here anymore", "WRONG_NUMBER"],
    ["she moved out last year", "WRONG_NUMBER"],
  ])("%s -> %s", (text, expected) => {
    expect(reasonOf(text)).toBe(expected);
  });
});

describe("matchOverride — borrower-name aware wrong-party rules", () => {
  it("'I am not <name>' is a wrong-number signal when the name is known", () => {
    expect(reasonOf("I am not Jordan, he moved out", "Jordan")).toBe("WRONG_NUMBER");
    expect(reasonOf("this is not jordan", "Jordan")).toBe("WRONG_NUMBER");
    expect(reasonOf("there is no Jordan here", "Jordan")).toBe("WRONG_NUMBER");
  });

  it("does not fire on the name alone or on affirmations", () => {
    expect(reasonOf("yes this is Jordan", "Jordan")).toBeNull();
    expect(reasonOf("Jordan speaking", "Jordan")).toBeNull();
  });
});

describe("matchOverride — negatives (must reach the LLM, not an override)", () => {
  it.each([
    "yes this is Jordan",
    "speaking",
    "I can pay 550 on Friday",
    "call me back tomorrow",
    "who is this?",
    "the borrower is not available right now", // third party, NOT wrong number
    "this is his mother, he's at work", // third party
    "can you tell me the balance again",
    "I need a few more days",
    "let me think about it",
  ])("%s -> no override", (text) => {
    expect(reasonOf(text, "Jordan")).toBeNull();
  });
});

describe("matchOverride — precedence (SPEC §8.4)", () => {
  it("OPT_OUT beats DISPUTE beats HARDSHIP beats WRONG_NUMBER", () => {
    expect(OVERRIDE_PRECEDENCE).toEqual(["OPT_OUT", "DISPUTE", "HARDSHIP", "WRONG_NUMBER"]);
    expect(reasonOf("I dispute this and stop calling me")).toBe("OPT_OUT");
    expect(reasonOf("I lost my job and I dispute this")).toBe("DISPUTE");
    expect(reasonOf("wrong number and I lost my job")).toBe("HARDSHIP");
  });

  it("returns the rule that matched, for QA", () => {
    const m = Option.getOrThrow(matchOverride("stop calling me"));
    expect(m.targetState).toBe("OPT_OUT");
    expect(m.matched).toBe("stop calling");
  });

  it("empty or whitespace input never matches", () => {
    expect(Option.isNone(matchOverride(""))).toBe(true);
    expect(Option.isNone(matchOverride("   "))).toBe(true);
  });
});
