import { DateTime, Duration, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { LatencyAggregate, TurnLatencyRow } from "@feather-lite/contracts";
import type { EventRecord, ReplaySnapshot, TimelineEntry, TranscriptEntry, TurnTtsReading } from "@feather-lite/domain";
import { buildTimeline, buildTranscript, charsPerSecond, isWithinContactWindow, percentile, replay } from "@feather-lite/domain";
import { NotFound } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
import { silentPlayoutSql } from "../repos/silentPlayout.js";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";

export interface ConversationSummary {
  readonly conversation_id: string;
  readonly borrower_id: string;
  readonly borrower_name: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly final_outcome: string | null;
  readonly duration_seconds: number | null;
  readonly channel: string;
  readonly current_state: string;
}

export interface ConversationDetail {
  readonly conversation: {
    readonly id: string;
    readonly borrower_id: string;
    readonly workflow_execution_id: string;
    readonly call_attempt_id: string;
    readonly started_at: string;
    readonly ended_at: string | null;
    readonly final_outcome: string | null;
    readonly final_outcome_metadata: Record<string, unknown>;
    readonly channel: string;
    readonly harness: string | null;
    readonly current_state: string;
    readonly protected_context_unlocked: boolean;
    readonly transfer_target: string | null;
  };
  readonly transcript: ReadonlyArray<TranscriptEntry>;
  readonly event_timeline: ReadonlyArray<TimelineEntry>;
  readonly replay: ReplaySnapshot;
  readonly events: ReadonlyArray<EventRecord>;
}

export interface LedgerCountsValue {
  readonly conversations_total: number;
  readonly outcomes: Record<string, number>;
  readonly guardrails: Record<string, number>;
  readonly reliability: Record<string, number>;
}

export class Queries extends Effect.Service<Queries>()("@feather-lite/Queries", {
  effect: Effect.gen(function* () {
    const conv = yield* ConversationRepo;
    const crm = yield* CrmRepo;
    const sched = yield* SchedulingRepo;

    const listConversations = (limit = 50, offset = 0) =>
      Effect.gen(function* () {
        const rows = yield* conv.listConversations({ limit, offset });
        const total = yield* conv.countConversations();
        const items: ConversationSummary[] = rows.map((r) => ({
          conversation_id: r.id,
          borrower_id: r.borrowerId,
          borrower_name: r.borrowerName,
          started_at: r.startedAt.toISOString(),
          ended_at: r.endedAt?.toISOString() ?? null,
          final_outcome: r.finalOutcome,
          duration_seconds: r.endedAt ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
          channel: r.channel,
          current_state: r.currentState,
        }));
        return { items, total: total.count, limit, offset };
      });

    const conversationDetail = (conversationId: string) =>
      Effect.gen(function* () {
        const row = yield* conv.findConversation(conversationId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "conversation", id: conversationId })), onSome: Effect.succeed })),
        );
        const attempt = yield* conv.findAttempt(row.callAttemptId);
        const events = yield* conv.listEvents(row.id);
        const detail: ConversationDetail = {
          conversation: {
            id: row.id,
            borrower_id: row.borrowerId,
            workflow_execution_id: Option.isSome(attempt) ? attempt.value.workflowExecutionId : "",
            call_attempt_id: row.callAttemptId,
            started_at: row.startedAt.toISOString(),
            ended_at: row.endedAt?.toISOString() ?? null,
            final_outcome: row.finalOutcome,
            final_outcome_metadata: row.finalOutcomeMetadata,
            channel: row.channel,
            harness: row.harness,
            current_state: row.currentState,
            protected_context_unlocked: row.protectedContextUnlocked,
            transfer_target: row.transferTarget,
          },
          transcript: buildTranscript(events),
          event_timeline: buildTimeline(events),
          replay: replay(events),
          events,
        };
        return detail;
      });

    const borrowerDirectory = () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const borrowers = yield* crm.listBorrowers();
        const out = [];
        for (const b of borrowers) {
          const contacts = yield* crm.contactPointsForBorrower(b.id);
          const loan = yield* crm.primaryLoanForBorrower(b.id);
          const primary = contacts[0];
          const tz = primary?.timezoneOverride ?? b.timezone;
          out.push({
            borrower_id: b.id,
            name: b.name,
            status: b.status,
            timezone: tz,
            within_contact_window: Option.getOrElse(isWithinContactWindow(now, tz), () => false),
            contact_points: contacts.map((c) => ({ contact_point_id: c.id, value: c.value, is_valid: c.isValid, consent_status: c.consentStatus, priority: c.priority })),
            loan: Option.isSome(loan) ? { balance_due: loan.value.balanceDue, due_date: loan.value.dueDate, status: loan.value.status, delinquency_days: loan.value.delinquencyDays } : null,
          });
        }
        return out;
      });

    const heartbeats = () => sched.listHeartbeats().pipe(Effect.map((rows) => rows.map((r) => ({ agent_name: r.agentName, last_seen_at: r.lastSeenAt.toISOString(), meta: r.meta }))));

    const ledgerCounts = () =>
      Effect.gen(function* () {
        const total = yield* conv.countConversations();
        const outcomes = yield* conv.outcomeCounts();
        const guardrails = yield* conv.guardrailCounts();
        const reliability = yield* conv.reliabilityCounts();
        const value = {
          conversations_total: total.count,
          outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o.count])),
          guardrails: Object.fromEntries(guardrails.map((g) => [g.type, g.count])),
          reliability: {
            turns_superseded: reliability.turnsSuperseded,
            no_input_closes: reliability.noInputCloses,
            decider_unavailable: reliability.deciderUnavailable,
            tts_silent_playouts: reliability.ttsSilentPlayouts,
            readbacks_repeated_unheard: reliability.readbacksRepeatedUnheard,
            calls_orphaned: reliability.callsOrphaned,
          },
        };
        return value;
      });

    // The cache lives on this caller, not inside `ledgerCounts`, because a stale read is wrong for
    // anyone reading the ledger as a source of truth immediately after writing to it.
    // `Effect.cachedWithTTL` rather than a timestamp cell: it latches, so concurrent pollers await
    // the first scan instead of each running their own.
    const ledgerCountsForStatus = yield* Effect.cachedWithTTL(ledgerCounts(), Duration.seconds(5));

    // Conversation-level facets cannot separate two turns of one call, and the fast path will make
    // them different populations: a regex answering in a microsecond and a model turn taking two
    // seconds are both `voice`/`openai`. The `decider` facet is here for it; it is built in Phase 3.
    const turnRowsForMany = (
      conversationIds: ReadonlyArray<string>,
      turns?: { readonly decider?: string | null | undefined } | undefined,
    ): Effect.Effect<{ rows: TurnLatencyRow[]; dropped: number }, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        if (conversationIds.length === 0) return { rows: [], dropped: 0 };
        const sql = yield* PgClient.PgClient;
        const { unheardPlayout, notSuperseded } = silentPlayoutSql(sql);
        const rows = yield* sql<{
          turnId: string;
          startedAt: Date;
          status: string;
          disposition: string | null;
          state: string | null;
          eouDelayMs: number | null;
          transcriptionDelayMs: number | null;
          ttftMs: number | null;
          ttsTtfbMs: number | null;
          ttsAudioMs: number | null;
          ttsChars: number | null;
          ttsSilent: boolean;
        }>`
          SELECT t.turn_id,
                 t.started_at,
                 t.status,
                 t.result->>'disposition'                          AS disposition,
                 t.result->>'newState'                             AS state,
                 (t.result->>'eou_delay_ms')::float8               AS eou_delay_ms,
                 (t.result->>'transcription_delay_ms')::float8     AS transcription_delay_ms,
                 (t.result->>'ttftMs')::float8                     AS ttft_ms,
                 (t.result->>'tts_ttfb_ms')::float8                AS tts_ttfb_ms,
                 (t.result->>'tts_audio_ms')::float8               AS tts_audio_ms,
                 (t.result->>'tts_chars')::float8                  AS tts_chars,
                 (
                   EXISTS (
                     SELECT 1 FROM conversation_events e
                     WHERE e.conversation_id = t.conversation_id AND e.payload->>'turn_id' = t.turn_id AND ${unheardPlayout("e")}
                   )
                   AND ${notSuperseded("t.conversation_id", "t.turn_id")}
                 )                                                 AS tts_silent
          FROM conversation_turns t
          WHERE t.conversation_id IN ${sql.in(conversationIds)}
            AND (${turns?.decider ?? null}::text IS NULL OR t.result->>'decider' = ${turns?.decider ?? null}::text)
          ORDER BY t.conversation_id, t.started_at ASC`.pipe(Effect.orDie);
        // Turns written while a virtual start was being subtracted from a wall-clock now carry a
        // "latency" of days, and one of those in the sample makes every percentile meaningless.
        const MAX_PLAUSIBLE_MS = 300_000;
        let dropped = 0;
        const num = (v: unknown): number | null => {
          if (v === null || v === undefined) return null;
          const n = coerce(v);
          if (n !== null && n >= 0 && n <= MAX_PLAUSIBLE_MS) return n;
          dropped += 1;
          return null;
        };
        const plain = (v: unknown): number | null => {
          const n = coerce(v);
          return n !== null && n >= 0 ? n : null;
        };
        const mapped = rows.map((r) => {
          const eou = num(r.eouDelayMs);
          const stt = num(r.transcriptionDelayMs);
          const ttft = num(r.ttftMs);
          const tts = num(r.ttsTtfbMs);
          const parts = [eou, stt, ttft, tts].filter((v): v is number => v !== null);
          const audioMs = plain(r.ttsAudioMs);
          const chars = plain(r.ttsChars);
          return {
            turn_id: r.turnId,
            started_at: r.startedAt.toISOString(),
            status: r.status,
            disposition: r.disposition,
            state: r.state,
            eou_delay_ms: eou,
            transcription_delay_ms: stt,
            ttft_ms: ttft,
            tts_ttfb_ms: tts,
            total_ms: parts.length > 0 ? Math.round(parts.reduce((a, b) => a + b, 0)) : null,
            tts_audio_ms: audioMs,
            tts_chars: chars,
            tts_chars_per_second: charsPerSecond({ turnId: r.turnId, audioMs, chars, silent: r.ttsSilent }),
            tts_silent: r.ttsSilent === true,
          };
        });
        return { rows: mapped, dropped };
      });

    const turnLatencies = (conversationId: string) => turnRowsForMany([conversationId]).pipe(Effect.map((r) => r.rows as ReadonlyArray<TurnLatencyRow>));

    const turnRowsFor = turnRowsForMany;

    const latencyAggregateFor = (
      conversationIds: ReadonlyArray<string>,
      turns?: { readonly decider?: string | null | undefined } | undefined,
    ): Effect.Effect<LatencyAggregate, never, PgClient.PgClient> =>
      turnRowsFor(conversationIds, turns).pipe(Effect.map(({ rows, dropped }) => aggregateTurnRows(conversationIds.length, rows, dropped)));

    const latencyAggregate = (calls: number): Effect.Effect<LatencyAggregate, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* sql<{ id: string }>`SELECT id FROM conversations ORDER BY started_at DESC, id DESC LIMIT ${calls}`.pipe(Effect.orDie);
        return yield* latencyAggregateFor(ids.map((r) => r.id));
      });

    const latencyAggregateForSegment = (
      segment: {
        readonly channel: string | null;
        readonly decider: string | null;
        readonly harness?: string | null | undefined;
        readonly turnDecider?: string | null | undefined;
      },
      calls: number,
    ): Effect.Effect<{ aggregate: LatencyAggregate; found: number }, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        // `undefined` means the default, which excludes harness calls: their audio is deliberately
        // harder than a real call's, so leaving them in moves the latency number for everyone.
        const wanted = segment.harness ?? null;
        const ids = yield* sql<{ id: string }>`
          SELECT id FROM conversations
          WHERE (${segment.channel}::text IS NULL OR channel = ${segment.channel}::text)
            AND (${segment.decider}::text IS NULL OR decider = ${segment.decider}::text)
            AND harness IS NOT DISTINCT FROM ${wanted}::text
          ORDER BY started_at DESC, id DESC LIMIT ${calls}`.pipe(Effect.orDie);
        const aggregate = yield* latencyAggregateFor(
          ids.map((r) => r.id),
          { decider: segment.turnDecider ?? null },
        );
        return { aggregate, found: ids.length };
      });

    const scheduledActionsFor = (workflowExecutionId: string) => sched.listForWorkflow(workflowExecutionId);
    const outboxJobsFor = (conversationId: string) => sched.listJobsForConversation(conversationId);

    return {
      listConversations,
      conversationDetail,
      borrowerDirectory,
      heartbeats,
      ledgerCounts,
      ledgerCountsForStatus: () => ledgerCountsForStatus,
      reliabilityCountsFor: (ids: ReadonlyArray<string>) =>
        conv.reliabilityCountsFor(ids).pipe(
          Effect.map((r) => ({
            turns_superseded: r.turnsSuperseded,
            no_input_closes: r.noInputCloses,
            decider_unavailable: r.deciderUnavailable,
            tts_silent_playouts: r.ttsSilentPlayouts,
            readbacks_repeated_unheard: r.readbacksRepeatedUnheard,
            calls_orphaned: r.callsOrphaned,
          })),
        ),
      turnLatencies,
      latencyAggregateForSegment,
      turnRowsFor,
      latencyAggregate,
      latencyAggregateFor,
      scheduledActionsFor,
      outboxJobsFor,
    } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, SchedulingRepo.Default],
}) {}

