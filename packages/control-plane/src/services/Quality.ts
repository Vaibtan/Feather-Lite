/**
 * The Quality view's one request (spec 2026-08-26, D7 + D8): funnel, promise ageing, SLO verdict,
 * reliability, score aggregates and judge/human agreement over one window of calls.
 *
 * Its own service rather than more of `Queries`, which is already the read side for conversations
 * and latency: this is a different subject with a different shape, and merging them would give one
 * module two reasons to change. Each aggregation is its own named function for the same reason,
 * composed at the end — six independent questions in one long function would be one body with six
 * reasons to change.
 *
 * Everything here is computed **in Postgres over the ledger and the score table**, not from the
 * process counters. Langfuse cannot help: its Metrics API v2 filters by session but cannot group by
 * one, so the aggregate this page needs does not exist there. Postgres has both the events and the
 * scores, so it is the only place the two can be joined at all.
 */
import { DateTime, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { LatencyAggregate, QualityReport, SloComponent, SloReport, SloSegment, TtsHeuristicsReport } from "@feather-lite/contracts";
import { localIsoDate, ORPHANED_REASON, percentile, SCORE_DATA_TYPE_BY_NAME, sloComponentStatus, ttsAggregate, type ScoreName, type ScoreSource, type TtsHeuristics } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { Metrics } from "./Metrics.js";
import { aggregateTurnRows, Queries, ttsReadingsOf } from "./Queries.js";

export interface QualityWindow {
  /** Most recent N conversations. Ignored when `from`/`to` are given. */
  readonly calls?: number | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** A range query with no bound would scan the whole ledger; this is the ceiling either way. */
const MAX_WINDOW = 1000;

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000);

/**
 * Precision is per-metric, not global. Latency is reported in whole milliseconds, matching every
 * other duration in this API (`Queries.latencyAggregate`); word error rate lives between 0 and 1,
 * where rounding to whole numbers would report every good run as exactly 0.
 */
const percentiles = (values: ReadonlyArray<number>, decimals: number) => {
  const factor = 10 ** decimals;
  const round = (n: number) => Math.round(n * factor) / factor;
  const at = (p: number) => {
    const v = percentile(values, p);
    return v === null ? null : round(v);
  };
  return { n: values.length, mean: values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length), p50: at(50), p95: at(95) };
};

const EMPTY_FUNNEL = {
  attempts: 0,
  finished: 0,
  in_progress: 0,
  connected: 0,
  voicemail: 0,
  right_party: 0,
  promise_to_pay: 0,
  callback_scheduled: 0,
  failed: 0,
  orphaned: 0,
  rates: { contact: null, right_party: null, promise: null, voicemail: null },
};
const EMPTY_AGREEMENT = { judged: 0, human_labelled: 0, both: 0, agreed: 0, rate: null };

/**
 * The domain's TTS heuristics in the API's shape. Only the worst few outliers travel: the point of
 * the flag is "listen to this turn", and a list of forty is not something anyone listens to.
 */
const TTS_OUTLIERS_SHOWN = 5;
const ttsReport = (h: TtsHeuristics): TtsHeuristicsReport => ({
  turns: h.turns,
  silent_playouts: h.silentPlayouts,
  silent_playout_rate: h.silentPlayoutRate === null ? null : Math.round(h.silentPlayoutRate * 1000) / 1000,
  chars_per_second: h.charsPerSecond,
  ttfb_ms: h.ttfbMs,
  outlier_band: h.outlierBand,
  baseline_readings: h.baselineReadings,
  outlier_count: h.outliers.length,
  outliers: h.outliers.slice(0, TTS_OUTLIERS_SHOWN).map((o) => ({
    turn_id: o.turnId,
    chars_per_second: o.charsPerSecond,
    deviation: Math.round(o.deviation * 1000) / 1000,
  })),
});

