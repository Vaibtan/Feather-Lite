/**
 * Scheduled actions (SPEC §14): callbacks, retries, human follow-ups; and the worker
 * that claims due actions and re-enters `startCall`. If a callback/retry hits the TCPA
 * window at its due time it is rescheduled to the next 08:00 local (plan rev.2 R13),
 * up to 3 times, then CANCELED with the reason recorded.
 */
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
import { NO_MEDIA_PLANE, dispatchAgent, hasMediaPlane, roomNameFor } from "./voiceDispatch.js";
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

    /** Upsert-style: one PENDING callback per workflow; retries are canceled by a callback. */
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

    /** Execute one claimed action in its own transaction. */
    const processOne = (action: ScheduledActionRow, now: DateTime.Utc): Effect.Effect<ProcessedAction, unknown> =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (action.actionType === "HUMAN_FOLLOWUP") {
            yield* conv.setWorkflowStatus(action.workflowExecutionId, "RUNNING");
            yield* sched.setActionStatus(action.id, "DONE", { handled: "queued_for_human" });
            return { actionId: action.id, actionType: action.actionType, status: "DONE", detail: { queue: action.payload["queue"] } } satisfies ProcessedAction;
          }
          const borrowerId = String(action.payload["borrower_id"] ?? "");
          const contactPointId = String(action.payload["contact_point_id"] ?? "");
          const channel = (String(action.payload["channel"] ?? "simulated") === "voice" ? "voice" : "simulated") as "voice" | "simulated";
          const attempts = Number(action.payload["retry_count"] ?? 0);

          /**
           * A voice re-dial goes through `VoiceSessions`, not `startCall` (O4).
           *
           * `startCall` opens a conversation and nothing else. For `channel: 'voice'` that produced
           * a call no agent was ever dispatched to: the room was never created, no worker claimed
           * it, and the sweeper later finalized it as an orphan on the long unconfirmed window.
           * Measured, unprompted: conversation `ae312a15…` from attempt 4 was swept 5 minutes 9
           * seconds after it was created, and dragged the fleet's `orphan_detect_ms` p95 from
           * 38 902 ms to 308 860 ms — a number describing a call that never had a worker to lose.
           *
           * `sip` because a scheduled re-dial is outbound: there is no browser tab waiting on the
           * other end of it.
           */
          // Checked before anything is written: a voice re-dial on a system with no media plane
          // must not leave a conversation row behind, because nothing will ever serve it and the
          // sweeper will later book it as an orphan.
          if (channel === "voice" && !hasMediaPlane(cfg)) {
            yield* Effect.logWarning(`scheduled ${action.actionType} for borrower ${borrowerId} cannot place a voice call: no media plane configured`);
            yield* sched.setActionStatus(action.id, "FAILED", { reason: NO_MEDIA_PLANE });
            return { actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: NO_MEDIA_PLANE } } satisfies ProcessedAction;
          }

          const started = yield* workflow
            .startCall({
              borrowerId,
              contactPointId,
              channel,
              workflowExecutionId: action.workflowExecutionId,
              workflowType: action.actionType === "CALLBACK" ? "CALLBACK_FOLLOWUP" : "PAYMENT_REMINDER",
              now,
            })
            .pipe(Effect.either);

          if (started._tag === "Right") {
            const conversationId = started.right.conversationId;
            /**
             * **Dispatch an agent to it (O4).** `startCall` opens a conversation and nothing else;
             * for `channel: 'voice'` that produced a call no worker was ever told about. The room
             * was never created, nobody claimed it, and the sweeper finalized it as an orphan on
             * the long unconfirmed window. Measured, unprompted: conversation `ae312a15…` from
             * attempt 4 was swept 5 minutes 9 seconds after creation and pulled the fleet's
             * `orphan_detect_ms` p95 from 38 902 ms to 308 860 ms — describing a call that never
             * had a worker to lose.
             */
            if (channel === "voice") {
              const roomName = roomNameFor(conversationId);
              const metadata = JSON.stringify({
                conversation_id: conversationId,
                workflow_execution_id: started.right.workflowExecutionId,
                call_attempt_id: started.right.callAttemptId,
                borrower_id: borrowerId,
                contact_point_id: contactPointId,
                // Outbound: a scheduled re-dial has no browser tab waiting on the other end.
                mode: "sip",
                channel: "voice",
                opening_text: started.right.openingText,
              });
              const dispatched = yield* dispatchAgent(cfg, { roomName, metadata, emptyTimeoutSeconds: 300 }).pipe(Effect.either);
              if (dispatched._tag === "Left") {
                // The media plane exists and did not answer. The conversation is left for the
                // sweeper, which now finalizes a call no worker ever claimed as NEVER_SERVED
                // rather than timing it as an orphan — closing it from here would mean importing
                // the orchestrator, and the orchestrator imports this service.
                yield* Effect.logWarning(`scheduled ${action.actionType} could not dispatch an agent: ${dispatched.left.detail}`);
                yield* sched.setActionStatus(action.id, "FAILED", { reason: "DISPATCH_FAILED", detail: dispatched.left.detail });
                return { actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: "DISPATCH_FAILED" } } satisfies ProcessedAction;
              }
              yield* conv.setAttemptProviderCallId(started.right.callAttemptId, `${roomName}/${dispatched.right}`);
            }
            yield* sched.setActionStatus(action.id, "DONE", { conversation_id: conversationId });
            return { actionId: action.id, actionType: action.actionType, status: "DONE", detail: { conversation_id: conversationId } } satisfies ProcessedAction;
          }
          const err = started.left;
          if (err instanceof PreCallRejected && err.failures.includes("TCPA_TIME_WINDOW") && attempts < 3) {
            const borrower = yield* crm.findBorrower(borrowerId);
            const tz = Option.isSome(borrower) ? borrower.value.timezone : "UTC";
            const next = DateTime.toDateUtc(nextLocalHour(now, tz, POLICY.contactWindowStartHour));
            yield* sched.setActionStatus(action.id, "PENDING", { retry_count: attempts + 1, last_error: "TCPA_TIME_WINDOW" }, next);
            return { actionId: action.id, actionType: action.actionType, status: "RESCHEDULED", detail: { due_at: next.toISOString() } } satisfies ProcessedAction;
          }
          const reason = err instanceof PreCallRejected ? err.failures.join(",") : String(err);
          yield* sched.setActionStatus(action.id, "CANCELED", { canceled_reason: reason, retry_count: attempts + 1 });
          return { actionId: action.id, actionType: action.actionType, status: "CANCELED", detail: { reason } } satisfies ProcessedAction;
        }),
      );

    /** One worker tick: claim due actions and process each. `nowOverride` is for tests/demo. */
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
