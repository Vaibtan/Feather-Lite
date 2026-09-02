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

    /**
     * What the first transaction concluded: either the action is settled, or a room has to be
     * dispatched to — which is an HTTP call to the media plane and must not happen under a lock.
     */
    type Prepared =
      | { readonly kind: "settled"; readonly result: ProcessedAction }
      | { readonly kind: "dispatch"; readonly conversationId: string; readonly callAttemptId: string; readonly roomName: string; readonly metadata: string };

    const settled = (result: ProcessedAction) => ({ kind: "settled", result }) as const;

    /** Everything about one claimed action that is only Postgres. Commits before anything is dialled. */
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
           * So a voice re-dial must both open the conversation *and* dispatch an agent to the room,
           * which is why this function ends by handing the dispatch back rather than by finishing.
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
            return settled({ actionId: action.id, actionType: action.actionType, status: "FAILED", detail: { reason: NO_MEDIA_PLANE } });
          }
          /**
           * And separately: is there anything to dial *through* (C4)?
           *
           * The dispatch below asks for `mode: "sip"`, and SIP needs an outbound trunk that only
           * LiveKit Cloud provides here. The control plane could not see that — the trunk id was
           * worker-side env — so it scheduled the call anyway, the worker hung up
           * `sip_not_configured`, the call finalized `NO_ANSWER`, and `NO_ANSWER` scheduled another
           * retry. Each lap cost a room, a dispatch and a worker job slot counted against
           * `WORKER_MAX_JOBS`, which is capacity a fleet run on the same box is measuring.
           *
           * Failed here, before `startCall`, for the same reason as the check above: no conversation
           * row means nothing for the sweeper to book as an orphan later.
           */
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
              workflowExecutionId: action.workflowExecutionId,
              workflowType: action.actionType === "CALLBACK" ? "CALLBACK_FOLLOWUP" : "PAYMENT_REMINDER",
              now,
            })
            .pipe(Effect.either);

          if (started._tag === "Right") {
            const conversationId = started.right.conversationId;
            if (channel === "voice") {
              // A voice call still needs an agent dispatched to it (O4, above) — but that is an
              // HTTP call, so it is handed back to `processOne`, which dials with no transaction
              // open and records the answer in a second, short one.
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
                  // Outbound: a scheduled re-dial has no browser tab waiting on the other end.
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
     * Execute one claimed action: prepare, dispatch, record.
     *
     * **The dispatch is no longer inside a transaction** (review #11). `dispatchAgent` is an HTTP
     * call to LiveKit, and it was made after `startCall` had written and row-locked the
     * conversation - the pattern ADR 0003 forbids, on the loop that also serves callbacks. A slow
     * media plane held a Postgres transaction and the conversation row for the length of an HTTP
     * timeout, and twenty such actions serialised behind it.
     *
     * The window between the two transactions is a conversation that exists with no agent
     * dispatched to it, which the sweeper already finalizes as `NEVER_SERVED` - a call that never
     * had a worker, distinct from one that lost hers (O4). The action row is left `CLAIMED`, which
     * is not new: `claimDue` commits the claim in its own transaction before this is called, so a
     * crash here has always left the action claimed.
     *
     * **What is new, and bounded:** if the *second* transaction itself fails - not a refused
     * dispatch, which is caught, but the recording of it - `runOnce` reschedules the action to
     * `PENDING` with one conversation already committed. The next tick's `startCall` then fails
     * pre-call with `ACTIVE_CONVERSATION` (that conversation is still open), which is not the TCPA
     * branch, so the action is `CANCELED` rather than re-dialled until the sweeper clears the
     * conversation. One leaked conversation per crash, not per retry, and visible as a
     * `NEVER_SERVED` finalization rather than as silence.
     */
    const processOne = (action: ScheduledActionRow, now: DateTime.Utc): Effect.Effect<ProcessedAction, unknown> =>
      Effect.gen(function* () {
        const prepared = yield* prepare(action, now);
        if (prepared.kind === "settled") return prepared.result;
        const dispatched = yield* dispatchAgent(cfg, { roomName: prepared.roomName, metadata: prepared.metadata, emptyTimeoutSeconds: 300 }).pipe(Effect.either);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (dispatched._tag === "Left") {
              // The media plane exists and did not answer. The conversation is left for the
              // sweeper, which finalizes a call no worker ever claimed as NEVER_SERVED rather than
              // timing it as an orphan - closing it from here would mean importing the
              // orchestrator, and the orchestrator imports this service.
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
