/**
 * Telephony degradation, as pure functions over PCM (issue #1, D4 — Phase 4).
 *
 * The simulator's borrower has always sounded like a studio microphone. A real one arrives through
 * G.711 at 8 kHz with noise behind them and frames missing, and every number the harness reports is
 * measured on the studio version. These are the transforms that close that gap, and they are pure so
 * the chain is reproducible from a seed rather than from a recording.
 */
import { describe, expect, it } from "vitest";
import { makeRng } from "../src/random.js";
import { addNoiseAtSnr, dropFrames, muLawRoundTrip, rmsOf, snrOf } from "../src/audioDegradation.js";

/** A second of a loud-ish tone at 16 kHz — the shape the line cache produces. */
const tone = (samples = 16000, amplitude = 8000): Int16Array => {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return out;
};

describe("muLawRoundTrip", () => {
  it("keeps the signal recognisable but not identical — that is the whole point", () => {
    const src = tone();
    const out = muLawRoundTrip(src);
    expect(out.length).toBe(src.length);
    // Still the same waveform in energy terms...
    expect(Math.abs(rmsOf(out) - rmsOf(src)) / rmsOf(src)).toBeLessThan(0.1);
    // ...but quantised, so it is not the same array. A no-op transform would measure nothing.
    expect(Array.from(out)).not.toEqual(Array.from(src));
  });

  it("is idempotent in shape: a second pass changes little, because the damage is already done", () => {
    const once = muLawRoundTrip(tone());
    const twice = muLawRoundTrip(once);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it("handles silence without inventing anything", () => {
    expect(Array.from(muLawRoundTrip(new Int16Array(64)))).toEqual(Array.from(new Int16Array(64)));
  });
});

describe("addNoiseAtSnr", () => {
  it("hits the signal-to-noise ratio it was asked for", () => {
    const src = tone();
    const out = addNoiseAtSnr(src, 20, makeRng(1));
    // Within a dB: the noise is generated to a measured target, not a nominal one.
    expect(Math.abs(snrOf(src, out) - 20)).toBeLessThan(1);
  });

  it("is louder at a lower ratio, which is the direction that matters", () => {
    const src = tone();
    const noisy10 = addNoiseAtSnr(src, 10, makeRng(1));
    const noisy30 = addNoiseAtSnr(src, 30, makeRng(1));
    expect(rmsOf(noisy10)).toBeGreaterThan(rmsOf(noisy30));
  });

  it("is reproducible from its seed, because a run that cannot be repeated is not evidence", () => {
    const src = tone();
    expect(Array.from(addNoiseAtSnr(src, 15, makeRng(7)))).toEqual(Array.from(addNoiseAtSnr(src, 15, makeRng(7))));
  });

  it("does not clip into a different signal", () => {
    const out = addNoiseAtSnr(tone(16000, 32000), 5, makeRng(3));
    for (const v of out) expect(v).toBeGreaterThanOrEqual(-32768), expect(v).toBeLessThanOrEqual(32767);
  });
});

describe("dropFrames", () => {
  const frames = () => Array.from({ length: 200 }, (_, i) => new Int16Array([i]));

  it("drops roughly the share it was asked for", () => {
    const out = dropFrames(frames(), { lossRate: 0.1, burstiness: 1, rng: makeRng(2) });
    const dropped = out.filter((f) => f === null).length;
    expect(dropped).toBeGreaterThan(5);
    expect(dropped).toBeLessThan(40);
  });

  it("loses frames in bursts, not evenly — which is what a real network does", () => {
    /**
     * The reason this is a two-state model rather than a coin flip per frame. Ten isolated lost
     * frames are inaudible; ten consecutive ones are a dropped syllable, and only the second is
     * worth measuring a recogniser against.
     */
    const bursty = dropFrames(frames(), { lossRate: 0.1, burstiness: 8, rng: makeRng(2) });
    const longestRun = (fs: ReadonlyArray<Int16Array | null>) => {
      let best = 0;
      let run = 0;
      for (const f of fs) {
        run = f === null ? run + 1 : 0;
        if (run > best) best = run;
      }
      return best;
    };
    expect(longestRun(bursty)).toBeGreaterThan(longestRun(dropFrames(frames(), { lossRate: 0.1, burstiness: 1, rng: makeRng(2) })));
  });

  it("drops nothing at a loss rate of zero", () => {
    expect(dropFrames(frames(), { lossRate: 0, burstiness: 4, rng: makeRng(1) }).every((f) => f !== null)).toBe(true);
  });

  it("is reproducible from its seed", () => {
    const a = dropFrames(frames(), { lossRate: 0.2, burstiness: 5, rng: makeRng(9) }).map((f) => f === null);
    const b = dropFrames(frames(), { lossRate: 0.2, burstiness: 5, rng: makeRng(9) }).map((f) => f === null);
    expect(a).toEqual(b);
  });
});

describe("noise shaping", () => {
  /** Energy above ~2 kHz, as a share of the total. A crude but sufficient brightness measure. */
  const highBandShare = (samples: Int16Array): number => {
    // First difference is a high-pass: it keeps what changes fast between samples.
    let high = 0;
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = (samples[i] ?? 0) - (samples[i - 1] ?? 0);
      high += d * d;
      total += (samples[i] ?? 0) * (samples[i] ?? 0);
    }
    return total === 0 ? 0 : high / total;
  };

  it("puts its energy low, the way traffic and rooms do", () => {
    /**
     * The calibration finding this closes. White noise at 15 dB SNR took the harness's WER from
     * 0.000 to 1.000 on the same line, which a real street does not do — because real background
     * noise is mostly low-frequency and white noise sits right on top of the consonants a recogniser
     * needs. Shaped noise at the same *stated* SNR is a far better model of the same *described*
     * environment.
     */
    // The noise is the difference between the degraded line and the clean one; a silent input gets
    // no noise at all, because there is no signal to set a ratio against.
    const src = tone();
    const noiseOf = (out: Int16Array) => Int16Array.from(out, (v, i) => v - (src[i] ?? 0));
    const white = noiseOf(addNoiseAtSnr(src, 10, makeRng(1), { shaped: false }));
    const shaped = noiseOf(addNoiseAtSnr(src, 10, makeRng(1), { shaped: true }));
    expect(highBandShare(shaped)).toBeLessThan(highBandShare(white) / 2);
  });

  it("still hits the SNR it was asked for after shaping", () => {
    const src = tone();
    const out = addNoiseAtSnr(src, 20, makeRng(1), { shaped: true });
    expect(Math.abs(snrOf(src, out) - 20)).toBeLessThan(1);
  });

  it("is shaped by default, because that is the honest model", () => {
    const src = tone();
    expect(Array.from(addNoiseAtSnr(src, 10, makeRng(1)))).toEqual(Array.from(addNoiseAtSnr(src, 10, makeRng(1), { shaped: true })));
  });
});

