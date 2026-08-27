/**
 * The percentile rule, table-tested, because it was one rank wrong in two places and the SLO gate
 * reads it (O1).
 *
 * The measured symptom: `system.orphan_detect_ms` over the two readings 30 895 and 38 902 reported
 * a p50 of 38 902 — the larger of two numbers presented as their midpoint. `floor(p/100 · n)` is an
 * index into a zero-based array as though it were a rank, so at n=2 the median lands on the second
 * observation instead of the first.
 */
import { describe, expect, it } from "vitest";
import { percentile } from "../src/percentile.js";

describe("percentile", () => {
  it("has nothing to say about no observations", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it("returns the single observation at every percentile when there is one", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it("takes the lower of two at p50 — the case that was wrong", () => {
    // ceil(0.50 · 2) = 1 -> rank 1 -> index 0. The old rule gave index 1, the larger.
    expect(percentile([30_895, 38_902], 50)).toBe(30_895);
    expect(percentile([30_895, 38_902], 95)).toBe(38_902);
    expect(percentile([30_895, 38_902], 99)).toBe(38_902);
  });

  it("is nearest-rank on an odd count", () => {
    // n=3: p50 -> ceil(1.5) = rank 2 -> the middle one.
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30], 95)).toBe(30);
    expect(percentile([10, 20, 30], 99)).toBe(30);
  });

  it("agrees with the textbook nearest-rank table at n=20", () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
    expect(percentile(xs, 50)).toBe(100); // rank 10
    expect(percentile(xs, 95)).toBe(190); // rank 19
    expect(percentile(xs, 99)).toBe(200); // rank 20
    expect(percentile(xs, 5)).toBe(10); // rank 1
  });

  it("sorts for the caller rather than trusting the order it is handed", () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
  });

  it("clamps a rank that would fall off either end", () => {
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 0)).toBe(1);
  });

  it("never reports a p95 that is really the maximum without the caller knowing n", () => {
    // Not a property of this function to enforce — it is why `SLO_MIN_SAMPLE` exists — but the
    // arithmetic must be honest about it: below 20 observations p95 IS the maximum.
    const six = [1, 2, 3, 4, 5, 6];
    expect(percentile(six, 95)).toBe(6);
    expect(percentile(six, 95)).toBe(Math.max(...six));
  });
});
