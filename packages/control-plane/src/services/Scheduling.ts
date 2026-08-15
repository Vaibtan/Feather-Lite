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
import { PreCallRejected } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";
import { WorkflowService } from "./Workflow.js";

export interface ProcessedAction {
  readonly actionId: string;
  readonly actionType: ScheduledActionType;
  readonly status: "DONE" | "RESCHEDULED" | "CANCELED";
  readonly detail: Record<string, unknown>;
}

export class SchedulingService extends Effect.Service<SchedulingService>()("@feather-lite/SchedulingService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sched = yield* SchedulingRepo;
    const conv = yield* ConversationRepo;
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
            yield* sched.setActionStatus(action.id, "DONE", { conversation_id: started.right.conversationId });
            return { actionId: action.id, actionType: action.actionType, status: "DONE", detail: { conversation_id: started.right.conversationId } } satisfies ProcessedAction;
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

    /** One worker tick: claim due actions and process each. */
    const runOnce = (limit = 20) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
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
