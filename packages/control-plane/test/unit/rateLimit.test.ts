import { describe, expect, it } from "vitest";
import { MAX_BUCKETS, makeRateLimiter, STALE_AFTER_MS, WINDOW_MS } from "../../src/http/rateLimit.js";

describe("makeRateLimiter", () => {
  it("serves up to the budget and refuses past it, within one window", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    expect(rl.check("a", 3, t)).toBe(true);
    expect(rl.check("a", 3, t + 1)).toBe(true);
    expect(rl.check("a", 3, t + 2)).toBe(true);
    expect(rl.check("a", 3, t + 3)).toBe(false);
    expect(rl.check("a", 3, t + 4)).toBe(false);
  });

  it("keeps one caller's budget out of another's", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    expect(rl.check("a", 1, t)).toBe(true);
    expect(rl.check("a", 1, t)).toBe(false);
    expect(rl.check("b", 1, t)).toBe(true);
  });

  it("starts a fresh budget once the window rolls over", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    expect(rl.check("a", 1, t)).toBe(true);
    expect(rl.check("a", 1, t + 1)).toBe(false);
    expect(rl.check("a", 1, t + WINDOW_MS + 1)).toBe(true);
  });

  it("forgets callers it has not heard from, instead of growing forever", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 500; i++) rl.check(`ip-${String(i)}`, 10, t);
    expect(rl.size()).toBe(500);

    rl.check("someone-new", 10, t + STALE_AFTER_MS + 1);
    expect(rl.size()).toBe(1);
  });

  it("does not evict a caller still inside the grace period", () => {
    // Two windows, not one: evicting on the exact boundary would hand a returning caller a fresh
    // budget a second early.
    const rl = makeRateLimiter();
    const t = 1_000_000;
    rl.check("a", 10, t);
    rl.check("b", 10, t + STALE_AFTER_MS - 1);
    expect(rl.size()).toBe(2);
  });

  it("does not rescan the map for every new caller in a burst", () => {
    // The sweep is O(map size), so running it per new key would be O(n^2) across a burst of
    // distinct IPs - the very shape the eviction exists for. At most one sweep per window.
    const rl = makeRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 1000; i++) rl.check(`burst-${String(i)}`, 10, t + i);
    expect(rl.size()).toBe(1000);
    rl.check("after", 10, t + 1000 + STALE_AFTER_MS + 1);
    expect(rl.size()).toBe(1);
  });

  it("reports its own size, which is what makes unbounded growth visible", () => {
    const rl = makeRateLimiter();
    expect(rl.size()).toBe(0);
    rl.check("a", 10, 1);
    rl.check("a", 10, 2);
    expect(rl.size()).toBe(1);
  });
});

describe("the bucket ceiling", () => {
  it("bounds how many buckets are held, even inside one window", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < MAX_BUCKETS + 500; i++) rl.check(`ip-${i}`, 100, t + 1);
    expect(rl.size()).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("evicts the oldest rather than refusing the newest", () => {
    const rl = makeRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < MAX_BUCKETS + 1; i++) rl.check(`ip-${i}`, 1, t + 1);
    expect(rl.check("a-real-caller", 1, t + 1)).toBe(true);
    expect(rl.check("a-real-caller", 1, t + 1)).toBe(false);
  });
});
