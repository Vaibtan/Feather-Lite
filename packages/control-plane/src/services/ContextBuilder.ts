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
import { CrmRepo } from "../repos/crm.js";

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
    const crm = yield* CrmRepo;
    const conv = yield* ConversationRepo;

    const forConversation = (row: ConversationRow, now: DateTime.Utc) =>
      Effect.gen(function* () {
        const borrower = yield* crm.findBorrower(row.borrowerId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "borrower", id: row.borrowerId })), onSome: Effect.succeed })),
        );
        const attempt = yield* conv.findAttempt(row.callAttemptId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "call_attempt", id: row.callAttemptId })), onSome: Effect.succeed })),
        );
        const workflow = yield* conv.findWorkflow(attempt.workflowExecutionId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "workflow_execution", id: attempt.workflowExecutionId })), onSome: Effect.succeed })),
        );
        const contactPoint = yield* crm.findContactPoint(attempt.contactPointId);
        const loan = yield* crm.primaryLoanForBorrower(row.borrowerId);
        const prior = yield* conv.priorConversations({ borrowerId: row.borrowerId, excludeId: row.id, limit: 5 });

        const timeZone = Option.getOrNull(contactPoint)?.timezoneOverride ?? borrower.timezone;
        const publicContext: PublicContext = {
          agent_name: cfg.agentName,
          company: cfg.companyName,
          callback_number: cfg.callbackNumber,
          workflow_type: workflow.workflowType,
          attempt_no: workflow.currentAttemptNo,
          local_time_description: describeLocalTime(now, timeZone),
          borrower_first_name: firstName(borrower.name),
        };
        const protectedContext: ProtectedContext | null = Option.isSome(loan)
          ? {
              borrower_full_name: borrower.name,
              balance_due: loan.value.balanceDue,
              due_date: loan.value.dueDate,
              loan_status: loan.value.status,
              delinquency_days: loan.value.delinquencyDays,
              last_promise_date: loan.value.lastPromiseDate,
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
          borrowerFirstName: firstName(borrower.name),
          loanId: Option.isSome(loan) ? loan.value.id : "",
          contactPointId: attempt.contactPointId,
          workflowExecutionId: attempt.workflowExecutionId,
        };
        return ctx;
      });

    return { forConversation } as const;
  }),
  dependencies: [CrmRepo.Default, ConversationRepo.Default],
}) {}
