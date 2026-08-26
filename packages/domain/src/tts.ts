/**
 * What can honestly be said about speech synthesis from the outside (spec 2026-08-26, D5).
 *
 * **There is no MOS model here and none is planned.** UTMOS and NISQA — the models that actually
 * predict how speech *sounds* — are Python-only, and a sidecar for them was ruled out of scope. The
 * temptation in that situation is to invent a "voice quality score" out of the numbers that happen
 * to be lying around; that would be worse than no score, because a number on a dashboard is read as
 * a measurement whatever the tooltip says.
 *
 * So this module answers two narrower questions the runtime genuinely knows the answer to:
 *
 * 1. **Did the synthesis produce any audio at all?** A hard failure, and not a hypothetical one —
 *    a Deepgram TTS websocket that hung on connect produced a zero-audio read-back the framework
 *    force-closed as "played in full", and the ledger recorded a promise the borrower never heard
 *    (ADR 0008). That is the failure mode worth watching.
 * 2. **Was this turn spoken at a wildly different rate from the rest of the run?** A stalled stream
 *    or a truncated synthesis shows up as characters-per-second far from the voice's usual figure.
 *    This is an *outlier flag* — "a human should listen to this one" — not a verdict, and it is
 *    labelled as a heuristic everywhere it surfaces.
 *
 * Neither says the speech sounded good. Both are computed from numbers the voice worker already
 * reports, so they cost nothing on the turn path.
 */
import type { EventOf, EventRecord } from "./events.js";
import { booleanScore, numericScore, type ScoreRecord } from "./scores.js";

/**
 * A turn whose synthesis produced no audio at all.
 *
 * The ledger's evidence is an `AGENT_TURN_PLAYOUT` that heard nothing *and* was cut short: the
 * voice worker reports a zero-audio turn that way on purpose (ADR 0008), because the framework
 * force-closes such an item and would otherwise have it recorded as played in full. Requiring both
 * halves is what separates it from a barge-in, where the borrower talked over real speech and
 * `heard_text` carries the part they did hear.
 *
 * The same predicate is expressed in SQL by `ConversationRepo.reliabilityCounts` and by
 * `Queries.turnLatencies`; if this definition changes, those change with it.
 */
export const isSilentPlayout = (e: EventRecord): e is EventRecord & EventOf<"AGENT_TURN_PLAYOUT"> =>
  e.type === "AGENT_TURN_PLAYOUT" && e.payload.interrupted && e.payload.heard_text === "";

/**
 * What the voice runtime reported about one turn's speech synthesis. `audioMs`/`chars` come from
 * the worker's `tts_metrics` and are null when there was no voice runtime on the turn at all (a
 * JSON simulation, a load-test turn); `silent` is the ledger's own view, from `isSilentPlayout`.
 */
export interface TurnTtsFacts {
  readonly turnId: string;
  readonly audioMs: number | null;
  readonly chars: number | null;
  readonly silent: boolean;
}

/**
 * The same turn, plus the reading that only matters in aggregate: how long the voice took to
 * produce its first frame. Not scored per turn — it is already a component of the latency
 * waterfall — but D5 asks for it beside the rate, so that "how did the voice behave" is one block
 * rather than a cross-reference to the latency card.
 */
export interface TurnTtsReading extends TurnTtsFacts {
  readonly ttfbMs: number | null;
}

/** Per-turn TTS scores. See the module doc for what these do and do not claim. */
export const ttsScores = (conversationId: string, turns: ReadonlyArray<TurnTtsFacts>): ReadonlyArray<ScoreRecord> => {
  const out: ScoreRecord[] = [];
  for (const t of turns) {
    // No TTS shape and no playout report means there was no voice runtime on this turn at all — a
    // JSON simulation or a load-test turn. Scoring `silent_playout: 0` there would claim the
    // synthesis played fine when nothing was ever synthesised, which is the same false negative the
    // evaluator's null facts exist to avoid.
    if (!hasEvidence(t)) continue;
    out.push(booleanScore(conversationId, "tts.silent_playout", t.silent, "SYSTEM", { turnId: t.turnId, ...(t.silent ? { comment: "TTS produced no audio for this turn" } : {}) }));
    const rate = charsPerSecond(t);
    if (rate !== null) out.push(numericScore(conversationId, "tts.chars_per_second", rate, "SYSTEM", { turnId: t.turnId }));
  }
  return out;
};

/** A turn the voice runtime had something to say about, either a shape or a failed playout. */
const hasEvidence = (t: TurnTtsFacts): boolean => t.audioMs !== null || t.chars !== null || t.silent;

