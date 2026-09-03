import { DateTime, Duration, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { LatencyAggregate, QualityReport, SloComponent, SloReport, SloSegment, TtsHeuristicsReport } from "@feather-lite/contracts";
import { localIsoDate, ORPHANED_REASON, percentile, SCORE_DATA_TYPE_BY_NAME, sloComponentStatus, sloVerdict, ttsAggregate, type ScoreName, type ScoreSource, type TtsHeuristics } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { Metrics } from "./Metrics.js";
import { aggregateTurnRows, Queries, ttsReadingsOf } from "./Queries.js";

export interface QualityWindow {
  readonly calls?: number | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** A range query with no bound would scan the whole ledger; this is the ceiling either way. */
const MAX_WINDOW = 1000;

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000);

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
const EMPTY_RELIABILITY = { turns_superseded: 0, no_input_closes: 0, decider_unavailable: 0, tts_silent_playouts: 0, readbacks_repeated_unheard: 0, calls_orphaned: 0 };

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

    // Counts are conversations, not events, so a call that verified twice still counts once — hence
    // EXISTS per stage rather than a join, which would multiply rows.
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
          rates: {
            contact: ratio(connected, finished),
            right_party: ratio(rightParty, connected),
            promise: ratio(promiseToPay, rightParty),
            voicemail: ratio(voicemail, attempts),
          },
        };
      });

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
            // A promised date is a calendar date in the borrower's own zone; comparing it against a
            // UTC day would call an America/New_York promise overdue for five hours before midnight.
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

    // Each component is judged only over the turns that carry it, and below `min_sample` reports
    // `insufficient_sample` — neither a pass nor a breach, because a p95 over six turns is a maximum.
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
        const status = sloComponentStatus({ p95, n }, target, minSample);
        const shown = status === "insufficient_sample" || status === "not_measured" ? null : p95;
        components[name] = { target_ms: target, measured_ms: shown, n, status };
        measured[name] = shown;
        if (status === "breach") breaches.push(name);
        if (status === "insufficient_sample") insufficient.push(name);
      }
      const verdict = sloVerdict(Object.values(components).map((c) => c.status));
      return { verdict, pass: verdict === "pass", segment, min_sample: minSample, components, targets, measured, breaches, insufficient };
    };

    const sloUncached = (calls: number, segment: { channel?: string | null; decider?: string | null; harness?: string | null | undefined }) =>
      queries.latencyAggregateForSegment({ channel: segment.channel ?? null, decider: segment.decider ?? null, harness: segment.harness ?? null }, calls).pipe(
        Effect.orDie,
        Effect.map(({ aggregate, found }) =>
          sloFrom(aggregate, { channel: segment.channel ?? null, decider: segment.decider ?? null, calls_requested: calls, calls_found: found }),
        ),
      );

    // `Effect.cachedWithTTL` rather than a timestamp cell so concurrent callers deduplicate:
    // several console tabs hitting an expired entry would each recompute the window scan.
    const STATUS_SEGMENT = { channel: "voice" as const, decider: "openai" as const };
    const STATUS_CALLS = 50;
    const sloStatusCached = yield* Effect.cachedWithTTL(sloUncached(STATUS_CALLS, STATUS_SEGMENT), Duration.seconds(5));

    const sloStatus = (calls: number, segment: { channel?: string | null; decider?: string | null; harness?: string | null | undefined } = STATUS_SEGMENT) =>
      calls === STATUS_CALLS &&
      (segment.channel ?? null) === STATUS_SEGMENT.channel &&
      (segment.decider ?? null) === STATUS_SEGMENT.decider &&
      (segment.harness ?? null) === null
        ? sloStatusCached
        : sloUncached(calls, segment);

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

    const numericScores = (ids: ReadonlyArray<string>, name: ScoreName) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ value: number }>`
          SELECT value FROM conversation_scores
          WHERE conversation_id IN ${sql.in(ids)} AND name = ${name} AND turn_id IS NULL`.pipe(Effect.orDie);
        return rows.map((r) => Number(r.value));
      });

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
        const empty = w.ids.length === 0;
        const ledger = yield* queries.ledgerCounts().pipe(Effect.orDie);
        const providerEvents = yield* metrics.providerEvents();
        const turns = yield* queries.turnRowsFor(w.ids).pipe(Effect.orDie);

        return {
          window: { calls: w.ranged ? null : w.limit, from: w.from, to: w.to, conversations: w.ids.length },
          funnel: empty ? EMPTY_FUNNEL : yield* funnel(w.ids),
          promises: empty ? [] : yield* promises(w.ids),
          slo: sloFrom(aggregateTurnRows(w.ids.length, turns.rows, turns.dropped), {
            channel: null,
            decider: null,
            calls_requested: w.ranged ? w.ids.length : w.limit,
            calls_found: w.ids.length,
          }),
          tts: ttsReport(ttsAggregate(ttsReadingsOf(turns.rows))),
          reliability: {
            counts: empty ? EMPTY_RELIABILITY : yield* queries.reliabilityCountsFor(w.ids).pipe(Effect.orDie),
            orphan_detect_ms: percentiles(empty ? [] : yield* numericScores(w.ids, "system.orphan_detect_ms"), 0),
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
