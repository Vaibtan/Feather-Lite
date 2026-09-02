/**
 * Entity error rate: did the transcript keep the numbers that decide the call? (issue #1, D3.)
 *
 * WER treats every word alike, and it should not. A transcript that turns "Friday" into "Friday,"
 * costs the same as one that turns "550" into "515", and only one of those is a wrong promise. D3
 * makes the amounts a gate (`--max-amount-errors 0`) and reports dates and names beside them.
 */
import { describe, expect, it } from "vitest";
import { entityErrors, entitiesIn } from "../src/entityError.js";

describe("entitiesIn", () => {
  it("finds amounts however they are written", () => {
    expect(entitiesIn("I can pay $550 on Friday").filter((e) => e.kind === "amount").map((e) => e.value)).toEqual(["550"]);
    expect(entitiesIn("550 dollars").filter((e) => e.kind === "amount").map((e) => e.value)).toEqual(["550"]);
    expect(entitiesIn("five hundred fifty dollars").filter((e) => e.kind === "amount").map((e) => e.value)).toEqual(["550"]);
    expect(entitiesIn("pay $1,200.50").filter((e) => e.kind === "amount").map((e) => e.value)).toEqual(["1200.50"]);
  });

  it("does NOT read a bare number as an amount", () => {
    /**
     * Deliberate, and the safer half of the rule. "September 4" and "one moment" both contain bare
     * numbers, and a false amount error fails a run over a transcript that was correct — which is
     * the one thing a gate set at zero must never do. An amount is a number the speaker attached
     * "dollars" to, and after normalisation "$550" already reads that way.
     */
    expect(entitiesIn("pay 1200.50").filter((e) => e.kind === "amount")).toEqual([]);
    expect(entitiesIn("by September 4").filter((e) => e.kind === "amount")).toEqual([]);
  });

  it("finds dates as weekdays, months and numeric forms", () => {
    expect(entitiesIn("on Friday").filter((e) => e.kind === "date").map((e) => e.value)).toEqual(["friday"]);
    expect(entitiesIn("by September 4").filter((e) => e.kind === "date").map((e) => e.value)).toEqual(["september", "4"]);
  });

  it("finds a name only when it is given as one", () => {
    expect(entitiesIn("yes this is Jordan", { names: ["Jordan"] }).filter((e) => e.kind === "name").map((e) => e.value)).toEqual(["jordan"]);
    expect(entitiesIn("yes this is Jordan").filter((e) => e.kind === "name")).toEqual([]);
  });

  it("finds nothing in a line that carries nothing", () => {
    expect(entitiesIn("yes, that's correct")).toEqual([]);
  });
});

describe("entityErrors", () => {
  it("passes when the transcript kept every entity, whatever the formatting", () => {
    const r = entityErrors("I can pay 550 dollars on Friday", "I can pay $550 on Friday.");
    expect(r.errors).toEqual([]);
    expect(r.rate).toBe(0);
    expect(r.counts).toEqual({ amount: 1, date: 1, name: 0 });
  });

  it("catches a wrong amount, which is a wrong promise rather than a bad transcript", () => {
    const r = entityErrors("I can pay 550 dollars on Friday", "I can pay 515 dollars on Friday");
    expect(r.errors.map((e) => e.kind)).toEqual(["amount"]);
    expect(r.amountErrors).toBe(1);
  });

  it("catches a dropped date without calling it an amount error", () => {
    const r = entityErrors("I can pay 550 dollars on Friday", "I can pay 550 dollars");
    expect(r.errors.map((e) => e.kind)).toEqual(["date"]);
    // D3 gates amounts at zero and reports dates; conflating them would gate the wrong thing.
    expect(r.amountErrors).toBe(0);
  });

  it("is null when the line carried no entities, rather than a flattering zero", () => {
    /**
     * The same rule `wordErrorRate` uses for an empty reference: there is nothing to be wrong
     * about, and calling that 0 would quietly improve every average it was folded into.
     */
    const r = entityErrors("yes, that's correct", "yes that's correct");
    expect(r.rate).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it("folds spoken number words, because that is how a borrower says an amount", () => {
    expect(entityErrors("pay five hundred fifty dollars", "pay $550").errors).toEqual([]);
  });

  it("checks a name when the caller supplies one", () => {
    expect(entityErrors("this is Jordan Avery", "this is Jordan Avery", { names: ["Jordan", "Avery"] }).errors).toEqual([]);
    expect(entityErrors("this is Jordan Avery", "this is Jordan Everly", { names: ["Jordan", "Avery"] }).errors.map((e) => e.kind)).toEqual(["name"]);
  });
});
