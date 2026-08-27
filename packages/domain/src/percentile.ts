/**
 * The one percentile rule, so the SLO gate and the latency report cannot disagree about what p95
 * means (O1).
 *
 * There were two copies of it — `Quality.percentiles` and `Queries.aggregateTurnRows` — and both
 * were one rank high: `xs[floor(p/100 · n)]` treats a zero-based index as though it were a rank.
 * At n=2 that puts the median on the second observation. Measured: `system.orphan_detect_ms` over
 * readings of 30 895 and 38 902 reported a p50 of 38 902, the larger of the two.
 *
 * Nearest-rank (the definition without interpolation): rank = ceil(p/100 · n), value = xs[rank − 1]
 * over the sorted sample. Chosen over a linear-interpolating variant because every consumer here is
 * a latency in whole milliseconds against a fixed target — an interpolated p95 would invent a
 * duration no turn actually took, and the SLO verdict is a claim about observed turns.
 *
 * Returns null for an empty sample. Not 0: "no turn was slower than 0 ms" and "no turn was
 * measured" are different findings, and the second must not read as a pass.
 */
export const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * xs.length);
  const index = Math.min(xs.length - 1, Math.max(0, rank - 1));
  return xs[index] ?? null;
};

