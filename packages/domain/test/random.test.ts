/**
 * The seeded generator (issue #4, H7).
 *
 * The property that matters is not "looks random" — it is that two runs at the same seed draw the
 * same sequence, because that is what makes a tier-3 regression a diff rather than an argument.
 */
import { describe, expect, it } from "vitest";
import { makeRng, seedFrom } from "../src/random.js";

const draws = (seed: number, n: number): number[] => {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe("makeRng", () => {
  it("gives the same sequence for the same seed, which is the whole point", () => {
    expect(draws(12345, 8)).toEqual(draws(12345, 8));
  });

  it("gives a different sequence for a different seed", () => {
    expect(draws(12345, 8)).not.toEqual(draws(12346, 8));
  });

  it("is pinned to a known sequence, so a change of algorithm cannot pass silently", () => {
    // A table test in the literal sense: these are `mulberry32(1)`'s first draws. If an
    // "improvement" to the generator lands, every seeded run ever recorded stops reproducing — so
    // the sequence itself is the contract, not just its determinism.
    expect(draws(1, 5).map((d) => Number(d.toFixed(10)))).toEqual([0.6270739406, 0.0027357212, 0.52744704, 0.9810509675, 0.9683778982]);
  });

  it("draws in [0, 1)", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 2000; i++) {
      const d = rng.next();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
  });
});

describe("int", () => {
  it("covers both ends of the range and never leaves it", () => {
    const rng = makeRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      const n = rng.int(3, 6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      seen.add(n);
    }
    // Inclusive at both ends: an off-by-one here silently removes a persona or an offset from every
    // seeded table that uses it.
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  it("handles a single-value range and a reversed one", () => {
    const rng = makeRng(7);
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.int(9, 2)).toBe(9);
  });
});

describe("chance", () => {
  it("is never and always at the ends, without consuming a draw", () => {
    const rng = makeRng(11);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(-1)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(2)).toBe(true);
    // The sequence is untouched by the degenerate cases, so turning a feature off does not reshuffle
    // every draw after it — which would make two runs that differ only in a disabled option
    // incomparable.
    expect(rng.next()).toBe(makeRng(11).next());
  });

  it("lands near the requested probability over many draws", () => {
    const rng = makeRng(2026);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (rng.chance(0.25)) hits += 1;
    expect(hits / 20_000).toBeGreaterThan(0.23);
    expect(hits / 20_000).toBeLessThan(0.27);
  });
});

describe("pick", () => {
  it("returns undefined for an empty list and only members otherwise", () => {
    const rng = makeRng(5);
    expect(rng.pick([])).toBeUndefined();
    const items = ["a", "b", "c"];
    for (let i = 0; i < 500; i++) expect(items).toContain(rng.pick(items));
  });
});

describe("seedFrom", () => {
  it("turns a name an operator can type into a seed", () => {
    expect(seedFrom("hold-request-run-3")).toBe(seedFrom("hold-request-run-3"));
    expect(seedFrom("hold-request-run-3")).not.toBe(seedFrom("hold-request-run-4"));
    expect(Number.isInteger(seedFrom("x"))).toBe(true);
    expect(seedFrom("x")).toBeGreaterThanOrEqual(0);
  });
});
