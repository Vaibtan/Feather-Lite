import { describe, expect, it } from "vitest";
import { holdBudgetMs, HOLD_MARGIN_MS, HOLD_MAX_MS } from "../src/holdPolicy.js";

describe("holdBudgetMs", () => {
  it("waits out the remaining audio plus a margin", () => {
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 3000, channel: "voice" })).toBe(5000 + HOLD_MARGIN_MS);
  });

  it("does not wait for audio that has already finished", () => {
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 9000, channel: "voice" })).toBe(0);
  });

  it("falls back to a bounded default when the audio length is not known yet", () => {
    /** `tts_audio_ms` arrives on `turn_metrics`, which the worker sends only after the segment finishes. */
    const budget = holdBudgetMs({ ttsAudioMs: null, elapsedMs: 0, channel: "voice" });
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(HOLD_MAX_MS);
  });

  it("never waits longer than the ceiling, however long the segment claims to be", () => {
    expect(holdBudgetMs({ ttsAudioMs: 600_000, elapsedMs: 0, channel: "voice" })).toBe(HOLD_MAX_MS);
  });

  it("never holds a simulated call", () => {
    /** A simulated call has no voice runtime, so no playout is ever reported and the segment would look unfinished forever. */
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 0, channel: "simulated" })).toBe(0);
  });

  it("treats a negative or absurd elapsed time as zero elapsed, because clock skew is not a reason to skip the hold", () => {
    expect(holdBudgetMs({ ttsAudioMs: 4000, elapsedMs: -500, channel: "voice" })).toBe(4000 + HOLD_MARGIN_MS);
  });
});
