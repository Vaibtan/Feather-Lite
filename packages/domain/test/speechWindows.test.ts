import { describe, expect, it } from "vitest";
import { SILENCE_HANGOVER_MS, SPEECH_RMS, speechWindows, withPlayoutTruth, type RmsSample } from "../src/speechWindows.js";

/** 10 ms apart: the frame cadence the harness's audio callback actually delivers. */
const run = (fromMs: number, count: number, rms: number): RmsSample[] => Array.from({ length: count }, (_, i) => ({ atMs: fromMs + i * 10, rms }));

const LOUD = 250; // measured: Aura TTS speech peaks around here
const QUIET = 20; // measured: channel silence stays under ~25

describe("speechWindows", () => {
  it("finds nothing in silence", () => {
    expect(speechWindows(run(0, 200, QUIET))).toEqual([]);
  });

  it("opens on the first energetic frame and closes on the last", () => {
    const samples = [...run(0, 50, QUIET), ...run(500, 100, LOUD), ...run(1_500, 100, QUIET)];
    /** The hangover decides whether the stretch is over; it must not be added to how long the agent spoke. */
    expect(speechWindows(samples)).toEqual([{ startMs: 500, endMs: 1_490 }]);
  });

  it("does not split a line at the gaps between its words", () => {
    /** Measured: intra-line gaps in Aura at 13 chars/s sit well under the hangover, which is what sets it. */
    const samples = [...run(0, 30, LOUD), ...run(300, 20, QUIET), ...run(500, 30, LOUD), ...run(800, 20, QUIET), ...run(1_000, 30, LOUD)];
    expect(speechWindows(samples)).toEqual([{ startMs: 0, endMs: 1_290 }]);
  });

  it("splits two turns, which are seconds apart", () => {
    const samples = [...run(0, 50, LOUD), ...run(500, 300, QUIET), ...run(3_500, 50, LOUD)];
    expect(speechWindows(samples)).toEqual([
      { startMs: 0, endMs: 490 },
      { startMs: 3_500, endMs: 3_990 },
    ]);
  });

  it("closes the last window at the last energetic frame, not at the end of the samples", () => {
    expect(speechWindows([...run(0, 50, QUIET), ...run(500, 50, LOUD)])).toEqual([{ startMs: 500, endMs: 990 }]);
  });

  it("uses the hangover as the boundary, not a smaller gap", () => {
    const justUnder = [...run(0, 10, LOUD), ...run(100, Math.floor((SILENCE_HANGOVER_MS - 20) / 10), QUIET), ...run(100 + SILENCE_HANGOVER_MS - 20, 10, LOUD)];
    expect(speechWindows(justUnder)).toHaveLength(1);

    const justOver = [...run(0, 10, LOUD), ...run(100, Math.floor((SILENCE_HANGOVER_MS + 20) / 10), QUIET), ...run(100 + SILENCE_HANGOVER_MS + 20, 10, LOUD)];
    expect(speechWindows(justOver)).toHaveLength(2);
  });

  it("takes the threshold and the hangover as arguments, because a persona can change both", () => {
    const samples = [...run(0, 20, 100), ...run(200, 20, QUIET)];
    expect(speechWindows(samples, { speechRms: 150 })).toEqual([]);
    expect(speechWindows(samples, { speechRms: 50 })).toEqual([{ startMs: 0, endMs: 190 }]);
  });

  it("is not confused by samples arriving out of order", () => {
    const ordered = speechWindows([...run(0, 30, LOUD), ...run(3_000, 30, LOUD)]);
    const shuffled = speechWindows([...run(3_000, 30, LOUD), ...run(0, 30, LOUD)]);
    expect(shuffled).toEqual(ordered);
  });

  it("names its defaults, so a harness and a test cannot disagree about them", () => {
    expect(SPEECH_RMS).toBe(80);
    expect(SILENCE_HANGOVER_MS).toBe(700);
  });
});

describe("withPlayoutTruth", () => {
  it("gives each stretch the playout that was reported for it", () => {
    const windows = [
      { startMs: 0, endMs: 4_000 },
      { startMs: 5_000, endMs: 6_400 },
    ];
    /** The worker reports playout after the audio ends, so the signal lands just past the stretch. */
    const playouts = [
      { atMs: 4_100, interrupted: false },
      { atMs: 6_500, interrupted: true },
    ];
    expect(withPlayoutTruth(windows, playouts)).toEqual([
      { startMs: 0, endMs: 4_000, truncated: false },
      { startMs: 5_000, endMs: 6_400, truncated: true },
    ]);
  });

  it("does not let a stretch borrow the next stretch's playout", () => {
    /** The bound is the next stretch's onset, the same rule `harness-scores.ts` joins by. */
    const windows = [
      { startMs: 0, endMs: 4_000 },
      { startMs: 5_000, endMs: 6_400 },
    ];
    const playouts = [{ atMs: 6_500, interrupted: true }];
    expect(withPlayoutTruth(windows, playouts)).toEqual([
      { startMs: 0, endMs: 4_000, truncated: null },
      { startMs: 5_000, endMs: 6_400, truncated: true },
    ]);
  });

  it("reports a stretch with no playout as unknown, not as played in full", () => {
    /** `false` would assert the agent was not interrupted, which is a claim about audio nobody reported. */
    expect(withPlayoutTruth([{ startMs: 0, endMs: 3_000 }], [])).toEqual([{ startMs: 0, endMs: 3_000, truncated: null }]);
  });

  it("ignores a playout reported before the agent ever spoke", () => {
    expect(withPlayoutTruth([{ startMs: 5_000, endMs: 6_000 }], [{ atMs: 100, interrupted: true }])).toEqual([{ startMs: 5_000, endMs: 6_000, truncated: null }]);
  });

  it("allows a report a little ahead of the stretch, which is clock skew", () => {
    /** The harness stamps the stretch from the audio it receives, the control plane the report from its own clock. */
    expect(withPlayoutTruth([{ startMs: 5_000, endMs: 6_000 }], [{ atMs: 4_900, interrupted: true }])).toEqual([
      { startMs: 5_000, endMs: 6_000, truncated: true },
    ]);
    expect(withPlayoutTruth([{ startMs: 5_000, endMs: 6_000 }], [{ atMs: 4_000, interrupted: true }])).toEqual([
      { startMs: 5_000, endMs: 6_000, truncated: null },
    ]);
  });

  it("is not confused by the order either list arrives in", () => {
    const windows = [
      { startMs: 5_000, endMs: 6_400 },
      { startMs: 0, endMs: 4_000 },
    ];
    const playouts = [
      { atMs: 6_500, interrupted: true },
      { atMs: 4_100, interrupted: false },
    ];
    expect(withPlayoutTruth(windows, playouts)).toEqual([
      { startMs: 0, endMs: 4_000, truncated: false },
      { startMs: 5_000, endMs: 6_400, truncated: true },
    ]);
  });
});
