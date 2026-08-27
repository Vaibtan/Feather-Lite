/**
 * The per-IP budget (O9). Time is a parameter here rather than a clock, so the window and the
 * eviction can be tested without sleeping.
 */
import { describe, expect, it } from "vitest";
import { makeRateLimiter, STALE_AFTER_MS, WINDOW_MS } from "../../src/http/rateLimit.js";

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
    // A second IP is unaffected by the first exhausting its budget.
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
    // The defect: the map was never evicted, so on a public address it grew one entry per distinct
    // client IP for the life of the process. Unbounded, and invisible because nothing reported it.
    const rl = makeRateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 500; i++) rl.check(`ip-${String(i)}`, 10, t);
    expect(rl.size()).toBe(500);

    // One request, long enough later that every one of those windows is dead.
    rl.check("someone-new", 10, t + STALE_AFTER_MS + 1);
    expect(rl.size()).toBe(1);
  });

  it("does not evict a caller still inside the grace period", () => {
    // Two windows, not one: a caller last seen 90 seconds ago has a dead window but may be about to
    // return, and evicting on the exact boundary would hand them a fresh budget a second early.
    const rl = makeRateLimiter();
    const t = 1_000_000;
    rl.check("a", 10, t);
    rl.check("b", 10, t + STALE_AFTER_MS - 1);
    expect(rl.size()).toBe(2);
  });

  it("reports its own size, which is what makes unbounded growth visible", () => {
    const rl = makeRateLimiter();
    expect(rl.size()).toBe(0);
    rl.check("a", 10, 1);
    rl.check("a", 10, 2);
    expect(rl.size()).toBe(1);
  });
});
