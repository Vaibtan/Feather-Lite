/**
 * A seeded pseudo-random generator, so a tier-3 run is a thing you can run twice (issue #4, H7).
 *
 * There is no RNG anywhere in the harness today, and the turn-taking table does not need one: issue
 * #1's Q2 settles that the simulator's offsets are **data**, not draws, because reproducibility
 * outranks realism when the harness runs in real time against a real SFU. What does need one is
 * everything D4 layers on top of that table — audio degradation, background noise at a target SNR,
 * seeded burst noise, frame drops under a two-state loss model — where the point is a *distribution*
 * and the requirement is that two runs with the same seed draw the same one.
 *
 * `mulberry32`, and deliberately not `Math.random`: the whole value here is that a regression is a
 * diff between two runs at the same seed, which `Math.random` cannot give at any price. It is not a
 * cryptographic generator and must never be used as one — it is thirty-two bits of state and the
 * seed is printed in the report on purpose.
 *
 * Chosen over the alternatives for the reason this file exists at all: it is short enough to read in
 * one sitting, has no dependencies to pin, and its arithmetic is exactly reproducible across
 * platforms because every step is an explicit 32-bit operation. A generator whose sequence depended
 * on the engine would defeat the point.
 */

/** A stream of draws. Deterministic in the seed, and stateful: the order of calls is part of it. */
export interface Rng {
  /** The next draw in `[0, 1)`. */
  readonly next: () => number;
  /** An integer in `[min, max]`, inclusive at both ends. */
  readonly int: (min: number, max: number) => number;
  /** True with probability `p`. `p <= 0` never, `p >= 1` always. */
  readonly chance: (p: number) => boolean;
  /** One element, or `undefined` for an empty list. */
  readonly pick: <T>(items: ReadonlyArray<T>) => T | undefined;
}

/**
 * Turn any string into a 32-bit seed, so a run can be seeded with something a human chose.
 *
 * `--seed hold-request-run-3` is a thing an operator can type into a bug report and a reader can
 * type back; a bare number is not, and the report has to carry whichever it was.
 */
export const seedFrom = (text: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

/** `mulberry32`. Thirty-two bits of state, one multiply-xor-shift round per draw. */
export const makeRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number): number => {
      if (max < min) return min;
      // `floor` over the half-open draw: uniform across `max - min + 1` values, and `next()` never
      // returns 1, so `max` is reachable but never exceeded.
      return min + Math.floor(next() * (max - min + 1));
    },
    chance: (p: number): boolean => (p <= 0 ? false : p >= 1 ? true : next() < p),
    pick: <T>(items: ReadonlyArray<T>): T | undefined => (items.length === 0 ? undefined : items[Math.floor(next() * items.length)]),
  };
};
