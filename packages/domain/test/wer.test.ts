import { describe, expect, it } from "vitest";
import { normalizeForWer, wordErrorRate } from "../src/index.js";

describe("normalizeForWer", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Yes, this is Jordan.", "yes this is jordan"],
    ["  MIXED   Case\tand\nwhitespace ", "mixed case and whitespace"],
    ["I can't pay — I won't be paid till Friday", "i cannot pay i will not be paid till friday"],
    ["It's the full balance; that's correct!", "it is the full balance that is correct"],
    ["five hundred fifty dollars", "550 dollars"],
    ["I can pay 550 dollars on Friday", "i can pay 550 dollars on friday"],
    ["twenty one", "21"],
    ["one hundred and five", "105"],
    ["zero", "0"],
    ["twenty-one dollars", "21 dollars"],
    // Measured live: Deepgram returned "$550" against a reference of "550 dollars".
    ["$550", "550 dollars"],
    ["I can pay $550 on Friday", "i can pay 550 dollars on friday"],
    ["$1,200.50", "1200.50 dollars"],
    ["1,200 dollars", "1200 dollars"],
    // A run of bare single digits is a spoken sequence, not arithmetic: summing "five five zero" would give 10.
    ["five five zero", "550"],
    ["one two one two", "1212"],
    ["five hundred fifty", "550"],
    ["twenty one", "21"],
  ];
  for (const [input, expected] of cases) {
    it(`normalises ${JSON.stringify(input)}`, () => {
      expect(normalizeForWer(input)).toBe(expected);
    });
  }

  it("is idempotent", () => {
    for (const [input] of cases) expect(normalizeForWer(normalizeForWer(input))).toBe(normalizeForWer(input));
  });
});

describe("wordErrorRate", () => {
  it("is 0 for a perfect transcription, punctuation and casing aside", () => {
    expect(wordErrorRate("Yes, this is Jordan.", "yes this is jordan")).toEqual({
      wer: 0,
      substitutions: 0,
      insertions: 0,
      deletions: 0,
      referenceWords: 4,
    });
  });

  it("counts one substitution", () => {
    expect(wordErrorRate("yes this is Jordan", "yes this is Gordon").wer).toBe(0.25);
  });

  it("counts insertions and deletions separately", () => {
    const inserted = wordErrorRate("pay 550 friday", "pay 550 on friday");
    expect(inserted).toMatchObject({ insertions: 1, deletions: 0, substitutions: 0 });
    expect(inserted.wer).toBeCloseTo(1 / 3, 4);

    const deleted = wordErrorRate("pay 550 on friday", "pay 550 friday");
    expect(deleted).toMatchObject({ insertions: 0, deletions: 1, substitutions: 0 });
    expect(deleted.wer).toBe(0.25);
  });

  /** Deliberate: the canonical (S + I + D) / N, not the npm `word-error-rate` package's divide-by-max(len), which caps at 1 and understates a hallucinated transcript. */
  it("can exceed 1 when the transcription invents words", () => {
    const r = wordErrorRate("yes", "yes and also several other words entirely");
    expect(r.referenceWords).toBe(1);
    expect(r.insertions).toBe(6);
    expect(r.wer).toBe(6);
  });

  it("is 1 when nothing was transcribed", () => {
    expect(wordErrorRate("yes this is jordan", "")).toMatchObject({ wer: 1, deletions: 4 });
  });

  /** A WER of 0 for "we measured nothing" would silently improve every fleet average it touched. */
  it("reports an empty reference as null rather than a perfect score", () => {
    expect(wordErrorRate("", "something the agent imagined").wer).toBeNull();
    expect(wordErrorRate("  ", "").wer).toBeNull();
  });

  it("treats a spoken number and its digits as the same word", () => {
    expect(wordErrorRate("I can pay five hundred fifty dollars", "I can pay 550 dollars").wer).toBe(0);
  });

  it("does not penalise a provider for writing currency with a symbol", () => {
    expect(wordErrorRate("I can pay 550 dollars on Friday", "I can pay $550 on Friday.").wer).toBe(0);
  });
});
