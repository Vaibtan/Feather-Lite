/**
 * Fixture phone allocation. This is a pure function because the thing that went wrong was
 * arithmetic, not SQL: `contact_points.value` is UNIQUE and the old allocator hashed a UUID into
 * seven digits, which is a random draw from ten million. A 3 000-borrower soak run against a dev
 * database holding 4 109 fixtures failed the whole all-or-nothing batch on a collision — the
 * birthday problem, arriving exactly when the harness first needed thousands of them.
 */
import { describe, expect, it } from "vitest";
import { freeFixtureSubscribers } from "../../src/services/Seed.js";

describe("freeFixtureSubscribers", () => {
  it("takes the lowest numbers when nothing is issued", () => {
    expect(freeFixtureSubscribers(new Set(), 3)).toEqual([0, 1, 2]);
  });

  it("skips what is already issued rather than colliding with it", () => {
    expect(freeFixtureSubscribers(new Set([0, 2, 3]), 3)).toEqual([1, 4, 5]);
  });

  it("does not count up from the highest issued number", () => {
    // The failure mode this replaces: four thousand random draws put the maximum within a few
    // thousand of the ceiling, so counting up from it wraps into the low range and collides again.
    const scattered = new Set([9_999_998, 9_999_999, 5]);
    expect(freeFixtureSubscribers(scattered, 3)).toEqual([0, 1, 2]);
  });

  it("returns fewer than asked for when the exchange cannot satisfy the batch", () => {
    // The caller turns a short list into a named failure; here the point is that it does not wrap.
    expect(freeFixtureSubscribers(new Set([0, 1]), 5, 4)).toEqual([2, 3]);
    expect(freeFixtureSubscribers(new Set(), 5, 3)).toEqual([0, 1, 2]);
  });

  it("asks for nothing and gets nothing", () => {
    expect(freeFixtureSubscribers(new Set([1, 2]), 0)).toEqual([]);
  });
});
