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


/** One latency component's verdict against its target. `insufficient_sample` is neither (O2). */
export type SloStatus = "pass" | "breach" | "insufficient_sample" | "not_measured";

/**
 * Judge one component, given what was observed of it.
 *
 * Pure and here rather than inside the Quality service because the interesting part is a boundary,
 * and a boundary deserves a table test: at exactly `minSample` observations the component *is*
 * judged, and one below it is not. The rule reads `n < minSample`, which is easy to write as `<=`
 * by accident and impossible to notice from a dashboard afterwards.
 *
 * `not_measured` and `insufficient_sample` are kept apart deliberately. A window of simulated calls
 * has no end-of-utterance delay at all, which is a different statement from having three of them.
 */
export const sloComponentStatus = (observed: { readonly p95: number | null; readonly n: number }, targetMs: number, minSample: number): SloStatus => {
  if (observed.n === 0 || observed.p95 === null) return "not_measured";
  if (observed.n < minSample) return "insufficient_sample";
  return observed.p95 > targetMs ? "breach" : "pass";
};

/** The window's verdict. `insufficient` is not a pass — it is "nothing here was judgeable" (review #12). */
export type SloVerdict = "pass" | "breach" | "insufficient";

/**
 * Roll a window's component statuses into one verdict.
 *
 * The defect this replaces was `pass: breaches.length === 0`, which made **a window with nothing
 * measured a pass** — a fresh database, or a window of simulated calls that carry no
 * end-of-utterance delay at all, badged "SLO MET". The component statuses already said so; the
 * headline threw the distinction away, and a test pinned it.
 *
 * A breach outranks everything: one component over target is a breach whatever the rest did. Below
 * that, a verdict needs at least one component that was actually judged; if none was, the honest
 * answer is `insufficient`, not "met". A pass with some components short of the minimum is still a
 * pass — the `insufficient` list beside it is what says the bill is not clean.
 */
export const sloVerdict = (statuses: ReadonlyArray<SloStatus>): SloVerdict => {
  if (statuses.some((s) => s === "breach")) return "breach";
  return statuses.some((s) => s === "pass") ? "pass" : "insufficient";
};

/** The four latency components a turn can carry, plus the decide TTFT. All optional per turn. */
export interface TurnLatencyComponents {
  readonly eou_delay_ms: number | null;
  readonly transcription_delay_ms: number | null;
  readonly ttft_ms: number | null;
  readonly tts_ttfb_ms: number | null;
}

export interface SloTargetsMs {
  readonly eouP95Ms: number;
  readonly transcriptionP95Ms: number;
  readonly ttftP95Ms: number;
  readonly ttsTtfbP95Ms: number;
}

/**
 * Was this one call within the latency SLO (O6)?
 *
 * A per-call verdict is a different question from the windowed one, and it is answered differently
 * on purpose. The window reports a p95 across many calls; a single call has three to six turns, so
 * a "p95" of it would be its slowest turn wearing a percentile's clothes. The claim here is the one
 * that is actually checkable: **no turn in this call exceeded any component's target**.
 *
 * Null when the call carries no component measurement at all — a simulated call has no
 * end-of-utterance delay and never had one, which is not the same as passing. `breached` names the
 * components that failed, so the persisted score can say which, rather than only that.
 */
export const callSloVerdict = (
  turns: ReadonlyArray<TurnLatencyComponents>,
  targets: SloTargetsMs,
): { readonly pass: boolean | null; readonly breached: ReadonlyArray<string>; readonly measured: number } => {
  const components = [
    { name: "eou_delay_ms", target: targets.eouP95Ms, of: (t: TurnLatencyComponents) => t.eou_delay_ms },
    { name: "transcription_delay_ms", target: targets.transcriptionP95Ms, of: (t: TurnLatencyComponents) => t.transcription_delay_ms },
    { name: "ttft_ms", target: targets.ttftP95Ms, of: (t: TurnLatencyComponents) => t.ttft_ms },
    { name: "tts_ttfb_ms", target: targets.ttsTtfbP95Ms, of: (t: TurnLatencyComponents) => t.tts_ttfb_ms },
  ];
  const breached: string[] = [];
  let measured = 0;
  for (const c of components) {
    const values = turns.map(c.of).filter((v): v is number => v !== null);
    measured += values.length;
    if (values.length === 0) continue; // nothing to be within target of
    if (Math.max(...values) > c.target) breached.push(c.name);
  }
  return { pass: measured === 0 ? null : breached.length === 0, breached, measured };
};
