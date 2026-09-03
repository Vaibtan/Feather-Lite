import { Effect, Schema } from "effect";
import { SqlSchema } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { OutboxJobStatus, OutboxJobType, ScheduledActionStatus, ScheduledActionType } from "@feather-lite/domain";
import { HeartbeatRow, OutboxJobRow, ScheduledActionRow } from "../db/rows.js";

const SA_COLS = "id, workflow_execution_id, action_type, due_at, status, payload";
const OB_COLS = "id, conversation_id, job_type, status, payload, result, error, available_at, claimed_at, processed_at";

/**
 * Five minutes sits between two clocks: the longest a live claim legitimately lasts (a JUDGE job
 * waiting on a reasoning model is tens of seconds) and how long a borrower may be left behind a
 * stranded call. Anything from about two to fifteen minutes behaves identically.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

// A reclaim means a process died holding the row, so it costs the job an attempt; an ordinary claim
// from `PENDING` does not. A job reclaimed and then failing is charged twice, which is intended.
const bumpRetryOnReclaim = (table: string) =>
  `CASE WHEN due.prev_status = 'CLAIMED'
        THEN jsonb_set(${table}.payload, '{retry_count}', to_jsonb(COALESCE((${table}.payload->>'retry_count')::int, 0) + 1))
        ELSE ${table}.payload END`;

export class SchedulingRepo extends Effect.Service<SchedulingRepo>()("@feather-lite/SchedulingRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

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

    const countPendingConflicts = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.NumberFromString }),
      execute: (borrowerId) => sql`
        SELECT count(*)::text AS count FROM scheduled_actions a
        JOIN workflow_executions w ON w.id = a.workflow_execution_id
        WHERE w.borrower_id = ${borrowerId} AND a.status = 'PENDING' AND a.action_type = 'CALLBACK'`,
    });

    const cancelPendingRetriesForBorrower = (borrowerId: string, reason: string) =>
      sql`
        UPDATE scheduled_actions a SET status = 'CANCELED', payload = a.payload || ${sql.json({ canceled_reason: reason })}
        FROM workflow_executions w
        WHERE w.id = a.workflow_execution_id AND w.borrower_id = ${borrowerId} AND a.status = 'PENDING' AND a.action_type = 'RETRY_CALL'
        RETURNING a.id`.pipe(Effect.map((rows) => rows.length));

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
          SELECT id, status AS prev_status FROM scheduled_actions
          WHERE (status = 'PENDING' AND due_at <= ${now})
             OR (status = 'CLAIMED' AND claimed_at < ${new Date(now.getTime() - CLAIM_LEASE_MS)})
          ORDER BY due_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE scheduled_actions a
           SET status = 'CLAIMED', claimed_at = ${now}, payload = ${sql.unsafe(bumpRetryOnReclaim("a"))}
        FROM due WHERE a.id = due.id
        RETURNING a.id, a.workflow_execution_id, a.action_type, a.due_at, a.status, a.payload`,
    });

    // `claimed_at` must be cleared whenever the row goes back to `PENDING`; otherwise a rescheduled
    // action carries the dead claim's timestamp and the lease reads it as expired the moment it is due.
    const setActionStatus = (id: string, status: ScheduledActionStatus, payloadPatch: Record<string, unknown> = {}, dueAt?: Date) =>
      (dueAt === undefined
        ? sql`UPDATE scheduled_actions SET status = ${status}, claimed_at = CASE WHEN ${status} = 'PENDING' THEN NULL ELSE claimed_at END, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
        : sql`UPDATE scheduled_actions SET status = ${status}, due_at = ${dueAt}, claimed_at = CASE WHEN ${status} = 'PENDING' THEN NULL ELSE claimed_at END, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
      ).pipe(Effect.asVoid);

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
          SELECT id, status AS prev_status FROM outbox_jobs
          WHERE (status = 'PENDING' AND available_at <= ${now})
             OR (status = 'CLAIMED' AND claimed_at < ${new Date(now.getTime() - CLAIM_LEASE_MS)})
          ORDER BY available_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_jobs j
           SET status = 'CLAIMED', claimed_at = ${now}, payload = ${sql.unsafe(bumpRetryOnReclaim("j"))}, updated_at = now()
        FROM due WHERE j.id = due.id
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

    // `||` is jsonb concatenation with the right-hand side winning per key, so a beat carrying no
    // meta leaves the row's existing fields alone rather than blanking them.
    const upsertHeartbeat = (agentName: string, at: Date, meta: Record<string, unknown>) =>
      sql`INSERT INTO agent_heartbeats (agent_name, last_seen_at, meta) VALUES (${agentName}, ${at}, ${sql.json(meta)})
          ON CONFLICT (agent_name) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, meta = agent_heartbeats.meta || EXCLUDED.meta`.pipe(Effect.asVoid);

    const touchLiveness = (conversationIds: ReadonlyArray<string>, agentName: string, at: Date) =>
      conversationIds.length === 0
        ? Effect.void
        : Effect.forEach(
            conversationIds,
            (id) =>
              sql`INSERT INTO conversation_liveness (conversation_id, last_seen_at, agent_name) VALUES (${id}, ${at}, ${agentName})
                  ON CONFLICT (conversation_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, agent_name = EXCLUDED.agent_name`,
            { discard: true },
          );

    // `started_at < staleBefore` doubles as the grace period: a call that began seconds ago has not
    // had time to be heartbeated, and sweeping it would be a guaranteed false positive.
    const staleConversations = SqlSchema.findAll({
      Request: Schema.Struct({ staleBefore: Schema.DateFromSelf, limit: Schema.Number }),
      Result: Schema.Struct({
        id: Schema.String,
        startedAt: Schema.DateFromSelf,
        lastSeenAt: Schema.NullOr(Schema.DateFromSelf),
      }),
      execute: ({ staleBefore, limit }) => sql`
        SELECT c.id, c.started_at, l.last_seen_at
        FROM conversations c
        LEFT JOIN conversation_liveness l ON l.conversation_id = c.id
        WHERE c.ended_at IS NULL AND c.final_outcome IS NULL AND c.channel = 'voice'
          AND c.started_at < ${staleBefore}
          AND (l.last_seen_at IS NULL OR l.last_seen_at < ${staleBefore})
        ORDER BY c.started_at ASC LIMIT ${limit}`,
    });

    const listHeartbeats = SqlSchema.findAll({
      Request: Schema.Void,
      Result: HeartbeatRow,
      execute: () => sql`SELECT agent_name, last_seen_at, meta FROM agent_heartbeats
        WHERE last_seen_at > now() - interval '1 day' ORDER BY agent_name`,
    });

    return {
      insertScheduledAction,
      findScheduledAction,
      listForWorkflow,
      countPendingConflicts,
      cancelPendingRetriesForBorrower,
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
      touchLiveness,
      staleConversations,
    } as const;
  }),
}) {}
