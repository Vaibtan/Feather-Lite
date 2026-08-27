/**
 * Workflow orchestrator (SPEC §5.2, §14): pre-call policy, workflow reuse, attempt
 * creation, conversation bootstrap. `startCall` is the single entry point for both the
 * API and the scheduled-action worker.
 */
import { DateTime, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { Channel, WorkflowType } from "@feather-lite/domain";
import { POLICY, evaluatePreCall, openingScript } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { NotFound, PreCallRejected } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";

export interface StartCallInput {
  readonly borrowerId: string;
  readonly contactPointId: string;
  readonly channel: Channel;
  /** Reuse an existing workflow (scheduled callback / retry). */
  readonly workflowExecutionId?: string | undefined;
  readonly workflowType?: WorkflowType | undefined;
  /** Demo-mode clock override; ignored unless `demoMode`. */
  readonly now?: DateTime.Utc | undefined;
}

export interface StartCallResult {
  readonly conversationId: string;
  readonly workflowExecutionId: string;
  readonly callAttemptId: string;
  readonly attemptNo: number;
  readonly openingText: string;
}

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full;

export class WorkflowService extends Effect.Service<WorkflowService>()("@feather-lite/WorkflowService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const cfg = yield* AppConfig;
    const crm = yield* CrmRepo;
    const conv = yield* ConversationRepo;
    const sched = yield* SchedulingRepo;
    const ids = yield* IdGen;

    const startCall = (input: StartCallInput) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = cfg.demoMode && input.now ? input.now : yield* DateTime.now;
          const nowDate = DateTime.toDateUtc(now);

          const borrower = yield* crm.lockBorrower(input.borrowerId).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "borrower", id: input.borrowerId })), onSome: Effect.succeed })),
          );
          const contactPoint = yield* crm.findContactPoint(input.contactPointId).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "contact_point", id: input.contactPointId })), onSome: Effect.succeed })),
          );
          const link = yield* crm.findLink({ borrowerId: borrower.id, contactPointId: contactPoint.id });
          const loan = yield* crm.primaryLoanForBorrower(borrower.id).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "loan for borrower", id: borrower.id })), onSome: Effect.succeed })),
          );

          const recent = yield* conv.countRecentAttempts({
            borrowerId: borrower.id,
            contactPointId: contactPoint.id,
            since: DateTime.toDateUtc(DateTime.subtract(now, { days: POLICY.frequencyCapWindowDays })),
          });
          const active = yield* conv.hasActiveConversation(borrower.id);
          const conflicts = yield* sched.countPendingConflicts(borrower.id);
          // A scheduled action re-entering startCall has already been CLAIMED, so it never conflicts with itself.

          const failures = evaluatePreCall({
            now,
            borrower: { status: borrower.status, timezone: borrower.timezone },
            contactPoint: {
              isValid: contactPoint.isValid,
              consentStatus: contactPoint.consentStatus,
              timezoneOverride: contactPoint.timezoneOverride,
              linkedToBorrower: Option.isSome(link),
            },
            recentAttemptCount: recent.count,
            hasActiveConversation: active.count > 0,
            conflictingPendingActions: input.workflowExecutionId ? 0 : conflicts.count,
          });
          if (failures.length > 0) return yield* Effect.fail(new PreCallRejected({ failures }));

          // A manual/API start supersedes any pending system retry for this borrower (SPEC §14.2 intent:
          // never double-dial; a scheduled action re-entering here is already CLAIMED, so it is unaffected).
          if (!input.workflowExecutionId) yield* sched.cancelPendingRetriesForBorrower(borrower.id, "superseded_by_new_call");

          const agentVersion = yield* crm.ensureActiveAgentVersion(yield* ids.next(), "collections-v2", "v2-bootstrap");
          const workflowType = input.workflowType ?? "PAYMENT_REMINDER";
          let workflowId: string;
          if (input.workflowExecutionId) {
            const wf = yield* conv.lockWorkflow(input.workflowExecutionId);
            if (Option.isNone(wf)) return yield* Effect.fail(new NotFound({ entity: "workflow_execution", id: input.workflowExecutionId }));
            workflowId = wf.value.id;
          } else {
            const open = yield* conv.findOpenWorkflow({ borrowerId: borrower.id, loanId: loan.id, workflowType });
            if (Option.isSome(open)) workflowId = open.value.id;
            else {
              workflowId = yield* ids.next();
              yield* conv.insertWorkflow({ id: workflowId, borrowerId: borrower.id, loanId: loan.id, workflowType });
            }
          }
          const { currentAttemptNo } = yield* conv.incrementAttemptNo(workflowId);

          const attemptId = yield* ids.next();
          yield* conv.insertAttempt({ id: attemptId, workflowExecutionId: workflowId, contactPointId: contactPoint.id, direction: "OUTBOUND", startedAt: nowDate });
          const conversationId = yield* ids.next();
          yield* conv.insertConversation({
            id: conversationId,
            callAttemptId: attemptId,
            borrowerId: borrower.id,
            agentVersionId: agentVersion.id,
            startedAt: nowDate,
            channel: input.channel,
            // Recorded now, from the config that will actually serve it, rather than inferred later:
            // the SLO window has to be able to exclude scripted turns, and by the time the report is
            // built nothing on the row says which decider ran (O2).
            decider: cfg.turnDecider,
          });
          yield* conv.lockConversation(conversationId);
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId,
            event: {
              type: "CALL_STARTED",
              payload: {
                workflow_execution_id: workflowId,
                call_attempt_id: attemptId,
                contact_point_id: contactPoint.id,
                channel: input.channel,
                attempt_no: currentAttemptNo,
              },
            },
            createdAt: nowDate,
          });
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId,
            event: { type: "STATE_TRANSITION", payload: { from: null, to: "GREETING", triggered_by: "SYSTEM_START" } },
            createdAt: nowDate,
          });
          const openingText = openingScript({
            agent_name: cfg.agentName,
            company: cfg.companyName,
            callback_number: cfg.callbackNumber,
            workflow_type: workflowType,
            attempt_no: currentAttemptNo,
            local_time_description: "",
            borrower_first_name: firstName(borrower.name),
          });
          // Simulated calls "speak" the opening immediately. Voice calls record it only when the
          // runtime reports it was actually played (`opening_played` signal) — never into a voicemail.
          if (input.channel === "simulated") {
            yield* conv.appendEvent({
              id: yield* ids.next(),
              conversationId,
              event: { type: "AGENT_TURN", payload: { text: openingText, state: "GREETING", turn_id: "opening", speak_mode: "non_interruptible" } },
              createdAt: nowDate,
            });
          }

          const result: StartCallResult = { conversationId, workflowExecutionId: workflowId, callAttemptId: attemptId, attemptNo: currentAttemptNo, openingText };
          return result;
        }),
      );

    return { startCall } as const;
  }),
  dependencies: [CrmRepo.Default, ConversationRepo.Default, SchedulingRepo.Default, IdGen.Default],
}) {}
