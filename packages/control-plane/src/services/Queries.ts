/**
 * Read side for the operator console and API (SPEC §12.3/§12.4): list, detail with
 * transcript + timeline + replay snapshot, borrowers for the demo picker, worker liveness.
 */
import { DateTime, Effect, Option } from "effect";
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

    const scheduledActionsFor = (workflowExecutionId: string) => sched.listForWorkflow(workflowExecutionId);
    const outboxJobsFor = (conversationId: string) => sched.listJobsForConversation(conversationId);

    return { listConversations, conversationDetail, borrowerDirectory, heartbeats, scheduledActionsFor, outboxJobsFor } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, SchedulingRepo.Default],
}) {}
