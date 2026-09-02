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

/**
 * How long a claim is good for before another process may take the row (C3).
 *
 * A claim used to be permanent: `CLAIMED` was written by both claim statements and read by nothing,
 * so a process killed between claiming and finishing stranded its rows for good — no SUMMARY, so
 * the borrower's next call loses its `wrap_up`; no EVALUATION and no judge, so the call never
 * reaches the quality page; a callback that simply never happens. Nothing raised, because a stuck
 * row and a row in flight are the same row.
 *
 * Five minutes is chosen from the two clocks either side of it. The floor is the longest a live
 * claim legitimately lasts: a JUDGE job waits on a reasoning model, which is tens of seconds, and
 * `Effect.forEach` runs a batch four at a time — so a minute is plausible and five is not. The
 * ceiling is how long a borrower can be left behind a stranded call, and five minutes is well
 * inside the sweeper's own patience. Between them the value is not delicate: anything from about
 * two to fifteen minutes behaves identically, which is why this is a constant with an argument
 * rather than a knob with a default nobody has tuned.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * `retry_count + 1`, but only for a row that was already `CLAIMED` — a reclaim means a process died
 * holding it, and that is worth counting. A row claimed from `PENDING` keeps the count it had, so
 * an ordinary claim costs a job nothing.
 *
 * A job that is reclaimed and *then* fails is charged twice, once here and once by the failure path
 * in `Outbox.runOnce`, and that is the intended reading rather than a leak: the two are different
 * events — a process that died holding the row, and work that ran and raised — and a job that has
 * suffered both has had two bad attempts out of its budget of three. `claimLease.test.ts` pins it.
 */
const bumpRetryOnReclaim = (table: string) =>
  `CASE WHEN due.prev_status = 'CLAIMED'
        THEN jsonb_set(${table}.payload, '{retry_count}', to_jsonb(COALESCE((${table}.payload->>'retry_count')::int, 0) + 1))
        ELSE ${table}.payload END`;

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

    /**
     * Pending CALLBACKs across all workflows for a borrower (pre-call conflict check): a borrower who
     * asked to be called at a specific time must not be dialed earlier. System retries do not block
     * (a manual start supersedes them, see `cancelPendingRetriesForBorrower`).
     */
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

    /**
     * `claimed_at` is cleared whenever the row goes back to `PENDING`, the same rule `finishJob`
     * has always applied to the outbox. Without it a rescheduled action would carry the dead
     * claim's timestamp, and the lease would read it as already expired the moment it came due.
     */
    const setActionStatus = (id: string, status: ScheduledActionStatus, payloadPatch: Record<string, unknown> = {}, dueAt?: Date) =>
      (dueAt === undefined
        ? sql`UPDATE scheduled_actions SET status = ${status}, claimed_at = CASE WHEN ${status} = 'PENDING' THEN NULL ELSE claimed_at END, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
        : sql`UPDATE scheduled_actions SET status = ${status}, due_at = ${dueAt}, claimed_at = CASE WHEN ${status} = 'PENDING' THEN NULL ELSE claimed_at END, payload = payload || ${sql.json(payloadPatch)} WHERE id = ${id}`
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

    /* ---------------------------- heartbeats ---------------------------- */

    /**
     * Several processes share one agent name — the main worker and every job process it forks — and
     * they have different things to say. The main worker reports its mode, its load and how many
     * calls it is carrying; a job process reports only that its call is still alive, and used to
     * blank all of that for the duration of the call by beating with its own small meta.
     *
     * `||` is jsonb concatenation, right-hand side winning per key: a beat with no meta leaves the
     * row's fields exactly as they were, and a beat with fields updates those and only those.
     */
    const upsertHeartbeat = (agentName: string, at: Date, meta: Record<string, unknown>) =>
      sql`INSERT INTO agent_heartbeats (agent_name, last_seen_at, meta) VALUES (${agentName}, ${at}, ${sql.json(meta)})
          ON CONFLICT (agent_name) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, meta = agent_heartbeats.meta || EXCLUDED.meta`.pipe(Effect.asVoid);

    /**
     * Record that a worker is still serving these conversations, as of `at`. Upsert-only: a row is
     * never deleted, because staleness is decided by age and a finished call's row is simply old.
     */
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

    /**
     * Voice conversations with no final outcome that no worker has claimed recently.
     *
     * `started_at < staleBefore` is the grace period as well as the staleness bound: a call that
     * began two seconds ago has not had time to be heartbeated, and sweeping it would be a
     * guaranteed false positive. Simulated conversations are excluded — they have no worker to
     * lose, and an abandoned console simulation is a different (much longer) rule.
     */
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
      execute: () => sql`SELECT agent_name, last_seen_at, meta FROM agent_heartbeats ORDER BY agent_name`,
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
