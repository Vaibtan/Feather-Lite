/**
 * Word error rate and its normaliser (spec 2026-08-26, D4).
 *
 * The normaliser is the load-bearing half: WER over raw strings measures punctuation and casing,
 * which no STT is being graded on. These are table tests because each rule has to be pinned
 * individually — a normaliser that quietly stops expanding contractions moves every number on the
 * fleet report and nothing fails.
 */
import { describe, expect, it } from "vitest";
import { normalizeForWer, wordErrorRate } from "../src/index.js";

describe("normalizeForWer", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Yes, this is Jordan.", "yes this is jordan"],
    ["  MIXED   Case\tand\nwhitespace ", "mixed case and whitespace"],
    ["I can't pay — I won't be paid till Friday", "i cannot pay i will not be paid till friday"],
    ["It's the full balance; that's correct!", "it is the full balance that is correct"],
    // Number words map to digits one way, so "550" and "five hundred fifty" compare equal.
    ["five hundred fifty dollars", "550 dollars"],
    ["I can pay 550 dollars on Friday", "i can pay 550 dollars on friday"],
    ["twenty one", "21"],
    ["one hundred and five", "105"],
    ["zero", "0"],
    // Hyphens inside a compound number are a spelling choice, not a transcription error.
    ["twenty-one dollars", "21 dollars"],
    // Currency and thousands separators are formatting, not transcription: measured live, Deepgram
    // returned "$550" against a reference of "550 dollars".
    ["$550", "550 dollars"],
    ["I can pay $550 on Friday", "i can pay 550 dollars on friday"],
    ["$1,200.50", "1200.50 dollars"],
    ["1,200 dollars", "1200 dollars"],
    // A run of bare single digits is a spoken sequence, not arithmetic. "five five zero" is one way
    // an STT renders 550; adding it up would give 10.
    ["five five zero", "550"],
    ["one two one two", "1212"],
    // ...but a run containing a tens or scale word is arithmetic, and still folds.
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
    // 4 reference words, one wrong.
    expect(wordErrorRate("yes this is Jordan", "yes this is Gordon").wer).toBe(0.25);
  });

  it("counts insertions and deletions separately", () => {
    const inserted = wordErrorRate("pay 550 friday", "pay 550 on friday");
    expect(inserted).toMatchObject({ insertions: 1, deletions: 0, substitutions: 0 });
    // Rates are rounded to four decimals; anything finer is noise on a three-line script.
    expect(inserted.wer).toBeCloseTo(1 / 3, 4);

    const deleted = wordErrorRate("pay 550 on friday", "pay 550 friday");
    expect(deleted).toMatchObject({ insertions: 0, deletions: 1, substitutions: 0 });
    expect(deleted.wer).toBe(0.25);
  });

  /**
   * The canonical definition is (S + I + D) / N, which can exceed 1 when the hypothesis is longer
   * than the reference. The npm `word-error-rate` package divides by max(len) instead, capping at
   * 1 and understating a badly hallucinated transcript — the spec calls that out by name.
   */
  it("can exceed 1 when the transcription invents words", () => {
    const r = wordErrorRate("yes", "yes and also several other words entirely");
    expect(r.referenceWords).toBe(1);
    expect(r.insertions).toBe(6);
    expect(r.wer).toBe(6);
  });

  it("is 1 when nothing was transcribed", () => {
    expect(wordErrorRate("yes this is jordan", "")).toMatchObject({ wer: 1, deletions: 4 });
  });

  /**
   * An empty reference has no words to be wrong about, so the rate is undefined rather than 0 or
   * Infinity. The harness never speaks an empty line, but a WER of 0 for "we measured nothing"
   * would silently improve every fleet average it touched.
   */
  it("reports an empty reference as null rather than a perfect score", () => {
    expect(wordErrorRate("", "something the agent imagined").wer).toBeNull();
    expect(wordErrorRate("  ", "").wer).toBeNull();
  });

  it("treats a spoken number and its digits as the same word", () => {
    expect(wordErrorRate("I can pay five hundred fifty dollars", "I can pay 550 dollars").wer).toBe(0);
  });

  it("does not penalise a provider for writing currency with a symbol", () => {
    // The exact pair seen on the first live run.
    expect(wordErrorRate("I can pay 550 dollars on Friday", "I can pay $550 on Friday.").wer).toBe(0);
  });
});