export class Quality extends Effect.Service<Quality>()("@feather-lite/Quality", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const queries = yield* Queries;
    const metrics = yield* Metrics;

    /**
     * The conversations one report is about. Everything else is computed over exactly this set —
     * including the SLO, which took its own "most recent N" in the first version and so could
     * describe entirely different calls than the funnel printed beside it.
     */
    const windowIds = (window: QualityWindow) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ranged = window.from !== undefined || window.to !== undefined;
        const limit = ranged ? MAX_WINDOW : Math.min(MAX_WINDOW, Math.max(1, window.calls ?? 50));
        const from = window.from ?? null;
        const to = window.to ?? null;
        const rows = yield* sql<{ id: string }>`
          SELECT id FROM conversations
          WHERE (${from}::timestamptz IS NULL OR started_at >= ${from}::timestamptz)
            AND (${to}::timestamptz IS NULL OR started_at < ${to}::timestamptz)
          ORDER BY started_at DESC, id DESC LIMIT ${limit}`.pipe(Effect.orDie);
        return { ids: rows.map((r) => r.id), ranged, limit, from, to };
      });

    /**
     * The collections funnel (D7). Counts are conversations, not events, so a call that verified
     * twice still counts once — hence EXISTS per stage rather than a join, which would multiply rows.
     */
    const funnel = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<Record<string, string>>`
          WITH win AS (SELECT id, final_outcome FROM conversations WHERE id IN ${sql.in(ids)}),
          flags AS (
            SELECT w.id, w.final_outcome,
              EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = w.id AND e.type = 'AMD_RESULT' AND e.payload->>'result' = 'MACHINE') AS voicemail,
              EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = w.id AND e.type = 'STATE_TRANSITION' AND e.payload->>'triggered_by' = 'RIGHT_PARTY_CONFIRMED') AS right_party,
              EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = w.id AND e.type = 'TOOL_RESULT' AND e.payload->>'name' = 'record_promise_to_pay') AS promise,
              EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = w.id AND e.type = 'CALL_CONTROL' AND e.payload->>'action' = 'HANGUP' AND e.payload->>'reason' = ${ORPHANED_REASON}) AS orphaned
            FROM win w
          )
          SELECT
            count(*)::text AS attempts,
            count(*) FILTER (WHERE final_outcome IS NOT NULL)::text AS finished,
            count(*) FILTER (WHERE final_outcome IS NULL)::text AS in_progress,
            -- Requiring a final outcome is the fix (O3): IS DISTINCT FROM 'NO_ANSWER' is true of a
            -- null, so every in-flight and abandoned call counted as a person answering. Measured,
            -- 13 unfinished simulations put the contact rate at 95.9%.
            count(*) FILTER (WHERE final_outcome IS NOT NULL AND final_outcome IS DISTINCT FROM 'NO_ANSWER' AND NOT voicemail)::text AS connected,
            count(*) FILTER (WHERE voicemail OR final_outcome = 'VOICEMAIL_LEFT')::text AS voicemail,
            count(*) FILTER (WHERE right_party)::text AS right_party,
            count(*) FILTER (WHERE promise)::text AS promise_to_pay,
            count(*) FILTER (WHERE final_outcome = 'CALLBACK_SCHEDULED')::text AS callback_scheduled,
            count(*) FILTER (WHERE final_outcome = 'FAILED')::text AS failed,
            count(*) FILTER (WHERE orphaned)::text AS orphaned
          FROM flags`.pipe(Effect.orDie);
        const n = (k: string) => Number(rows[0]?.[k] ?? 0);
        const attempts = n("attempts");
        const finished = n("finished");
        // "Connected" is a human picking up on a call that *finished*: not a no-answer, not a
        // machine, not still ringing. Voicemail is counted separately rather than folded in,
        // because leaving a compliant voicemail is a different outcome from talking to someone,
        // not a lesser version of it.
        const connected = n("connected");
        const rightParty = n("rightParty");
        const promiseToPay = n("promiseToPay");
        const voicemail = n("voicemail");
        return {
          attempts,
          finished,
          in_progress: n("inProgress"),
          connected,
          voicemail,
          right_party: rightParty,
          promise_to_pay: promiseToPay,
          callback_scheduled: n("callbackScheduled"),
          failed: n("failed"),
          orphaned: n("orphaned"),
          // Each rate is of the previous stage, which is how a collections funnel is read. Contact
          // rate is of *finished* attempts: a call still ringing has not failed to connect, it has
          // not done anything yet, and leaving it in the denominator understates every run in
          // progress while overstating none.
          rates: {
            contact: ratio(connected, finished),
            right_party: ratio(rightParty, connected),
            promise: ratio(promiseToPay, rightParty),
            voicemail: ratio(voicemail, attempts),
          },
        };
      });

    /** Recorded promises, aged against the borrower's own calendar day. */
    const promises = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const now = yield* DateTime.now;
        const rows = yield* sql<{ conversationId: string; borrowerName: string; timezone: string; amount: string | null; date: string | null }>`
          SELECT c.id AS conversation_id, b.name AS borrower_name, b.timezone,
                 c.final_outcome_metadata->>'promised_amount' AS amount,
                 c.final_outcome_metadata->>'promised_date'   AS date
          FROM conversations c JOIN borrowers b ON b.id = c.borrower_id
          WHERE c.id IN ${sql.in(ids)} AND c.final_outcome = 'PROMISE_TO_PAY'
          ORDER BY c.started_at DESC`.pipe(Effect.orDie);
        return rows
          .filter((r) => r.amount !== null && r.date !== null)
          .map((r) => {
            // "Due today" is today where the borrower lives. A promised date is a calendar date they
            // agreed to on the phone, so comparing it against a UTC day would call an
            // America/New_York promise overdue for the five hours before their midnight. The clock
            // is the app's (VirtualClock-aware), so seeded history ages with the calls it contains.
            const today = Option.getOrElse(localIsoDate(now, r.timezone), () => DateTime.formatIsoDate(now));
            return {
              conversation_id: r.conversationId,
              borrower_name: r.borrowerName,
              amount: r.amount!,
              date: r.date!,
              status: (r.date! < today ? "OVERDUE" : r.date! === today ? "DUE_TODAY" : "PENDING") as "PENDING" | "DUE_TODAY" | "OVERDUE",
            };
          });
      });

    /**
     * Turn a latency aggregate into an SLO verdict. Shared by the quality report and
     * `/api/system/status`, so the two can never disagree about whether the SLO is met — which they
     * would within a release of each other if the comparison were written twice.
     */
    /**
     * The SLO verdict over one segment's window (O2).
     *
     * Two things were wrong with the previous version, and both made the page say "pass" when it
     * should not have. It read every component's p95 off a window of *all* recent calls, so a
     * tier-1 load run's 36 scripted turns diluted it — measured, `ttft_ms` went 3 228 -> 1 252 ms
     * and left the breach list without anything changing but the population. And it judged a
     * component off however few observations it had, so a p95 over six turns is the maximum
     * presented as a tail.
     *
     * Each component is now judged only over turns that actually carry it (`n` from the aggregate,
     * not the window's call count), and below `min_sample` it reports `insufficient_sample` — which
     * is neither a pass nor a breach, and is listed separately so a green verdict with an empty
     * `insufficient` list can be told from a green verdict that simply had nothing to look at.
     */
    const sloFrom = (latency: LatencyAggregate, segment: SloSegment): SloReport => {
      const targets = {
        total_ms: cfg.slo.turnP95Ms,
        eou_delay_ms: cfg.slo.eouP95Ms,
        transcription_delay_ms: cfg.slo.transcriptionP95Ms,
        ttft_ms: cfg.slo.ttftP95Ms,
        tts_ttfb_ms: cfg.slo.ttsTtfbP95Ms,
      };
      const observed: Record<string, { p95: number | null; n: number }> = {
        total_ms: { p95: latency.total_ms.p95, n: latency.total_ms.n },
        eou_delay_ms: { p95: latency.eou_delay_ms.p95, n: latency.eou_delay_ms.n },
        transcription_delay_ms: { p95: latency.transcription_delay_ms.p95, n: latency.transcription_delay_ms.n },
        ttft_ms: { p95: latency.ttft_ms.p95, n: latency.ttft_ms.n },
        tts_ttfb_ms: { p95: latency.tts_ttfb_ms.p95, n: latency.tts_ttfb_ms.n },
      };
      const minSample = cfg.slo.minSample;
      const components: Record<string, SloComponent> = {};
      const breaches: string[] = [];
      const insufficient: string[] = [];
      const measured: Record<string, number | null> = {};
      for (const [name, target] of Object.entries(targets)) {
        const { p95, n } = observed[name] ?? { p95: null, n: 0 };
        // A component with no measurements cannot breach: a window of simulated calls has no
        // end-of-utterance delay, and reporting that as a failure would be noise, not a signal.
        const status = sloComponentStatus({ p95, n }, target, minSample);
        // p95 is withheld below the minimum rather than shown: the number is real, but reading it
        // as a tail is the mistake this guard exists to prevent.
        const shown = status === "insufficient_sample" || status === "not_measured" ? null : p95;
        components[name] = { target_ms: target, measured_ms: shown, n, status };
        measured[name] = shown;
        if (status === "breach") breaches.push(name);
        if (status === "insufficient_sample") insufficient.push(name);
      }
      return { pass: breaches.length === 0, segment, min_sample: minSample, components, targets, measured, breaches, insufficient };
    };

    /**
     * The SLO over the most recent N calls in a segment, for the status page. Voice calls served by
     * the real decider by default: that is the population the targets were set from, and the one an
     * operator means when they ask whether the agent is fast enough.
     */
    const sloStatus = (calls: number, segment: { channel?: string | null; decider?: string | null } = { channel: "voice", decider: "openai" }) =>
      queries.latencyAggregateForSegment({ channel: segment.channel ?? null, decider: segment.decider ?? null }, calls).pipe(
        Effect.orDie,
        Effect.map(({ aggregate, found }) =>
          sloFrom(aggregate, { channel: segment.channel ?? null, decider: segment.decider ?? null, calls_requested: calls, calls_found: found }),
        ),
      );

    /** Call-level score aggregates. Turn-level rows are excluded: they aggregate per turn, not per call. */
    const scoreSummaries = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ name: string; source: string; n: string; total: string; passed: string }>`
          SELECT name, source, count(*)::text AS n, sum(value)::text AS total,
                 count(*) FILTER (WHERE value = 1)::text AS passed
          FROM conversation_scores
          WHERE conversation_id IN ${sql.in(ids)} AND turn_id IS NULL
          GROUP BY name, source ORDER BY name, source`.pipe(Effect.orDie);
        return rows.map((r) => {
          const n = Number(r.n);
          const name = r.name as ScoreName;
          return {
            name,
            source: r.source as ScoreSource,
            n,
            mean: n === 0 ? null : Math.round((Number(r.total) / n) * 1000) / 1000,
            // Only a BOOLEAN score has a pass rate; a mean WER of 0.04 is not "4% passed".
            pass_rate: SCORE_DATA_TYPE_BY_NAME[name] === "BOOLEAN" ? ratio(Number(r.passed), n) : null,
          };
        });
      });

    /** Every value of one call-level numeric score in the window. */
    const numericScores = (ids: ReadonlyArray<string>, name: ScoreName) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ value: number }>`
          SELECT value FROM conversation_scores
          WHERE conversation_id IN ${sql.in(ids)} AND name = ${name} AND turn_id IS NULL`.pipe(Effect.orDie);
        return rows.map((r) => Number(r.value));
      });

    /**
     * Judge-vs-human agreement, over calls carrying both labels. The `both` denominator is the
     * point: an agreement number computed over calls a human never looked at is not a calibration.
     */
    const agreement = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<Record<string, string>>`
          WITH labels AS (
            SELECT conversation_id,
                   max(value) FILTER (WHERE source = 'JUDGE') AS judge,
                   max(value) FILTER (WHERE source = 'HUMAN') AS human
            FROM conversation_scores
            WHERE conversation_id IN ${sql.in(ids)}
              AND name IN ('judge.overall_pass', 'human.overall_pass') AND turn_id IS NULL
            GROUP BY conversation_id
          )
          SELECT
            count(*) FILTER (WHERE judge IS NOT NULL)::text AS judged,
            count(*) FILTER (WHERE human IS NOT NULL)::text AS human_labelled,
            count(*) FILTER (WHERE judge IS NOT NULL AND human IS NOT NULL)::text AS both,
            count(*) FILTER (WHERE judge IS NOT NULL AND human IS NOT NULL AND judge = human)::text AS agreed
          FROM labels`.pipe(Effect.orDie);
        const n = (k: string) => Number(rows[0]?.[k] ?? 0);
        const both = n("both");
        return { judged: n("judged"), human_labelled: n("humanLabelled"), both, agreed: n("agreed"), rate: ratio(n("agreed"), both) };
      });

    const report = (window: QualityWindow): Effect.Effect<QualityReport, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const w = yield* windowIds(window);
        // An empty window is a legitimate answer (a fresh database, a range with no calls). Every
        // rate is already null-on-zero-denominator, so the only thing this guard buys is skipping
        // the queries whose `IN ()` would be a Postgres syntax error.
        const empty = w.ids.length === 0;
        const ledger = yield* queries.ledgerCounts().pipe(Effect.orDie);
        const providerEvents = yield* metrics.providerEvents();
        // The window's turns, read once. The SLO and the TTS heuristics are two readings of the
        // same rows, and fetching them twice would double the query count for no new information.
        const turns = yield* queries.turnRowsFor(w.ids).pipe(Effect.orDie);

        return {
          window: { calls: w.ranged ? null : w.limit, from: w.from, to: w.to, conversations: w.ids.length },
          funnel: empty ? EMPTY_FUNNEL : yield* funnel(w.ids),
          promises: empty ? [] : yield* promises(w.ids),
          // The Quality report's SLO is over *this page's* window, whatever the operator selected,
          // so its segment is whatever that window contained rather than the status page's default.
          // Reporting it as segment `null/null` is the honest description: unfiltered.
          slo: sloFrom(aggregateTurnRows(w.ids.length, turns.rows, turns.dropped), {
            channel: null,
            decider: null,
            calls_requested: w.ranged ? w.ids.length : w.limit,
            calls_found: w.ids.length,
          }),
          tts: ttsReport(ttsAggregate(ttsReadingsOf(turns.rows))),
          reliability: {
            counts: ledger.reliability,
            orphan_detect_ms: percentiles(empty ? [] : yield* numericScores(w.ids, "system.orphan_detect_ms"), 0),
            // Live, process-local: labelled separately on the page because these reset on restart.
            provider_counters: providerEvents.counters,
          },
          scores: empty ? [] : yield* scoreSummaries(w.ids),
          stt_wer: percentiles(empty ? [] : yield* numericScores(w.ids, "stt.wer"), 3),
          judge_agreement: empty ? EMPTY_AGREEMENT : yield* agreement(w.ids),
        } satisfies QualityReport;
      });

    return { report, sloStatus } as const;
  }),
  dependencies: [Queries.Default],
}) {}
