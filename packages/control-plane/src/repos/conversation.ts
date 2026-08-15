/**
 * Conversation-side repository: workflow executions, call attempts, conversations,
 * the append-only event log, and turn idempotency records.
 *
 * Invariants enforced here (SPEC §6.3, §11.1):
 *   - `sequence_no` is strictly increasing per conversation; callers hold the conversation
 *     row lock (`lockConversation`) for the whole transaction that appends events.
 *   - one conversation per call attempt (unique constraint).
 */
import { Effect, Schema } from "effect";
import { SqlSchema } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type {
  CallAttemptStatus,
  ConversationEvent,
  ConversationState,
  EventRecord,
  Outcome,
  WorkflowExecutionStatus,
  WorkflowType,
} from "@feather-lite/domain";
import { decodeEventRecord } from "@feather-lite/domain";
import {
  CallAttemptRow,
  ConversationRow,
  EventRow,
  type PendingProposalJson,
  TurnRow,
  WorkflowExecutionRow,
} from "../db/rows.js";

const CONV_COLS =
  "id, call_attempt_id, borrower_id, agent_version_id, started_at, ended_at, final_outcome, final_outcome_metadata, channel, transfer_target, protected_context_unlocked, current_state, active_turn_id, pending_proposal, no_input_count";
const WF_COLS = "id, borrower_id, loan_id, workflow_type, status, current_attempt_no, scheduled_for";
const ATTEMPT_COLS = "id, workflow_execution_id, contact_point_id, direction, provider_call_id, attempt_status, started_at, ended_at";

export interface ConversationListItem {
  readonly id: string;
  readonly borrowerId: string;
  readonly borrowerName: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly finalOutcome: Outcome | null;
  readonly channel: string;
  readonly currentState: ConversationState;
}

