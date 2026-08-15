/**
 * Scheduled actions (callbacks / retries / human follow-ups), the outbox, and worker heartbeats.
 * Claiming uses `FOR UPDATE SKIP LOCKED` so several workers can poll safely.
 */
import { Effect, Schema } from "effect";
import { SqlSchema } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { OutboxJobStatus, OutboxJobType, ScheduledActionStatus, ScheduledActionType } from "@feather-lite/domain";
import { HeartbeatRow, OutboxJobRow, ScheduledActionRow } from "../db/rows.js";

const SA_COLS = "id, workflow_execution_id, action_type, due_at, status, payload";
const OB_COLS = "id, conversation_id, job_type, status, payload, result, error, available_at, claimed_at, processed_at";

export class SchedulingRepo extends Effect.Service<SchedulingRepo>()("@feather-lite/SchedulingRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    /* ------------------------- scheduled actions ------------------------- */

    const insertScheduledAction = (row: {
      id: string;
      workflowExecutionId: string;
      actionType: ScheduledActionType;
      dueAt: Date;
      payload: Record<string, unknown>;
    }) =>
      sql`INSERT INTO scheduled_actions ${sql.insert({ ...row, status: "PENDING", payload: sql.json(row.payload) })}`.pipe(
        Effect.asVoid,
      );

    const findScheduledAction = SqlSchema.findOne({
      Request: Schema.String,
      Result: ScheduledActionRow,
      execute: (id) => sql`SELECT ${sql.unsafe(SA_COLS)} FROM scheduled_actions WHERE id = ${id}`,
    });

    const listForWorkflow = SqlSchema.findAll({
      Request: Schema.String,
      Result: ScheduledActionRow,
      execute: (workflowExecutionId) =>
        sql`SELECT ${sql.unsafe(SA_COLS)} FROM scheduled_actions WHERE workflow_execution_id = ${workflowExecutionId} ORDER BY due_at`,
    });

    /** Pending CALLBACK / RETRY_CALL actions across all workflows for a borrower (pre-call conflict check). */
    const countPendingConflicts = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.NumberFromString }),
      execute: (borrowerId) => sql`
        SELECT count(*)::text AS count FROM scheduled_actions a
        JOIN workflow_executions w ON w.id = a.workflow_execution_id
        WHERE w.borrower_id = ${borrowerId} AND a.status = 'PENDING' AND a.action_type <> 'HUMAN_FOLLOWUP'`,
    });

    const cancelPending = (params: {
      workflowExecutionId: string;
      reason: string;
      actionTypes: ReadonlyArray<ScheduledActionType> | null;
    }) => {
      const typeFilter =
        params.actionTypes === null ? sql`TRUE` : sql.in("action_type", [...params.actionTypes]);
      return sql`
        UPDATE scheduled_actions SET status = 'CANCELED', payload = payload || ${sql.json({ canceled_reason: params.reason })}
        WHERE workflow_execution_id = ${params.workflowExecutionId} AND status = 'PENDING' AND ${typeFilter}
        RETURNING id`.pipe(Effect.map((rows) => rows.length));
    };

    const claimDue = SqlSchema.findAll({
      Request: Schema.Struct({ now: Schema.DateFromSelf, limit: Schema.Number }),
      Result: ScheduledActionRow,
      execute: ({ now, limit }) => sql`
        WITH due AS (
          SELECT id FROM scheduled_actions WHERE status = 'PENDING' AND due_at <= ${now}
          ORDER BY due_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE scheduled_actions a SET status = 'CLAIMED' FROM due WHERE a.id = due.id
        RETURNING a.id, a.workflow_execution_id, a.action_type, a.due_at, a.status, a.payload`,
    });

    const setActionStatus = (id: string, status: ScheduledActionStatus, payloadPatch: Record<string, unknown> = {}, dueAt?: Date) =>
      (dueAt === undefined
        ? sql`UPDATE scheduled_actions SET status = ${status}, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
        : sql`UPDATE scheduled_actions SET status = ${status}, due_at = ${dueAt}, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
      ).pipe(Effect.asVoid);

    /* ------------------------------ outbox ------------------------------ */

    const existingJobTypes = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ jobType: Schema.String }),
      execute: (conversationId) => sql`SELECT DISTINCT job_type FROM outbox_jobs WHERE conversation_id = ${conversationId}`,
    });

    const insertOutboxJob = (row: { id: string; conversationId: string; jobType: OutboxJobType; availableAt: Date }) =>
      sql`INSERT INTO outbox_jobs ${sql.insert({
        ...row,
        status: "PENDING",
        payload: sql.json({ conversation_id: row.conversationId }),
        result: sql.json({}),
      })}`.pipe(Effect.asVoid);

    const claimDueJobs = SqlSchema.findAll({
      Request: Schema.Struct({ now: Schema.DateFromSelf, limit: Schema.Number }),
      Result: OutboxJobRow,
      execute: ({ now, limit }) => sql`
        WITH due AS (
          SELECT id FROM outbox_jobs WHERE status = 'PENDING' AND available_at <= ${now}
          ORDER BY available_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_jobs j SET status = 'CLAIMED', claimed_at = ${now}, updated_at = now() FROM due WHERE j.id = due.id
        RETURNING ${sql.unsafe(OB_COLS.split(", ").map((c) => `j.${c}`).join(", "))}`,
    });

    const listJobsForConversation = SqlSchema.findAll({
      Request: Schema.String,
      Result: OutboxJobRow,
      execute: (conversationId) => sql`SELECT ${sql.unsafe(OB_COLS)} FROM outbox_jobs WHERE conversation_id = ${conversationId} ORDER BY created_at`,
    });

    const finishJob = (params: { id: string; status: OutboxJobStatus; result: Record<string, unknown>; error: string | null; processedAt: Date | null; availableAt?: Date; payloadPatch?: Record<string, unknown> }) =>
      sql`UPDATE outbox_jobs SET status = ${params.status}, result = ${sql.json(params.result)}, error = ${params.error},
            processed_at = ${params.processedAt},
            available_at = COALESCE(${params.availableAt ?? null}, available_at),
            claimed_at = CASE WHEN ${params.status} = 'PENDING' THEN NULL ELSE claimed_at END,
            payload = payload || ${sql.json(params.payloadPatch ?? {})}, updated_at = now()
          WHERE id = ${params.id}`.pipe(Effect.asVoid);

    /* ---------------------------- heartbeats ---------------------------- */

    const upsertHeartbeat = (agentName: string, at: Date, meta: Record<string, unknown>) =>
      sql`INSERT INTO agent_heartbeats (agent_name, last_seen_at, meta) VALUES (${agentName}, ${at}, ${sql.json(meta)})
          ON CONFLICT (agent_name) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, meta = EXCLUDED.meta`.pipe(Effect.asVoid);

    const listHeartbeats = SqlSchema.findAll({
      Request: Schema.Void,
      Result: HeartbeatRow,
      execute: () => sql`SELECT agent_name, last_seen_at, meta FROM agent_heartbeats ORDER BY agent_name`,
    });

    return {
      insertScheduledAction,
      findScheduledAction,
      listForWorkflow,
      countPendingConflicts,
      cancelPending,
      claimDue,
      setActionStatus,
      existingJobTypes,
      insertOutboxJob,
      claimDueJobs,
      listJobsForConversation,
      finishJob,
      upsertHeartbeat,
      listHeartbeats,
    } as const;
  }),
}) {}
