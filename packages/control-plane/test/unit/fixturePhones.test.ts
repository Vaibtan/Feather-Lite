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
    const scattered = new Set([9_999_998, 9_999_999, 5]);
    expect(freeFixtureSubscribers(scattered, 3)).toEqual([0, 1, 2]);
  });

  it("returns fewer than asked for when the exchange cannot satisfy the batch", () => {
    expect(freeFixtureSubscribers(new Set([0, 1]), 5, 4)).toEqual([2, 3]);
    expect(freeFixtureSubscribers(new Set(), 5, 3)).toEqual([0, 1, 2]);
  });

  it("asks for nothing and gets nothing", () => {
    expect(freeFixtureSubscribers(new Set([1, 2]), 0)).toEqual([]);
  });
});