export class ConversationRepo extends Effect.Service<ConversationRepo>()("@feather-lite/ConversationRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    /* ----------------------------- workflows ----------------------------- */

    const findOpenWorkflow = SqlSchema.findOne({
      Request: Schema.Struct({ borrowerId: Schema.String, loanId: Schema.String, workflowType: Schema.String }),
      Result: WorkflowExecutionRow,
      execute: ({ borrowerId, loanId, workflowType }) => sql`
        SELECT ${sql.unsafe(WF_COLS)} FROM workflow_executions
        WHERE borrower_id = ${borrowerId} AND loan_id = ${loanId} AND workflow_type = ${workflowType}
          AND status IN ('PENDING','RUNNING')
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    });

    const findWorkflow = SqlSchema.findOne({
      Request: Schema.String,
      Result: WorkflowExecutionRow,
      execute: (id) => sql`SELECT ${sql.unsafe(WF_COLS)} FROM workflow_executions WHERE id = ${id}`,
    });

    const lockWorkflow = SqlSchema.findOne({
      Request: Schema.String,
      Result: WorkflowExecutionRow,
      execute: (id) => sql`SELECT ${sql.unsafe(WF_COLS)} FROM workflow_executions WHERE id = ${id} FOR UPDATE`,
    });

    const insertWorkflow = (row: { id: string; borrowerId: string; loanId: string; workflowType: WorkflowType }) =>
      sql`INSERT INTO workflow_executions ${sql.insert({ ...row, status: "PENDING", currentAttemptNo: 0 })}`.pipe(Effect.asVoid);

    const incrementAttemptNo = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ currentAttemptNo: Schema.Number }),
      execute: (id) => sql`
        UPDATE workflow_executions SET current_attempt_no = current_attempt_no + 1, status = 'RUNNING', scheduled_for = NULL, updated_at = now()
        WHERE id = ${id} RETURNING current_attempt_no`,
    });

    const setWorkflowStatus = (id: string, status: WorkflowExecutionStatus) =>
      sql`UPDATE workflow_executions SET status = ${status}, updated_at = now() WHERE id = ${id}`.pipe(Effect.asVoid);

    /* ----------------------------- attempts ----------------------------- */

    const insertAttempt = (row: {
      id: string;
      workflowExecutionId: string;
      contactPointId: string;
      direction: string;
      startedAt: Date;
    }) => sql`INSERT INTO call_attempts ${sql.insert({ ...row, attemptStatus: "INITIATED" })}`.pipe(Effect.asVoid);

    const findAttempt = SqlSchema.findOne({
      Request: Schema.String,
      Result: CallAttemptRow,
      execute: (id) => sql`SELECT ${sql.unsafe(ATTEMPT_COLS)} FROM call_attempts WHERE id = ${id}`,
    });

    const setAttemptStatus = (id: string, status: CallAttemptStatus, endedAt: Date | null) =>
      sql`UPDATE call_attempts SET attempt_status = ${status}, ended_at = ${endedAt} WHERE id = ${id}`.pipe(Effect.asVoid);

    const setAttemptProviderCallId = (id: string, providerCallId: string) =>
      sql`UPDATE call_attempts SET provider_call_id = ${providerCallId} WHERE id = ${id}`.pipe(Effect.asVoid);

    const countRecentAttempts = SqlSchema.single({
      Request: Schema.Struct({ borrowerId: Schema.String, contactPointId: Schema.String, since: Schema.DateFromSelf }),
      Result: Schema.Struct({ count: Schema.NumberFromString }),
      execute: ({ borrowerId, contactPointId, since }) => sql`
        SELECT count(*)::text AS count FROM call_attempts a
        JOIN workflow_executions w ON w.id = a.workflow_execution_id
        WHERE w.borrower_id = ${borrowerId} AND a.contact_point_id = ${contactPointId} AND a.started_at >= ${since}`,
    });

    /* --------------------------- conversations --------------------------- */

    const insertConversation = (row: {
      id: string;
      callAttemptId: string;
      borrowerId: string;
      agentVersionId: string;
      startedAt: Date;
      channel: string;
    }) => sql`INSERT INTO conversations ${sql.insert({ ...row, finalOutcomeMetadata: sql.json({}), currentState: "GREETING" })}`.pipe(Effect.asVoid);

    const findConversation = SqlSchema.findOne({
      Request: Schema.String,
      Result: ConversationRow,
      execute: (id) => sql`SELECT ${sql.unsafe(CONV_COLS)} FROM conversations WHERE id = ${id}`,
    });

    /** Row lock; hold for the whole transaction that mutates state or appends events. */
    const lockConversation = SqlSchema.findOne({
      Request: Schema.String,
      Result: ConversationRow,
      execute: (id) => sql`SELECT ${sql.unsafe(CONV_COLS)} FROM conversations WHERE id = ${id} FOR UPDATE`,
    });

    const hasActiveConversation = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.NumberFromString }),
      execute: (borrowerId) => sql`
        SELECT count(*)::text AS count FROM conversations
        WHERE borrower_id = ${borrowerId} AND ended_at IS NULL AND final_outcome IS NULL`,
    });

    const listConversations = SqlSchema.findAll({
      Request: Schema.Struct({ limit: Schema.Number, offset: Schema.Number }),
      Result: Schema.Struct({
        id: Schema.String,
        borrowerId: Schema.String,
        borrowerName: Schema.String,
        startedAt: Schema.DateFromSelf,
        endedAt: Schema.NullOr(Schema.DateFromSelf),
        finalOutcome: Schema.NullOr(Schema.String),
        channel: Schema.String,
        currentState: Schema.String,
      }),
      execute: ({ limit, offset }) => sql`
        SELECT c.id, c.borrower_id, b.name AS borrower_name, c.started_at, c.ended_at, c.final_outcome, c.channel, c.current_state
        FROM conversations c JOIN borrowers b ON b.id = c.borrower_id
        ORDER BY c.started_at DESC LIMIT ${limit} OFFSET ${offset}`,
    });

    const countConversations = SqlSchema.single({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.NumberFromString }),
      execute: () => sql`SELECT count(*)::text AS count FROM conversations`,
    });

    /** Durable counts for the status page: outcomes and guardrail events across the whole ledger. */
    const outcomeCounts = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ outcome: Schema.String, count: Schema.NumberFromString }),
      execute: () => sql`SELECT coalesce(final_outcome, 'IN_PROGRESS') AS outcome, count(*)::text AS count FROM conversations GROUP BY 1 ORDER BY 1`,
    });
    const guardrailCounts = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ type: Schema.String, count: Schema.NumberFromString }),
      execute: () => sql`
        SELECT type, count(*)::text AS count FROM conversation_events
        WHERE type IN ('TOOL_REJECTED', 'TURN_DECISION_REJECTED', 'TURN_SUPERSEDED', 'TOOL_CALLED', 'STATE_TRANSITION', 'USER_TURN_FINAL')
        GROUP BY 1 ORDER BY 1`,
    });

    /** Prior completed conversations for cross-call memory (newest first). */
    const priorConversations = SqlSchema.findAll({
      Request: Schema.Struct({ borrowerId: Schema.String, excludeId: Schema.String, limit: Schema.Number }),
      Result: Schema.Struct({
        finalOutcome: Schema.NullOr(Schema.String),
        endedAt: Schema.NullOr(Schema.DateFromSelf),
        protectedContextUnlocked: Schema.Boolean,
        finalOutcomeMetadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
      execute: ({ borrowerId, excludeId, limit }) => sql`
        SELECT final_outcome, ended_at, protected_context_unlocked, final_outcome_metadata FROM conversations
        WHERE borrower_id = ${borrowerId} AND id <> ${excludeId} AND ended_at IS NOT NULL
        ORDER BY started_at DESC LIMIT ${limit}`,
    });

    /** Atomically claim the active turn slot. Returns false if another turn is active. */
    const claimTurn = (conversationId: string, turnId: string) =>
      sql`UPDATE conversations SET active_turn_id = ${turnId} WHERE id = ${conversationId} AND active_turn_id IS NULL RETURNING id`.pipe(
        Effect.map((rows) => rows.length === 1),
      );

    /** Force-take the slot (barge-in supersedes). Returns the previously active turn id, if any. */
    const takeOverTurn = (conversationId: string, turnId: string) =>
      sql<{ readonly previous: string | null }>`
        UPDATE conversations c SET active_turn_id = ${turnId}
        FROM (SELECT active_turn_id AS previous FROM conversations WHERE id = ${conversationId} FOR UPDATE) prev
        WHERE c.id = ${conversationId} RETURNING prev.previous`.pipe(Effect.map((rows) => rows[0]?.previous ?? null));

    const releaseTurn = (conversationId: string, turnId: string) =>
      sql`UPDATE conversations SET active_turn_id = NULL WHERE id = ${conversationId} AND active_turn_id = ${turnId}`.pipe(Effect.asVoid);

    const updateConversation = (
      id: string,
      patch: Partial<{
        currentState: ConversationState;
        protectedContextUnlocked: boolean;
        pendingProposal: PendingProposalJson | null;
        finalOutcome: Outcome;
        finalOutcomeMetadata: Record<string, unknown>;
        endedAt: Date;
        transferTarget: string;
        noInputCount: number;
      }>,
    ) => {
      const values: Record<string, unknown> = {};
      if (patch.currentState !== undefined) values["currentState"] = patch.currentState;
      if (patch.protectedContextUnlocked !== undefined) values["protectedContextUnlocked"] = patch.protectedContextUnlocked;
      if (patch.pendingProposal !== undefined) values["pendingProposal"] = patch.pendingProposal === null ? null : sql.json(patch.pendingProposal);
      if (patch.finalOutcome !== undefined) values["finalOutcome"] = patch.finalOutcome;
      if (patch.finalOutcomeMetadata !== undefined) values["finalOutcomeMetadata"] = sql.json(patch.finalOutcomeMetadata);
      if (patch.endedAt !== undefined) values["endedAt"] = patch.endedAt;
      if (patch.transferTarget !== undefined) values["transferTarget"] = patch.transferTarget;
      if (patch.noInputCount !== undefined) values["noInputCount"] = patch.noInputCount;
      if (Object.keys(values).length === 0) return Effect.void;
      return sql`UPDATE conversations SET ${sql.update(values)} WHERE id = ${id}`.pipe(Effect.asVoid);
    };

    /* ------------------------------ events ------------------------------ */

    const nextSequenceNo = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ next: Schema.NumberFromString }),
      execute: (conversationId) => sql`
        SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS next FROM conversation_events WHERE conversation_id = ${conversationId}`,
    });

    /**
     * Append one event. Caller must hold the conversation row lock (transaction) so the
     * MAX+1 sequence number is race-free. Returns the stored record.
     */
    const appendEvent = (params: { id: string; conversationId: string; event: ConversationEvent; createdAt: Date }) =>
      Effect.gen(function* () {
        const { next } = yield* nextSequenceNo(params.conversationId);
        yield* sql`INSERT INTO conversation_events ${sql.insert({
          id: params.id,
          conversationId: params.conversationId,
          sequenceNo: next,
          type: params.event.type,
          payload: sql.json(params.event.payload as Record<string, unknown>),
          createdAt: params.createdAt,
        })}`;
        const record: EventRecord = {
          sequence_no: next,
          created_at: params.createdAt.toISOString(),
          ...params.event,
        } as EventRecord;
        return record;
      });

    const listEventRows = SqlSchema.findAll({
      Request: Schema.String,
      Result: EventRow,
      execute: (conversationId) => sql`
        SELECT id, conversation_id, sequence_no::int AS sequence_no, type, payload, created_at FROM conversation_events
        WHERE conversation_id = ${conversationId} ORDER BY conversation_events.sequence_no ASC`,
    });

    /** Events decoded into the domain union. Rows that fail to decode are skipped (logged upstream). */
    const listEvents = (conversationId: string) =>
      listEventRows(conversationId).pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => {
            const decoded = decodeEventRecord({
              sequence_no: row.sequenceNo,
              created_at: row.createdAt.toISOString(),
              type: row.type,
              payload: row.payload,
            });
            return decoded._tag === "Right" ? [decoded.right] : [];
          }),
        ),
      );

    /* ------------------------------ turns ------------------------------ */

    const insertTurn = (row: { conversationId: string; turnId: string; userText: string; startedAt: Date }) =>
      sql`INSERT INTO conversation_turns ${sql.insert({ ...row, status: "RUNNING" })}`.pipe(Effect.asVoid);

    const findTurn = SqlSchema.findOne({
      Request: Schema.Struct({ conversationId: Schema.String, turnId: Schema.String }),
      Result: TurnRow,
      execute: ({ conversationId, turnId }) => sql`
        SELECT conversation_id, turn_id, status, user_text, started_at, finished_at, result FROM conversation_turns
        WHERE conversation_id = ${conversationId} AND turn_id = ${turnId}`,
    });

    const finishTurn = (params: {
      conversationId: string;
      turnId: string;
      status: "DONE" | "SUPERSEDED" | "FAILED";
      result: Record<string, unknown>;
      finishedAt: Date;
    }) =>
      sql`UPDATE conversation_turns SET status = ${params.status}, result = ${sql.json(params.result)}, finished_at = ${params.finishedAt}
          WHERE conversation_id = ${params.conversationId} AND turn_id = ${params.turnId}`.pipe(Effect.asVoid);

    return {
      findOpenWorkflow,
      findWorkflow,
      lockWorkflow,
      insertWorkflow,
      incrementAttemptNo,
      setWorkflowStatus,
      insertAttempt,
      findAttempt,
      setAttemptStatus,
      setAttemptProviderCallId,
      countRecentAttempts,
      insertConversation,
      findConversation,
      lockConversation,
      hasActiveConversation,
      listConversations,
      countConversations,
      outcomeCounts,
      guardrailCounts,
      priorConversations,
      claimTurn,
      takeOverTurn,
      releaseTurn,
      updateConversation,
      appendEvent,
      listEvents,
      insertTurn,
      findTurn,
      finishTurn,
    } as const;
  }),
}) {}
