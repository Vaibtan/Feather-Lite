/**
 * How long a turn waits for a non-interruptible segment to finish playing (issue #1, D1 — F2).
 */
import { describe, expect, it } from "vitest";
import { holdBudgetMs, HOLD_MARGIN_MS, HOLD_MAX_MS } from "../src/holdPolicy.js";

describe("holdBudgetMs", () => {
  it("waits out the remaining audio plus a margin", () => {
    // 8 s of read-back, 3 s already elapsed: 5 s left, plus the margin for the report to land.
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 3000, channel: "voice" })).toBe(5000 + HOLD_MARGIN_MS);
  });

  it("does not wait for audio that has already finished", () => {
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 9000, channel: "voice" })).toBe(0);
  });

  it("falls back to a bounded default when the audio length is not known yet", () => {
    /**
     * The usual case during a hold: `tts_audio_ms` arrives on the `turn_metrics` signal, which the
     * worker sends *after* the segment finishes — so while it is still playing there is nothing to
     * read. A default is the only honest answer, and it must be bounded.
     */
    const budget = holdBudgetMs({ ttsAudioMs: null, elapsedMs: 0, channel: "voice" });
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(HOLD_MAX_MS);
  });

  it("never waits longer than the ceiling, however long the segment claims to be", () => {
    // A wedged or mis-reported segment must not hold a turn open indefinitely: the borrower is
    // waiting, and a turn that never starts is worse than one that starts a little early.
    expect(holdBudgetMs({ ttsAudioMs: 600_000, elapsedMs: 0, channel: "voice" })).toBe(HOLD_MAX_MS);
  });

  it("never holds a simulated call", () => {
    /**
     * The guard that keeps this from breaking every non-voice call. A simulated call has no voice
     * runtime, so no `AGENT_TURN_PLAYOUT` is ever reported and the segment would look unfinished
     * forever — every turn would pay the full budget for a segment that finished instantly.
     */
    expect(holdBudgetMs({ ttsAudioMs: 8000, elapsedMs: 0, channel: "simulated" })).toBe(0);
  });

  it("treats a negative or absurd elapsed time as zero elapsed", () => {
    // Clock skew between the worker's timestamps and the ledger's is not a reason to skip the hold.
    expect(holdBudgetMs({ ttsAudioMs: 4000, elapsedMs: -500, channel: "voice" })).toBe(4000 + HOLD_MARGIN_MS);
  });
});