/**
 * Characters per second, or null when the turn cannot have a rate.
 *
 * Needs both halves and real audio: dividing by a zero duration is not "infinitely fast speech",
 * it is a turn that never played, which `tts.silent_playout` already reports. Folding a zero-length
 * turn in as a rate of 0 would drag the baseline down and then flag every healthy turn as fast.
 */
export const charsPerSecond = (t: TurnTtsFacts): number | null =>
  t.chars !== null && t.audioMs !== null && t.audioMs > 0 && t.chars > 0 ? Math.round((t.chars / (t.audioMs / 1000)) * 100) / 100 : null;

/**
 * How far from the median a turn's speaking rate has to be before it is worth a human ear. ±40 %,
 * from D5 — wide enough that ordinary prosody variation (a short "Mm-hm." against a long read-back)
 * does not fire it, narrow enough to catch a stream that stalled or a synthesis that truncated.
 */
export const TTS_RATE_OUTLIER_BAND = 0.4;

/**
 * The median needs at least this many readings to be a baseline. With two, it sits exactly between
 * them, so each is equally far from it and "the outlier" is whichever one you name first.
 */
export const TTS_RATE_BASELINE_READINGS = 3;

export interface TtsRateOutlier {
  readonly turnId: string;
  readonly charsPerSecond: number;
  /** Signed share of the median: +1 is double the usual rate, -0.5 is half of it. */
  readonly deviation: number;
}

/** Fleet- and window-level TTS heuristics. Every field is null-on-no-evidence, never zero. */
export interface TtsHeuristics {
  /** Turns that had a voice runtime — the denominator for the silent rate. */
  readonly turns: number;
  readonly silentPlayouts: number;
  /** Null when no turn tried to speak: "the voice worked every time" and "we never checked" differ. */
  readonly silentPlayoutRate: number | null;
  readonly charsPerSecond: {
    readonly n: number;
    readonly median: number | null;
    readonly min: number | null;
    readonly max: number | null;
  };
  /** Time to the voice's first audio frame, over the same turns. p95 is what the SLO gates on. */
  readonly ttfbMs: { readonly n: number; readonly p50: number | null; readonly p95: number | null };
  readonly outlierBand: number;
  readonly baselineReadings: number;
  /** Worst deviation first, so a one-line report can show the turn most worth listening to. */
  readonly outliers: ReadonlyArray<TtsRateOutlier>;
}

/**
 * Roll per-turn facts up over a window — one fleet run, or the last N calls on the Quality page.
 *
 * The baseline is the **median** of the window's own readings rather than a configured constant:
 * the right characters-per-second depends on the voice, and a number pinned in config would go
 * stale the first time the voice changed. A median (not a mean) is what makes the flag survive the
 * thing it is looking for — one turn played at four times speed must not drag the baseline up until
 * it looks normal.
 */
export const ttsAggregate = (turns: ReadonlyArray<TurnTtsReading>): TtsHeuristics => {
  const withRuntime = turns.filter(hasEvidence);
  const rates = withRuntime
    .map((t) => ({ turnId: t.turnId, rate: charsPerSecond(t) }))
    .filter((r): r is { turnId: string; rate: number } => r.rate !== null);
  const sorted = rates.map((r) => r.rate).sort((a, b) => a - b);
  const median = medianOf(sorted);
  const outliers =
    median === null || sorted.length < TTS_RATE_BASELINE_READINGS
      ? []
      : rates
          .map((r) => ({ turnId: r.turnId, charsPerSecond: r.rate, deviation: (r.rate - median) / median }))
          .filter((o) => Math.abs(o.deviation) > TTS_RATE_OUTLIER_BAND)
          .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  const silentPlayouts = withRuntime.filter((t) => t.silent).length;
  return {
    turns: withRuntime.length,
    silentPlayouts,
    silentPlayoutRate: withRuntime.length === 0 ? null : silentPlayouts / withRuntime.length,
    charsPerSecond: { n: sorted.length, median, min: sorted[0] ?? null, max: sorted.at(-1) ?? null },
    ttfbMs: percentilesOf(withRuntime.map((t) => t.ttfbMs).filter((v): v is number => v !== null)),
    outlierBand: TTS_RATE_OUTLIER_BAND,
    baselineReadings: TTS_RATE_BASELINE_READINGS,
    outliers,
  };
};

/** Index-based percentiles, matching how every other latency figure in this system is reported. */
const percentilesOf = (values: ReadonlyArray<number>): { n: number; p50: number | null; p95: number | null } => {
  const xs = [...values].sort((a, b) => a - b);
  const at = (p: number) => (xs.length === 0 ? null : Math.round(xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0));
  return { n: xs.length, p50: at(50), p95: at(95) };
};

/** True median, including the mean of the middle pair on an even count — this is a baseline, not a percentile. */
const medianOf = (sorted: ReadonlyArray<number>): number | null => {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
