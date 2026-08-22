/**
 * Read side for the operator console and API (SPEC §12.3/§12.4): list, detail with
 * transcript + timeline + replay snapshot, borrowers for the demo picker, worker liveness.
 */
import { DateTime, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { LatencyAggregate, TurnLatencyRow } from "@feather-lite/contracts";
import type { EventRecord, ReplaySnapshot, TimelineEntry, TranscriptEntry } from "@feather-lite/domain";
import { buildTimeline, buildTranscript, isWithinContactWindow, replay } from "@feather-lite/domain";
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
    readonly current_state: string;
    readonly protected_context_unlocked: boolean;
    readonly transfer_target: string | null;
  };
  readonly transcript: ReadonlyArray<TranscriptEntry>;
  readonly event_timeline: ReadonlyArray<TimelineEntry>;
  readonly replay: ReplaySnapshot;
  readonly events: ReadonlyArray<EventRecord>;
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
    const ledgerCounts = () =>
      Effect.gen(function* () {
        const total = yield* conv.countConversations();
        const outcomes = yield* conv.outcomeCounts();
        const guardrails = yield* conv.guardrailCounts();
        return {
          conversations_total: total.count,
          outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o.count])),
          guardrails: Object.fromEntries(guardrails.map((g) => [g.type, g.count])),
        };
      });

    /**
     * The per-turn latency waterfall for one conversation, read straight out of
     * `conversation_turns.result` — `ttft_ms` written by the orchestrator, the three worker-side
     * numbers merged in later by the `turn_metrics` signal.
     */
    const turnLatenciesWithDropped = (conversationId: string): Effect.Effect<{ rows: TurnLatencyRow[]; dropped: number }, never, PgClient.PgClient> =>
      Effect.gen(function* () {
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
        }>`
          SELECT turn_id,
                 started_at,
                 status,
                 result->>'newState'                             AS state,
                 (result->>'eou_delay_ms')::float8               AS eou_delay_ms,
                 (result->>'transcription_delay_ms')::float8     AS transcription_delay_ms,
                 (result->>'ttftMs')::float8                     AS ttft_ms,
                 (result->>'tts_ttfb_ms')::float8                AS tts_ttfb_ms
          FROM conversation_turns
          WHERE conversation_id = ${conversationId}
          ORDER BY started_at ASC`.pipe(Effect.orDie);
        // `::float8` can still surface as a string depending on the driver's type parsing, so each
        // component is coerced once here rather than trusted.
        //
        // Values outside a plausible range are dropped rather than plotted. Turns written before
        // the TTFT clock fix carry a "latency" of several days — the old code subtracted a virtual
        // (VirtualClock-shifted) start from a real `Date.now()` — and one of those in the sample
        // makes every percentile meaningless. Five minutes is not a turn component either way.
        const MAX_PLAUSIBLE_MS = 300_000;
        let dropped = 0;
        const num = (v: unknown): number | null => {
          if (v === null || v === undefined) return null;
          const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
          if (Number.isFinite(n) && n >= 0 && n <= MAX_PLAUSIBLE_MS) return n;
          dropped += 1;
          return null;
        };
        const mapped = rows.map((r) => {
          const eou = num(r.eouDelayMs);
          const stt = num(r.transcriptionDelayMs);
          const ttft = num(r.ttftMs);
          const tts = num(r.ttsTtfbMs);
          const parts = [eou, stt, ttft, tts].filter((v): v is number => v !== null);
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
          };
        });
        return { rows: mapped, dropped };
      });

    const turnLatencies = (conversationId: string) => turnLatenciesWithDropped(conversationId).pipe(Effect.map((r) => r.rows as ReadonlyArray<TurnLatencyRow>));

    /** The same components across the most recent N conversations, as p50/p95. */
    const latencyAggregate = (calls: number): Effect.Effect<LatencyAggregate, never, PgClient.PgClient> =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* sql<{ id: string }>`
          SELECT id FROM conversations ORDER BY started_at DESC LIMIT ${calls}`.pipe(Effect.orDie);
        const all: TurnLatencyRow[] = [];
        let dropped = 0;
        for (const { id } of ids) {
          const r = yield* turnLatenciesWithDropped(id);
          all.push(...r.rows);
          dropped += r.dropped;
        }
        const pct = (values: ReadonlyArray<number | null>) => {
          const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
          const at = (p: number) => (xs.length === 0 ? null : Math.round(xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0));
          return { n: xs.length, p50: at(50), p95: at(95) };
        };
        // The total is taken only over turns that have all four components. A simulated turn
        // records the decide TTFT alone, and letting those into the total would report a p50 of
        // ~20ms for something that means "how long a reply takes end to end".
        const complete = all.filter((t) => t.eou_delay_ms !== null && t.transcription_delay_ms !== null && t.ttft_ms !== null && t.tts_ttfb_ms !== null);
        return {
          conversations: ids.length,
          turns: all.length,
          implausible_dropped: dropped,
          eou_delay_ms: pct(all.map((t) => t.eou_delay_ms)),
          transcription_delay_ms: pct(all.map((t) => t.transcription_delay_ms)),
          ttft_ms: pct(all.map((t) => t.ttft_ms)),
          tts_ttfb_ms: pct(all.map((t) => t.tts_ttfb_ms)),
          total_ms: pct(complete.map((t) => t.total_ms)),
        };
      });

    const scheduledActionsFor = (workflowExecutionId: string) => sched.listForWorkflow(workflowExecutionId);
    const outboxJobsFor = (conversationId: string) => sched.listJobsForConversation(conversationId);

    return { listConversations, conversationDetail, borrowerDirectory, heartbeats, ledgerCounts, turnLatencies, latencyAggregate, scheduledActionsFor, outboxJobsFor } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, SchedulingRepo.Default],
}) {}
