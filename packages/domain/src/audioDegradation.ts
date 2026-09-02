/**
 * Telephony degradation, as pure functions over PCM (issue #1, D4 — Phase 4).
 *
 * The simulator's borrower has always sounded like a studio microphone: 16 kHz, clean, every frame
 * delivered. A real one arrives through G.711 at 8 kHz with a room behind them and frames missing,
 * and every WER and entity number the harness reports is measured on the studio version — which is
 * the optimistic one.
 *
 * Pure and seeded, so a degraded run is reproducible from its seed rather than from a recording, and
 * so the chain is reviewable without a call.
 */
import type { Rng } from "./random.js";

/** Root-mean-square amplitude. The energy measure both the SNR target and the tests use. */
export const rmsOf = (samples: Int16Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
};

/** Signal-to-noise ratio in dB, given the clean signal and the degraded one. */
export const snrOf = (clean: Int16Array, noisy: Int16Array): number => {
  let noise = 0;
  for (const [i, c] of clean.entries()) {
    const d = (noisy[i] ?? 0) - c;
    noise += d * d;
  }
  const noiseRms = Math.sqrt(noise / Math.max(1, clean.length));
  if (noiseRms === 0) return Infinity;
  return 20 * Math.log10(rmsOf(clean) / noiseRms);
};

const BIAS = 0x84;
const CLIP = 32635;

/** Linear PCM to μ-law, the G.711 companding every phone call goes through. */
const toMuLaw = (sample: number): number => {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign !== 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

const fromMuLaw = (byte: number): number => {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
};

/**
 * A G.711 μ-law round trip: what the borrower's voice loses on the way through a phone network.
 *
 * Quantisation only — the 8 kHz resampling is left to the media plane, which already runs at the
 * codec's rate. A second pass changes nothing, because the damage is already quantised in, and the
 * test pins that: a transform that kept degrading would make a chain's order significant for no
 * physical reason.
 */
export const muLawRoundTrip = (samples: Int16Array): Int16Array => {
  const out = new Int16Array(samples.length);
  for (const [i, v] of samples.entries()) out[i] = fromMuLaw(toMuLaw(v));
  return out;
};

/**
 * Background noise at a **measured** target SNR, not a nominal one.
 *
 * The noise is generated, measured, and scaled to hit the ratio asked for, because "add noise at
 * amplitude X" is not a number anyone can compare across personas or across runs.
 */
export interface NoiseOptions {
  /**
   * Weight the noise toward low frequencies, the way traffic, rooms and wind actually are.
   *
   * **On by default, and the default is the finding.** White noise at 15 dB SNR took the harness's
   * word-error rate from 0.000 to 1.000 on the same line, which a real street does not do: white
   * noise sits right on top of the consonants a recogniser needs, while real background noise mostly
   * does not. Unshaped is kept for the tests that compare the two.
   */
  readonly shaped?: boolean | undefined;
}

/** One-pole low-pass. Crude, and enough: the point is where the energy sits, not a filter design. */
const LOWPASS_ALPHA = 0.15;

export const addNoiseAtSnr = (samples: Int16Array, targetSnrDb: number, rng: Rng, options: NoiseOptions = {}): Int16Array => {
  const signal = rmsOf(samples);
  if (signal === 0 || samples.length === 0) return Int16Array.from(samples);

  // White noise at unit-ish scale first, then scaled to the ratio the caller asked for.
  const noise = new Float64Array(samples.length);
  const shaped = options.shaped ?? true;
  let last = 0;
  for (let i = 0; i < samples.length; i++) {
    const white = rng.next() * 2 - 1;
    if (!shaped) {
      noise[i] = white;
      continue;
    }
    last += LOWPASS_ALPHA * (white - last);
    noise[i] = last;
  }
  let noiseSum = 0;
  for (const n of noise) noiseSum += n * n;
  const noiseRms = Math.sqrt(noiseSum / noise.length);
  if (noiseRms === 0) return Int16Array.from(samples);

  const wanted = signal / Math.pow(10, targetSnrDb / 20);
  const scale = wanted / noiseRms;

  const out = new Int16Array(samples.length);
  for (const [i, v] of samples.entries()) {
    // Clamped rather than wrapped: a wrapped sample is a click, which is a different degradation
    // from the one being asked for and would show up as an invented consonant.
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v + (noise[i] ?? 0) * scale)));
  }
  return out;
};

export interface LossOptions {
  /** Long-run share of frames lost, 0..1. */
  readonly lossRate: number;
  /**
   * How clumped the losses are. 1 is memoryless; higher means longer bursts at the same rate.
   *
   * A two-state model rather than a coin flip per frame, because ten isolated lost frames are
   * inaudible and ten consecutive ones are a dropped syllable — and only the second is worth
   * measuring a recogniser against.
   */
  readonly burstiness: number;
  readonly rng: Rng;
}

/**
 * Gilbert-Elliott frame loss: `null` marks a dropped frame, so the caller decides what to send in
 * its place (silence, or nothing at all).
 */
export const dropFrames = <T>(frames: ReadonlyArray<T>, opts: LossOptions): ReadonlyArray<T | null> => {
  const { lossRate, burstiness, rng } = opts;
  if (lossRate <= 0) return [...frames];

  // Mean burst length is `burstiness` frames, and the good->bad rate is whatever holds the long-run
  // loss share at `lossRate`.
  const badToGood = 1 / Math.max(1, burstiness);
  const goodToBad = Math.min(1, (badToGood * lossRate) / Math.max(1e-9, 1 - lossRate));

  const out: Array<T | null> = [];
  let bad = false;
  for (const f of frames) {
    bad = bad ? rng.next() >= badToGood : rng.next() < goodToBad;
    out.push(bad ? null : f);
  }
  return out;
};
