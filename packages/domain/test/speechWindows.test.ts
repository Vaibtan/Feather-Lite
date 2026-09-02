/**
 * Agent speech, as stretches rather than as an onset (spec 2026-08-30, D4).
 *
 * The tier-2 harness only ever needed one instant — the first energetic frame after the borrower
 * fell silent — because response latency is an onset measurement. Turn-taking is not: every one of
 * the six numbers is about a stretch of agent audio with a beginning *and* an end, and
 * `turnTakingMetrics` cannot be fed without both.
 *
 * Milliseconds and int16 RMS throughout, which is what the audio callback already computes.
 */
import { describe, expect, it } from "vitest";
import { SILENCE_HANGOVER_MS, SPEECH_RMS, speechWindows, withPlayoutTruth, type RmsSample } from "../src/speechWindows.js";

/** A run of frames at one level, 10 ms apart — the frame cadence the harness actually sees. */
const run = (fromMs: number, count: number, rms: number): RmsSample[] => Array.from({ length: count }, (_, i) => ({ atMs: fromMs + i * 10, rms }));

const LOUD = 250; // measured: Aura TTS speech peaks around here
const QUIET = 20; // measured: channel silence stays under ~25

describe("speechWindows", () => {
  it("finds nothing in silence", () => {
    expect(speechWindows(run(0, 200, QUIET))).toEqual([]);
  });

  it("opens on the first energetic frame and closes on the last", () => {
    // 500 ms of silence, 1 000 ms of speech, 1 000 ms of silence.
    const samples = [...run(0, 50, QUIET), ...run(500, 100, LOUD), ...run(1_500, 100, QUIET)];
    // Closes at the last energetic frame — 1 490 — not when the hangover expires. The hangover
    // decides whether the stretch is *over*; it must not be added to how long the agent spoke.
    expect(speechWindows(samples)).toEqual([{ startMs: 500, endMs: 1_490 }]);
  });

  it("does not split a line at the gaps between its words", () => {
    // Three bursts 200 ms apart: one sentence, not three. Intra-line gaps in Aura at the measured
    // 13 chars/s sit well under the hangover; this is the case that decides the threshold.
    const samples = [...run(0, 30, LOUD), ...run(300, 20, QUIET), ...run(500, 30, LOUD), ...run(800, 20, QUIET), ...run(1_000, 30, LOUD)];
    expect(speechWindows(samples)).toEqual([{ startMs: 0, endMs: 1_290 }]);
  });

  it("splits two turns, which are seconds apart", () => {
    // The agent stops, the borrower speaks, the agent replies: the smallest such gap this system
    // produces is the latency waterfall's own p50, ~2.4 s. Nothing near the hangover.
    const samples = [...run(0, 50, LOUD), ...run(500, 300, QUIET), ...run(3_500, 50, LOUD)];
    expect(speechWindows(samples)).toEqual([
      { startMs: 0, endMs: 490 },
      { startMs: 3_500, endMs: 3_990 },
    ]);
  });

  it("closes the last window at the last energetic frame, not at the end of the samples", () => {
    // A call that ends while the agent is speaking still has a stretch with an end.
    expect(speechWindows([...run(0, 50, QUIET), ...run(500, 50, LOUD)])).toEqual([{ startMs: 500, endMs: 990 }]);
  });

  it("uses the hangover as the boundary, not a smaller gap", () => {
    const justUnder = [...run(0, 10, LOUD), ...run(100, Math.floor((SILENCE_HANGOVER_MS - 20) / 10), QUIET), ...run(100 + SILENCE_HANGOVER_MS - 20, 10, LOUD)];
    expect(speechWindows(justUnder)).toHaveLength(1);

    const justOver = [...run(0, 10, LOUD), ...run(100, Math.floor((SILENCE_HANGOVER_MS + 20) / 10), QUIET), ...run(100 + SILENCE_HANGOVER_MS + 20, 10, LOUD)];
    expect(speechWindows(justOver)).toHaveLength(2);
  });

  it("takes the threshold and the hangover as arguments, because a persona can change both", () => {
    // A quieter TTS voice, or a degraded channel (D4's telephony personas), moves the level the
    // detector has to split on. The defaults are this system's measured ones, not universal ones.
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
    // The worker reports playout after the audio ends, so the signal lands just past the stretch.
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
    // The bound is the next stretch's onset, the same rule `harness-scores.ts` joins by. Without it
    // a turn with no playout signal takes the following turn's and reports its truncation.
    const windows = [
      { startMs: 0, endMs: 4_000 },
      { startMs: 5_000, endMs: 6_400 },
    ];
    const playouts = [{ atMs: 6_500, interrupted: true }];
    expect(withPlayoutTruth(windows, playouts)).toEqual([
      // Unknown rather than untruncated (H11): nothing reported on this stretch, and the next
      // stretch's report is not evidence about it.
      { startMs: 0, endMs: 4_000, truncated: null },
      { startMs: 5_000, endMs: 6_400, truncated: true },
    ]);
  });

  it("reports a stretch with no playout as unknown, not as played in full (H11)", () => {
    // It used to answer `false`, on the argument that the one line reliably without a turn behind it
    // is the opening, which nothing interrupts. True of the opening and false of the others:
    // `safeFallback`, the no-input prompt and any `say` outside a turn also produce a stretch with
    // no playout, and `false` asserts the agent was not interrupted — a claim about audio nobody
    // reported. On the hold-request scenario that assertion is the metric under test.
    expect(withPlayoutTruth([{ startMs: 0, endMs: 3_000 }], [])).toEqual([{ startMs: 0, endMs: 3_000, truncated: null }]);
  });

  it("ignores a playout reported before the agent ever spoke", () => {
    expect(withPlayoutTruth([{ startMs: 5_000, endMs: 6_000 }], [{ atMs: 100, interrupted: true }])).toEqual([{ startMs: 5_000, endMs: 6_000, truncated: null }]);
  });

  it("allows a report a little ahead of the stretch, which is clock skew (H11)", () => {
    // The harness stamps the stretch from audio it is receiving; the control plane stamps the report
    // from its own clock. A few milliseconds either way is skew, not evidence — and without the
    // grace such a report was booked to the *previous* stretch, giving two stretches the wrong truth.
    expect(withPlayoutTruth([{ startMs: 5_000, endMs: 6_000 }], [{ atMs: 4_900, interrupted: true }])).toEqual([
      { startMs: 5_000, endMs: 6_000, truncated: true },
    ]);
    // Beyond the grace it is still somebody else's report.
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