const coerce = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const aggregateTurnRows = (conversations: number, all: ReadonlyArray<TurnLatencyRow>, dropped: number): LatencyAggregate => {
  const pct = (values: ReadonlyArray<number | null>) => {
    const xs = values.filter((v): v is number => v !== null);
    const at = (p: number) => {
      const v = percentile(xs, p);
      return v === null ? null : Math.round(v);
    };
    return { n: xs.length, p50: at(50), p95: at(95) };
  };
  // The total is taken only over turns carrying all four components; a simulated turn records the
  // decide TTFT alone, which would report a p50 of ~20 ms for an end-to-end reply time.
  const complete = all.filter((t) => t.eou_delay_ms !== null && t.transcription_delay_ms !== null && t.ttft_ms !== null && t.tts_ttfb_ms !== null);
  return {
    conversations,
    turns: all.length,
    implausible_dropped: dropped,
    eou_delay_ms: pct(all.map((t) => t.eou_delay_ms)),
    transcription_delay_ms: pct(all.map((t) => t.transcription_delay_ms)),
    ttft_ms: pct(all.map((t) => t.ttft_ms)),
    tts_ttfb_ms: pct(all.map((t) => t.tts_ttfb_ms)),
    total_ms: pct(complete.map((t) => t.total_ms)),
  };
};

export const ttsReadingsOf = (rows: ReadonlyArray<TurnLatencyRow>): ReadonlyArray<TurnTtsReading> =>
  rows.map((r) => ({ turnId: r.turn_id, audioMs: r.tts_audio_ms, chars: r.tts_chars, silent: r.tts_silent, ttfbMs: r.tts_ttfb_ms }));
