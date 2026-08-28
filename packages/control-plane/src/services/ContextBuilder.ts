/**
 * Builds the layered prompt context for a conversation (SPEC §9): public, protected,
 * and the compact cross-call memory block. The *gate* (`visibleContext`) is applied by
 * the orchestrator per turn — this service only assembles the bundle.
 */
import { DateTime, Effect, Option } from "effect";
import type { ContextBundle, MemoryBlock, Outcome, ProtectedContext, PublicContext } from "@feather-lite/domain";
import { buildMemoryBlock, localIsoDate } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { NotFound } from "../errors.js";
import type { ConversationRow } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";

export interface ConversationContext {
  readonly bundle: ContextBundle;
  readonly borrowerTimeZone: string;
  readonly borrowerLocalDate: string;
  readonly borrowerFirstName: string;
  readonly loanId: string;
  readonly contactPointId: string;
  readonly workflowExecutionId: string;
}

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full;

const describeLocalTime = (now: DateTime.Utc, timeZone: string): string =>
  DateTime.setZoneNamed(now, timeZone).pipe(
    Option.map((z) =>
      DateTime.formatIntl(
        z,
        new Intl.DateTimeFormat("en-US", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone,
          timeZoneName: "short",
        }),
      ),
    ),
    Option.getOrElse(() => DateTime.formatIso(now)),
  );

export class ContextBuilder extends Effect.Service<ContextBuilder>()("@feather-lite/ContextBuilder", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const conv = yield* ConversationRepo;

    const forConversation = (row: ConversationRow, now: DateTime.Utc) =>
      Effect.gen(function* () {
        /**
         * Two queries, not six (D5). This runs inside T1 with the conversation row lock held, and
         * it used to be borrower, attempt, workflow, contact point and loan one after another on
         * the same pooled connection — five serial round trips per turn, under the lock, before
         * anything about the turn had happened.
         *
         * The first four of the five were only ever sequential because each was written
         * separately; the attempt names the workflow and the contact point, and the borrower and
         * the loan hang off the borrower id this row already carries. `priorConversations` returns
         * many rows and stays its own query.
         */
        const ctxRow = yield* conv.contextForConversation({ borrowerId: row.borrowerId, callAttemptId: row.callAttemptId }).pipe(
          Effect.flatMap(
            Option.match({
              /**
               * One `None` where there used to be three named ones. Every join here is across a
               * foreign key, so the only way to reach this is an attempt id that does not exist —
               * the borrower and workflow cannot be missing while the attempt is present. The
               * message names both ids so the loss of granularity costs nothing diagnostically.
               */
              onNone: () => Effect.fail(new NotFound({ entity: "call_attempt", id: `${row.callAttemptId} (borrower ${row.borrowerId})` })),
              onSome: Effect.succeed,
            }),
          ),
        );
        const prior = yield* conv.priorConversations({ borrowerId: row.borrowerId, excludeId: row.id, limit: 5 });

        const timeZone = ctxRow.timezoneOverride ?? ctxRow.borrowerTimezone;
        const publicContext: PublicContext = {
          agent_name: cfg.agentName,
          company: cfg.companyName,
          callback_number: cfg.callbackNumber,
          workflow_type: ctxRow.workflowType,
          attempt_no: ctxRow.currentAttemptNo,
          local_time_description: describeLocalTime(now, timeZone),
          borrower_first_name: firstName(ctxRow.borrowerName),
        };
        /**
         * All-or-nothing on the loan, as it was when this came from an `Option<LoanRow>`: the outer
         * join makes every loan column null together, and `loanId` is the one that cannot be null
         * on a real row.
         */
        const protectedContext: ProtectedContext | null =
          ctxRow.loanId !== null
            ? {
                borrower_full_name: ctxRow.borrowerName,
                balance_due: ctxRow.balanceDue ?? "0.00",
                due_date: ctxRow.dueDate ?? "",
                loan_status: ctxRow.loanStatus ?? "CURRENT",
                delinquency_days: ctxRow.delinquencyDays ?? 0,
                last_promise_date: ctxRow.lastPromiseDate,
              }
            : null;
        const memory: MemoryBlock = buildMemoryBlock(
          prior.map((p) => ({
            final_outcome: (p.finalOutcome ?? null) as Outcome | null,
            ended_at: p.endedAt?.toISOString() ?? null,
            protected_context_unlocked: p.protectedContextUnlocked,
            final_outcome_metadata: p.finalOutcomeMetadata,
          })),
        );
        const ctx: ConversationContext = {
          bundle: { publicContext, protectedContext, memory },
          borrowerTimeZone: timeZone,
          borrowerLocalDate: Option.getOrElse(localIsoDate(now, timeZone), () => DateTime.formatIsoDate(now)),
          borrowerFirstName: firstName(ctxRow.borrowerName),
          loanId: ctxRow.loanId ?? "",
          contactPointId: ctxRow.contactPointId,
          workflowExecutionId: ctxRow.workflowExecutionId,
        };
        return ctx;
      });

    return { forConversation } as const;
  }),
  // `CrmRepo` is gone from this service: the one query it needs lives on `ConversationRepo` beside
  // the conversation it is about.
  dependencies: [ConversationRepo.Default],
}) {}
