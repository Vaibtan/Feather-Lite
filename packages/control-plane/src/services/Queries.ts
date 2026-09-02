/**
 * Read side for the operator console and API (SPEC §12.3/§12.4): list, detail with
 * transcript + timeline + replay snapshot, borrowers for the demo picker, worker liveness.
 */
import { DateTime, Duration, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { LatencyAggregate, TurnLatencyRow } from "@feather-lite/contracts";
import type { EventRecord, ReplaySnapshot, TimelineEntry, TranscriptEntry, TurnTtsReading } from "@feather-lite/domain";
import { buildTimeline, buildTranscript, charsPerSecond, isWithinContactWindow, percentile, replay } from "@feather-lite/domain";
import { NotFound } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
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

/** The durable, all-time ledger view. Named at module scope so the service's type can refer to it. */
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

    /** Borrowers with their primary contact point and whether a call is allowed right now (for the demo picker). */
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

    /** Durable counts for /api/system/status ("the state machine caught the model N times"). */
    /**
     * The durable, all-time ledger view, memoised for 5 seconds (O10/O11).
     *
     * Four aggregate scans of `conversation_events`, one of them with a correlated NOT EXISTS, run
     * on every `/status` poll — and the console polls every 5 s, per open tab. Measured on a
     * 13 982-conversation database this is what `/status` spends its ~0.29 s on; the O11 work on
     * the turn window could not move that number at all until this was cached.
     *
     * All-time counts over an append-only ledger cannot meaningfully change inside five seconds,
     * and the page labels them "all time" precisely because they are not a live reading.
     */

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

    /**
     * The same counts for the status page, memoised for 5 seconds.
     *
     * The cache is here rather than inside `ledgerCounts` deliberately. That function is what the
     * DB tests read as a source of truth immediately after writing events, and a five-second-stale
     * answer broke four of them — correctly, because a stale read *is* wrong for that caller. It is
     * right only for a dashboard that polls every five seconds, so only that caller opts in.
     *
     * `Effect.cachedWithTTL` rather than a hand-rolled timestamp cell, because a timestamp cell
     * does not deduplicate *concurrent* callers: N console tabs polling a cold or expired entry
     * would each run the full scan before any of them wrote the result, which is precisely the
     * scenario this exists to prevent. `cachedWithTTL` holds a latch, so the second through Nth
     * callers await the first instead of repeating its work.
     */
    const ledgerCountsForStatus = yield* Effect.cachedWithTTL(ledgerCounts(), Duration.seconds(5));

    /**
     * The per-turn latency waterfall across a set of conversations, read straight out of
     * `conversation_turns.result` — `ttft_ms` written by the orchestrator, the three worker-side
     * numbers merged in later by the `turn_metrics` signal.
     *
     * One query for the whole set, not one per conversation (O11). It used to be called in a loop:
     * measured at ~1.4 ms per conversation and linear, so the status page's `MAX_WINDOW` of 1 000
     * meant ~1.4 s of round trips — on an endpoint the console polls every 5 seconds. A console tab
     * left open during a load run was itself a meaningful share of the load.
     */
    /**
     * The turn-level half of the segment (F4).
     *
     * `latencyAggregateForSegment` selects *conversations* — channel, decider, harness. That cannot
     * separate two turns of the same call, and D2's fast path makes them genuinely different
     * populations: a regex answering in a microsecond and a model turn taking two seconds are both
     * `voice`/`openai`, so mixing them moves the p95 the product's latency claim is made from
     * without anything getting faster. It is O2's defect one level down.
     *
     * `null` (or an absent predicate) means "do not filter", so every existing window is unchanged.
     * Reads `result->>'decider'`, which `TurnResult` already carries into `conversation_turns.result`
     * — no migration.
     */
    const turnRowsForMany = (
      conversationIds: ReadonlyArray<string>,
      turns?: { readonly decider?: string | null | undefined } | undefined,
    ): Effect.Effect<{ rows: TurnLatencyRow[]; dropped: number }, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        // `sql.in` of an empty set is not valid SQL, and an empty window is a normal thing to ask
        // about — a fresh database, or a range with no calls in it.
        if (conversationIds.length === 0) return { rows: [], dropped: 0 };
        const sql = yield* PgClient.PgClient;
        // The client camel-cases result keys, so `turn_id` arrives as `turnId`.
        const rows = yield* sql<{
          turnId: string;
          startedAt: Date;
          status: string;
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
                 t.result->>'newState'                             AS state,
                 (t.result->>'eou_delay_ms')::float8               AS eou_delay_ms,
                 (t.result->>'transcription_delay_ms')::float8     AS transcription_delay_ms,
                 (t.result->>'ttftMs')::float8                     AS ttft_ms,
                 (t.result->>'tts_ttfb_ms')::float8                AS tts_ttfb_ms,
                 (t.result->>'tts_audio_ms')::float8               AS tts_audio_ms,
                 (t.result->>'tts_chars')::float8                  AS tts_chars,
                 -- The SQL twin of the domain's silentPlayoutTurnIds: nothing heard *and* cut short,
                 -- which is how the worker reports a zero-audio turn (ADR 0008), *and* not a turn the
                 -- borrower superseded before the agent ever replied -- that reports the same shape
                 -- and is not a TTS failure. Change one, change both.
                 (
                   EXISTS (
                     SELECT 1 FROM conversation_events e
                     WHERE e.conversation_id = t.conversation_id
                       AND e.type = 'AGENT_TURN_PLAYOUT'
                       AND e.payload->>'turn_id' = t.turn_id
                       AND e.payload->>'interrupted' = 'true'
                       AND e.payload->>'heard_text' = ''
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM conversation_events s
                     WHERE s.conversation_id = t.conversation_id
                       AND s.type = 'TURN_SUPERSEDED'
                       AND s.payload->>'turn_id' = t.turn_id
                   )
                 )                                                 AS tts_silent
          FROM conversation_turns t
          WHERE t.conversation_id IN ${sql.in(conversationIds)}
            AND (${turns?.decider ?? null}::text IS NULL OR t.result->>'decider' = ${turns?.decider ?? null}::text)
          ORDER BY t.conversation_id, t.started_at ASC`.pipe(Effect.orDie);
        // `::float8` can still surface as a string depending on the driver's type parsing, so each
        // component is coerced once here rather than trusted.
        //
        // Values outside a plausible range are dropped rather than plotted. Turns written before
        // the TTFT clock fix carry a "latency" of several days — the old code subtracted a virtual
        // (VirtualClock-shifted) start from a real `Date.now()` — and one of those in the sample
        // makes every percentile meaningless. Five minutes is not a turn component either way.
        const MAX_PLAUSIBLE_MS = 300_000;
        let dropped = 0;
        /** A latency component: absent stays absent, anything impossible is dropped and counted. */
        const num = (v: unknown): number | null => {
          if (v === null || v === undefined) return null;
          const n = coerce(v);
          if (n !== null && n >= 0 && n <= MAX_PLAUSIBLE_MS) return n;
          dropped += 1;
          return null;
        };
        // Counts and played durations are not latency components: they are not summed into
        // `total_ms`, and a long read-back or a big character count is not an implausible *latency*
        // to be reported as dropped data. Same coercion, no range guard, no drop count.
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
            state: r.state,
            eou_delay_ms: eou,
            transcription_delay_ms: stt,
            ttft_ms: ttft,
            tts_ttfb_ms: tts,
            total_ms: parts.length > 0 ? Math.round(parts.reduce((a, b) => a + b, 0)) : null,
            tts_audio_ms: audioMs,
            tts_chars: chars,
            // One definition of the rate, in the domain, so the console's per-turn figure and the
            // fleet's median cannot be computed two different ways.
            tts_chars_per_second: charsPerSecond({ turnId: r.turnId, audioMs, chars, silent: r.ttsSilent }),
            tts_silent: r.ttsSilent === true,
          };
        });
        return { rows: mapped, dropped };
      });

    /** One conversation's waterfall, for the call detail page. */
    const turnLatencies = (conversationId: string) => turnRowsForMany([conversationId]).pipe(Effect.map((r) => r.rows as ReadonlyArray<TurnLatencyRow>));

    /**
     * The same components across an explicit set of conversations.
     *
     * Taking the ids rather than a count is what lets the Quality report measure the SLO over
     * *its own* window: a `from`/`to` range and "the most recent N" are different sets of calls, and
     * an SLO computed over a different window than the funnel beside it is a number that cannot be
     * reconciled with anything on the page.
     */
    const turnRowsFor = turnRowsForMany;

    const latencyAggregateFor = (
      conversationIds: ReadonlyArray<string>,
      turns?: { readonly decider?: string | null | undefined } | undefined,
    ): Effect.Effect<LatencyAggregate, never, PgClient.PgClient> =>
      turnRowsFor(conversationIds, turns).pipe(Effect.map(({ rows, dropped }) => aggregateTurnRows(conversationIds.length, rows, dropped)));

    /** The same components across the most recent N conversations, as p50/p95. */
    const latencyAggregate = (calls: number): Effect.Effect<LatencyAggregate, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* sql<{ id: string }>`SELECT id FROM conversations ORDER BY started_at DESC, id DESC LIMIT ${calls}`.pipe(Effect.orDie);
        return yield* latencyAggregateFor(ids.map((r) => r.id));
      });

    /**
     * The same, over the most recent N conversations **in a segment** (O2).
     *
     * "The last 50 calls" and "the last 50 voice calls served by the real decider" are different
     * windows, and an SLO computed over the first is diluted by whatever else ran recently — a
     * tier-1 load run moved `ttft_ms` 3 228 -> 1 252 ms without anything getting faster. A null
     * facet means "do not filter on this", so the unsegmented window is still expressible.
     *
     * `found` is returned alongside because "the window asked for 50 and found 3" is the fact that
     * makes a green verdict readable.
     */
    const latencyAggregateForSegment = (
      segment: {
        readonly channel: string | null;
        readonly decider: string | null;
        readonly harness?: string | null | undefined;
        /**
         * Which arm decided the turns to count (F4). Conversation-level facets cannot express this:
         * a fast-path turn and a model turn of one call share every one of them.
         */
        readonly turnDecider?: string | null | undefined;
      },
      calls: number,
    ): Effect.Effect<{ aggregate: LatencyAggregate; found: number }, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        /**
         * Harness calls are excluded unless one is asked for (issue #1, D4's segment rule).
         *
         * A tier-3 call is `channel: 'voice'` served by the real decider — exactly what the default
         * segment selects — and its audio is deliberately harder than a real call's: degraded
         * channel, seeded interruptions, accent personas. Left in, the simulator would move the
         * number the product's latency claim is made from.
         *
         * Not hypothetical: a tier-1 load run put 36 scripted turns into the "last 50 calls" window
         * and `ttft_ms` fell 3 228 -> 1 252 ms. Nothing got faster.
         *
         * `undefined` means the default — real callers only. An explicit `"sim"` asks for the
         * simulator's own segment, which is how its numbers are read.
         */
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

/** `::float8` can surface as a string depending on the driver's type parsing; coerce once. */
const coerce = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Percentiles per waterfall component over a set of turn rows. Separated from the query so the
 * Quality report can read the window's rows once and derive both this and the TTS heuristics from
 * them, rather than asking the database for the same turns twice.
 */
export const aggregateTurnRows = (conversations: number, all: ReadonlyArray<TurnLatencyRow>, dropped: number): LatencyAggregate => {
  const pct = (values: ReadonlyArray<number | null>) => {
    const xs = values.filter((v): v is number => v !== null);
    const at = (p: number) => {
      const v = percentile(xs, p);
      return v === null ? null : Math.round(v);
    };
    return { n: xs.length, p50: at(50), p95: at(95) };
  };
  // The total is taken only over turns that have all four components. A simulated turn records the
  // decide TTFT alone, and letting those into the total would report a p50 of ~20ms for something
  // that means "how long a reply takes end to end".
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

/** The TTS readings of a window's turns, in the shape the domain heuristics take. */
export const ttsReadingsOf = (rows: ReadonlyArray<TurnLatencyRow>): ReadonlyArray<TurnTtsReading> =>
  rows.map((r) => ({ turnId: r.turn_id, audioMs: r.tts_audio_ms, chars: r.tts_chars, silent: r.tts_silent, ttfbMs: r.tts_ttfb_ms }));
