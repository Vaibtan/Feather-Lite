import { DateTime, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { ScheduledActionType } from "@feather-lite/domain";
import { POLICY, nextLocalHour } from "@feather-lite/domain";
import type { ScheduledActionRow } from "../db/rows.js";
import { PreCallRejected, TelephonyError } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { AppConfig } from "../config.js";
import { IdGen } from "./Ids.js";
import { NO_MEDIA_PLANE, NO_SIP_TRUNK, canDialOut, dispatchAgent, hasMediaPlane, roomNameFor } from "./voiceDispatch.js";
import { WorkflowService } from "./Workflow.js";

export interface ProcessedAction {
  readonly actionId: string;
  readonly actionType: ScheduledActionType;
  readonly status: "DONE" | "RESCHEDULED" | "CANCELED" | "FAILED";
  readonly detail: Record<string, unknown>;
}

export class SchedulingService extends Effect.Service<SchedulingService>()("@feather-lite/SchedulingService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sched = yield* SchedulingRepo;
    const conv = yield* ConversationRepo;
    const cfg = yield* AppConfig;
    const crm = yield* CrmRepo;
    const ids = yield* IdGen;
    const workflow = yield* WorkflowService;

    const create = (params: {
      workflowExecutionId: string;
      actionType: ScheduledActionType;
      dueAt: Date;
      payload: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        const id = yield* ids.next();
        yield* sched.insertScheduledAction({ id, ...params });
        return id;
      });

    const createRetry = (params: {
      workflowExecutionId: string;
      borrowerId: string;
      contactPointId: string;
      channel: string;
      reason: string;
      now: Date;
    }) =>
      create({
        workflowExecutionId: params.workflowExecutionId,
        actionType: "RETRY_CALL",
        dueAt: new Date(params.now.getTime() + POLICY.retryDelayHours * 3_600_000),
        payload: { borrower_id: params.borrowerId, contact_point_id: params.contactPointId, channel: params.channel, reason: params.reason },
      });

    const createHumanFollowup = (params: {
      workflowExecutionId: string;
      borrowerId: string;
      contactPointId: string;
      conversationId: string;
      queue: string;
      reason: string;
      now: Date;
    }) =>
      create({
        workflowExecutionId: params.workflowExecutionId,
        actionType: "HUMAN_FOLLOWUP",
        dueAt: params.now,
        payload: {
          borrower_id: params.borrowerId,
          contact_point_id: params.contactPointId,
          conversation_id: params.conversationId,
          queue: params.queue,
          reason: params.reason,
        },
      });

    const scheduleCallback = (params: {
      workflowExecutionId: string;
      borrowerId: string;
      contactPointId: string;
      channel: string;
      dueAt: Date;
      reason: string;
    }) =>
      Effect.gen(function* () {
        yield* sched.cancelPending({ workflowExecutionId: params.workflowExecutionId, reason: "callback_scheduled", actionTypes: ["RETRY_CALL"] });
        const existing = (yield* sched.listForWorkflow(params.workflowExecutionId)).find(
          (a) => a.actionType === "CALLBACK" && a.status === "PENDING",
        );
        const payload = { borrower_id: params.borrowerId, contact_point_id: params.contactPointId, channel: params.channel, reason: params.reason };
        if (existing) {
          yield* sched.setActionStatus(existing.id, "PENDING", payload, params.dueAt);
          return existing.id;
        }
        return yield* create({ workflowExecutionId: params.workflowExecutionId, actionType: "CALLBACK", dueAt: params.dueAt, payload });
      });

    const cancelPending = (workflowExecutionId: string, reason: string, actionTypes: ReadonlyArray<ScheduledActionType> | null) =>
      sched.cancelPending({ workflowExecutionId, reason, actionTypes });

    type Prepared =
      | { readonly kind: "settled"; readonly result: ProcessedAction }
      | { readonly kind: "dispatch"; readonly conversationId: string; readonly callAttemptId: string; readonly roomName: string; readonly metadata: string };

    const settled = (result: ProcessedAction) => ({ kind: "settled", result }) as const;

    const prepare = (action: ScheduledActionRow, now: DateTime.Utc): Effect.Effect<Prepared, unknown> =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (action.actionType === "HUMAN_FOLLOWUP") {
            yield* conv.setWorkflowStatus(action.workflowExecutionId, "RUNNING");
            yield* sched.setActionStatus(action.id, "DONE", { handled: "queued_for_human" });
            return settled({ actionId: action.id, actionType: action.actionType, status: "DONE", detail: { queue: action.payload["queue"] } });
          }
          const borrowerId = String(action.payload["borrower_id"] ?? "");
          const contactPointId = String(action.payload["contact_point_id"] ?? "");
          const channel = (String(action.payload["channel"] ?? "simulated") === "voice" ? "voice" : "simulated") as "voice" | "simulated";
          const attempts = Number(action.payload["retry_count"] ?? 0);

          // Checked before anything is written, or the row is left for the sweeper to book as an
          // orphan with nothing to serve it.
          if (channel === "voice" && !hasMediaPlane(cfg)) {
            yield* Effect.logWarning(`scheduled ${action.actionType} for borrower ${borrowerId} cannot place a voice call: no media plane configured`);
            yield* sched.setActionStatus(action.id, "FAILED", { reason: NO_MEDIA_PLANE });
            return settled({ actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: NO_MEDIA_PLANE } });
          }
          // Without an outbound trunk the worker hangs up, the call finalizes NO_ANSWER, and
          // NO_ANSWER schedules another retry, so this fails before a conversation row exists.
          if (channel === "voice" && !canDialOut(cfg)) {
            yield* Effect.logWarning(`scheduled ${action.actionType} for borrower ${borrowerId} cannot place a voice call: no SIP outbound trunk configured`);
            yield* sched.setActionStatus(action.id, "FAILED", { reason: NO_SIP_TRUNK });
            return settled({ actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: NO_SIP_TRUNK } });
          }

          const started = yield* workflow
            .startCall({
              borrowerId,
              contactPointId,
              channel,
              origin: "sip",
              workflowExecutionId: action.workflowExecutionId,
              workflowType: action.actionType === "CALLBACK" ? "CALLBACK_FOLLOWUP" : "PAYMENT_REMINDER",
              now,
            })
            .pipe(Effect.either);

          if (started._tag === "Right") {
            const conversationId = started.right.conversationId;
            if (channel === "voice") {
              return {
                kind: "dispatch",
                conversationId,
                callAttemptId: started.right.callAttemptId,
                roomName: roomNameFor(conversationId),
                metadata: JSON.stringify({
                  conversation_id: conversationId,
                  workflow_execution_id: started.right.workflowExecutionId,
                  call_attempt_id: started.right.callAttemptId,
                  borrower_id: borrowerId,
                  contact_point_id: contactPointId,
                  mode: "sip",
                  channel: "voice",
                  opening_text: started.right.openingText,
                }),
              } as const;
            }
            yield* sched.setActionStatus(action.id, "DONE", { conversation_id: conversationId });
            return settled({ actionId: action.id, actionType: action.actionType, status: "DONE", detail: { conversation_id: conversationId } });
          }
          const err = started.left;
          if (err instanceof PreCallRejected && err.failures.includes("TCPA_TIME_WINDOW") && attempts < 3) {
            const borrower = yield* crm.findBorrower(borrowerId);
            const tz = Option.isSome(borrower) ? borrower.value.timezone : "UTC";
            const next = DateTime.toDateUtc(nextLocalHour(now, tz, POLICY.contactWindowStartHour));
            yield* sched.setActionStatus(action.id, "PENDING", { retry_count: attempts + 1, last_error: "TCPA_TIME_WINDOW" }, next);
            return settled({ actionId: action.id, actionType: action.actionType, status: "RESCHEDULED", detail: { due_at: next.toISOString() } });
          }
          const reason = err instanceof PreCallRejected ? err.failures.join(",") : String(err);
          yield* sched.setActionStatus(action.id, "CANCELED", { canceled_reason: reason, retry_count: attempts + 1 });
          return settled({ actionId: action.id, actionType: action.actionType, status: "CANCELED", detail: { reason } });
        }),
      );

    /**
     * The dispatch runs between the two transactions, never inside one: it is an HTTP call to the
     * media plane, and holding the row-locked conversation across it serialises the whole loop
     * behind one slow dispatch. The cost of that gap is a conversation with no agent yet, which the
     * sweeper finalizes as NEVER_SERVED.
     */
    const processOne = (action: ScheduledActionRow, now: DateTime.Utc): Effect.Effect<ProcessedAction, unknown> =>
      Effect.gen(function* () {
        const prepared = yield* prepare(action, now);
        if (prepared.kind === "settled") return prepared.result;
        const dispatched = yield* dispatchAgent(cfg, { roomName: prepared.roomName, metadata: prepared.metadata, emptyTimeoutSeconds: 300 }).pipe(Effect.either);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (dispatched._tag === "Left") {
              // Closing the conversation from here would mean importing the orchestrator, which
              // imports this service, so it is left for the sweeper to finalize as NEVER_SERVED.
              yield* Effect.logWarning(`scheduled ${action.actionType} could not dispatch an agent: ${dispatched.left.detail}`);
              yield* sched.setActionStatus(action.id, "FAILED", { reason: "DISPATCH_FAILED", detail: dispatched.left.detail });
              return { actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: "DISPATCH_FAILED" } } satisfies ProcessedAction;
            }
            yield* conv.setAttemptProviderCallId(prepared.callAttemptId, `${prepared.roomName}/${dispatched.right}`);
            yield* sched.setActionStatus(action.id, "DONE", { conversation_id: prepared.conversationId });
            return { actionId: action.id, actionType: action.actionType, status: "DONE", detail: { conversation_id: prepared.conversationId } } satisfies ProcessedAction;
          }),
        );
      });

    const runOnce = (limit = 20, nowOverride?: DateTime.Utc) =>
      Effect.gen(function* () {
        const now = nowOverride ?? (yield* DateTime.now);
        const claimed = yield* sql.withTransaction(sched.claimDue({ now: DateTime.toDateUtc(now), limit }));
        const results: ProcessedAction[] = [];
        for (const action of claimed) {
          const r = yield* processOne(action, now).pipe(
            Effect.catchAll((e) =>
              sched
                .setActionStatus(action.id, "PENDING", { last_error: String(e) }, new Date(DateTime.toEpochMillis(now) + 5 * 60_000))
                .pipe(Effect.as({ actionId: action.id, actionType: action.actionType, status: "RESCHEDULED" as const, detail: { error: String(e) } })),
            ),
          );
          results.push(r);
        }
        return results;
      });

    return { create, createRetry, createHumanFollowup, scheduleCallback, cancelPending, processOne, runOnce } as const;
  }),
  dependencies: [SchedulingRepo.Default, ConversationRepo.Default, CrmRepo.Default, IdGen.Default, WorkflowService.Default],
}) {}
