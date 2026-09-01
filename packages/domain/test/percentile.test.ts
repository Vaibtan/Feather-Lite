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
import { callSloVerdict, percentile, sloComponentStatus, sloVerdict, type TurnLatencyComponents } from "../src/percentile.js";

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

describe("sloComponentStatus", () => {
  const target = 700;
  const min = 20;

  it("judges a component at exactly the minimum sample, and not one below it", () => {
    // The boundary the rule is easiest to get wrong at, and impossible to spot from a dashboard.
    expect(sloComponentStatus({ p95: 100, n: min }, target, min)).toBe("pass");
    expect(sloComponentStatus({ p95: 100, n: min - 1 }, target, min)).toBe("insufficient_sample");
    expect(sloComponentStatus({ p95: 9000, n: min }, target, min)).toBe("breach");
    expect(sloComponentStatus({ p95: 9000, n: min - 1 }, target, min)).toBe("insufficient_sample");
  });

  it("keeps 'nothing to measure' apart from 'too little to judge'", () => {
    // A window of simulated calls has no end-of-utterance delay at all; that is a different
    // statement from having three of them, and the page must not render them the same way.
    expect(sloComponentStatus({ p95: null, n: 0 }, target, min)).toBe("not_measured");
    expect(sloComponentStatus({ p95: null, n: 5 }, target, min)).toBe("not_measured");
    expect(sloComponentStatus({ p95: 100, n: 1 }, target, min)).toBe("insufficient_sample");
  });

  it("treats the target as a ceiling, not a range — equal to target passes", () => {
    expect(sloComponentStatus({ p95: target, n: min }, target, min)).toBe("pass");
    expect(sloComponentStatus({ p95: target + 1, n: min }, target, min)).toBe("breach");
  });
});

describe("sloVerdict", () => {
  it("does not call a window with nothing measured a pass", () => {
    // The defect (review #12): the verdict was `breaches.length === 0`, so a fresh database and a
    // window of simulated calls — which carry no end-of-utterance delay at all — both badged
    // "SLO MET". Nothing was measured; that is not the same as everything being fast.
    expect(sloVerdict([])).toBe("insufficient");
    expect(sloVerdict(["not_measured", "not_measured"])).toBe("insufficient");
    expect(sloVerdict(["insufficient_sample", "not_measured"])).toBe("insufficient");
  });

  it("passes as soon as one component was actually judged and none breached", () => {
    expect(sloVerdict(["pass"])).toBe("pass");
    // A pass with components short of the minimum is still a pass; the `insufficient` list beside
    // the verdict is what says it is not a clean bill.
    expect(sloVerdict(["pass", "insufficient_sample", "not_measured"])).toBe("pass");
  });

  it("lets one breach outrank everything else", () => {
    expect(sloVerdict(["breach"])).toBe("breach");
    expect(sloVerdict(["pass", "breach"])).toBe("breach");
    expect(sloVerdict(["breach", "insufficient_sample", "not_measured"])).toBe("breach");
  });
});

describe("callSloVerdict", () => {
  const targets = { eouP95Ms: 700, transcriptionP95Ms: 600, ttftP95Ms: 1500, ttsTtfbP95Ms: 600 };
  const turn = (over: Partial<TurnLatencyComponents> = {}): TurnLatencyComponents => ({
    eou_delay_ms: null,
    transcription_delay_ms: null,
    ttft_ms: null,
    tts_ttfb_ms: null,
    ...over,
  });

  it("passes a call whose every turn is inside every target it measured", () => {
    const v = callSloVerdict([turn({ eou_delay_ms: 500, ttft_ms: 900 }), turn({ eou_delay_ms: 600, ttft_ms: 1200 })], targets);
    expect(v.pass).toBe(true);
    expect(v.breached).toEqual([]);
  });

  it("fails on one slow turn, and names the component", () => {
    // Not a percentile: one turn over target fails the call, which is the claim that can actually
    // be checked against the ledger afterwards.
    const v = callSloVerdict([turn({ eou_delay_ms: 500 }), turn({ eou_delay_ms: 9000 })], targets);
    expect(v.pass).toBe(false);
    expect(v.breached).toEqual(["eou_delay_ms"]);
  });

  it("names every component that breached, not just the first", () => {
    const v = callSloVerdict([turn({ eou_delay_ms: 9000, tts_ttfb_ms: 4000 })], targets);
    expect(v.breached).toEqual(["eou_delay_ms", "tts_ttfb_ms"]);
  });

  it("is null, not true, for a call that measured nothing", () => {
    // A simulated call has no end-of-utterance delay and never had one. Scoring that as a pass
    // would put a green tick on a call nobody measured.
    expect(callSloVerdict([turn(), turn()], targets).pass).toBeNull();
    expect(callSloVerdict([], targets).pass).toBeNull();
  });

  it("judges a call on the components it does carry, ignoring the ones it does not", () => {
    // A simulated call records only the decide TTFT. That is judgeable on its own.
    const v = callSloVerdict([turn({ ttft_ms: 200 })], targets);
    expect(v.pass).toBe(true);
    expect(v.measured).toBe(1);
  });

  it("treats the target as a ceiling", () => {
    expect(callSloVerdict([turn({ ttft_ms: 1500 })], targets).pass).toBe(true);
    expect(callSloVerdict([turn({ ttft_ms: 1501 })], targets).pass).toBe(false);
  });
});
