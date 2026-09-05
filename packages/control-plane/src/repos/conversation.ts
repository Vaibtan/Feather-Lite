/**
 * `sequence_no` is strictly increasing per conversation, which holds only because callers take the
 * conversation row lock for the whole transaction that appends events.
 */
import { Effect, Schema } from "effect";
import { SqlSchema, type Statement } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { silentPlayoutSql } from "./silentPlayout.js";
import type {
  CallAttemptStatus,
  ConversationEvent,
  ConversationState,
  EventRecord,
  Outcome,
  WorkflowExecutionStatus,
  WorkflowType,
} from "@feather-lite/domain";
import { decodeEventRecord, ORPHANED_REASON, READBACK_UNHEARD_DETAILS } from "@feather-lite/domain";
import {
  CallAttemptRow,
  ConversationContextRow,
  ConversationRow,
  EventRow,
  type PendingProposalJson,
  TurnRow,
  WorkflowExecutionRow,
} from "../db/rows.js";

const CONV_COLS =
  "id, call_attempt_id, borrower_id, agent_version_id, started_at, ended_at, final_outcome, final_outcome_metadata, channel, origin, harness, transfer_target, protected_context_unlocked, current_state, active_turn_id, pending_proposal, no_input_count";
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

    const insertAttempt = (row: {
      id: string;
      workflowExecutionId: string;
      contactPointId: string;
      direction: string;
      startedAt: Date;
    }) => sql`INSERT INTO call_attempts ${sql.insert({ ...row, attemptStatus: "INITIATED" })}`.pipe(Effect.asVoid);

    const contextForConversation = SqlSchema.findOne({
      Request: Schema.Struct({ borrowerId: Schema.String, callAttemptId: Schema.String }),
      Result: ConversationContextRow,
      execute: ({ borrowerId, callAttemptId }) => sql`
        SELECT
          b.name                    AS borrower_name,
          b.timezone                AS borrower_timezone,
          a.workflow_execution_id,
          a.contact_point_id,
          w.workflow_type,
          w.current_attempt_no,
          cp.timezone_override,
          l.id                      AS loan_id,
          l.balance_due,
          l.due_date::text          AS due_date,
          l.status                  AS loan_status,
          l.delinquency_days,
          l.last_promise_date::text AS last_promise_date
        FROM call_attempts a
        JOIN workflow_executions w ON w.id = a.workflow_execution_id
        JOIN borrowers b ON b.id = ${borrowerId}
        LEFT JOIN contact_points cp ON cp.id = a.contact_point_id
        LEFT JOIN LATERAL (
          SELECT id, balance_due, due_date, status, delinquency_days, last_promise_date
          FROM loans WHERE borrower_id = ${borrowerId}
          ORDER BY delinquency_days DESC, due_date ASC, id ASC LIMIT 1
        ) l ON true
        WHERE a.id = ${callAttemptId}`,
    });

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

    const insertConversation = (row: {
      id: string;
      callAttemptId: string;
      borrowerId: string;
      agentVersionId: string;
      startedAt: Date;
      channel: string;
      origin: string;
      harness: string | null;
      decider: string;
    }) => sql`INSERT INTO conversations ${sql.insert({ ...row, finalOutcomeMetadata: sql.json({}), currentState: "GREETING" })}`.pipe(Effect.asVoid);

    const findConversation = SqlSchema.findOne({
      Request: Schema.String,
      Result: ConversationRow,
      execute: (id) => sql`SELECT ${sql.unsafe(CONV_COLS)} FROM conversations WHERE id = ${id}`,
    });

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

    const { unheardPlayout, notSuperseded } = silentPlayoutSql(sql);
    const EMPTY_COUNTS = { turnsSuperseded: 0, noInputCloses: 0, deciderUnavailable: 0, ttsSilentPlayouts: 0, readbacksRepeatedUnheard: 0, callsOrphaned: 0 };
    const countReliability = (scope: Statement.Fragment) =>
      sql<{
        turnsSuperseded: string;
        noInputCloses: string;
        deciderUnavailable: string;
        ttsSilentPlayouts: string;
        readbacksRepeatedUnheard: string;
        callsOrphaned: string;
      }>`
        SELECT
          count(*) FILTER (WHERE type = 'TURN_SUPERSEDED')::text AS turns_superseded,
          count(*) FILTER (WHERE type = 'CALL_CONTROL' AND payload->>'action' = 'NO_INPUT_CLOSE')::text AS no_input_closes,
          count(*) FILTER (WHERE type = 'TURN_DECISION_REJECTED' AND payload->>'reason' = 'DECIDER_UNAVAILABLE')::text AS decider_unavailable,
          -- By turn, not by row: a turn whose synthesis died reports every one of its segments
          -- unheard, and the domain twin silentPlayoutTurnIds counts the turn once.
          count(DISTINCT conversation_events.payload->>'turn_id') FILTER (
            WHERE ${unheardPlayout("conversation_events")}
              AND ${notSuperseded("conversation_events.conversation_id", "conversation_events.payload->>'turn_id'")}
          )::text AS tts_silent_playouts,
          count(*) FILTER (WHERE type = 'TOOL_REJECTED' AND payload->>'name' = 'record_promise_to_pay'
                             AND payload->>'reason' = 'INVALID_ARGS' AND payload->>'detail' IN ${sql.in(READBACK_UNHEARD_DETAILS)})::text AS readbacks_repeated_unheard,
          count(*) FILTER (WHERE type = 'CALL_CONTROL' AND payload->>'action' = 'HANGUP' AND payload->>'reason' = ${ORPHANED_REASON})::text AS calls_orphaned
        FROM conversation_events
        WHERE ${scope}`.pipe(
        Effect.map((rows) => {
          const r = rows[0];
          const n = (v: string | undefined) => Number(v ?? 0);
          return {
            turnsSuperseded: n(r?.turnsSuperseded),
            noInputCloses: n(r?.noInputCloses),
            deciderUnavailable: n(r?.deciderUnavailable),
            ttsSilentPlayouts: n(r?.ttsSilentPlayouts),
            readbacksRepeatedUnheard: n(r?.readbacksRepeatedUnheard),
            callsOrphaned: n(r?.callsOrphaned),
          };
        }),
      );

    const reliabilityCountsFor = (conversationIds: ReadonlyArray<string>) =>
      conversationIds.length === 0 ? Effect.succeed(EMPTY_COUNTS) : countReliability(sql`conversation_id IN ${sql.in(conversationIds)}`);

    const reliabilityCounts = () => countReliability(sql`true`);

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

    const claimTurn = (conversationId: string, turnId: string) =>
      sql`UPDATE conversations SET active_turn_id = ${turnId} WHERE id = ${conversationId} AND active_turn_id IS NULL RETURNING id`.pipe(
        Effect.map((rows) => rows.length === 1),
      );

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

    // A `conversations.next_sequence_no` counter column was rejected: it would add a second write to
    // the hottest row in the schema on every event to remove a round trip this single statement
    // already removes.
    const insertEventRow = SqlSchema.single({
      Request: Schema.Struct({
        id: Schema.String,
        conversationId: Schema.String,
        type: Schema.String,
        payload: Schema.Any,
        createdAt: Schema.DateFromSelf,
      }),
      Result: Schema.Struct({ sequenceNo: Schema.NumberFromString }),
      execute: ({ id, conversationId, type, payload, createdAt }) => sql`
        INSERT INTO conversation_events (id, conversation_id, sequence_no, type, payload, created_at)
        SELECT ${id}, ${conversationId}, COALESCE(MAX(sequence_no), 0) + 1, ${type}, ${sql.json(payload as Record<string, unknown>)}, ${createdAt}
        FROM conversation_events WHERE conversation_id = ${conversationId}
        RETURNING sequence_no::text AS sequence_no`,
    });

    const appendEvent = (params: { id: string; conversationId: string; event: ConversationEvent; createdAt: Date }) =>
      Effect.gen(function* () {
        const { sequenceNo } = yield* insertEventRow({
          id: params.id,
          conversationId: params.conversationId,
          type: params.event.type,
          payload: params.event.payload,
          createdAt: params.createdAt,
        });
        const record: EventRecord = {
          sequence_no: sequenceNo,
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

    // No `FOR UPDATE` and no transaction: the playout is reported by a different process, and holding
    // the conversation row lock for the length of a spoken sentence is not something a claim
    // transaction may do.
    /**
     * By segment, not by turn: a turn that spoke twice has one non-interruptible read-back among its
     * segments, and only that segment's playout says the borrower heard it. The COALESCEs are the
     * compatibility rule `playoutMatchesSegment` states in the domain, which this SQL cannot share:
     * an `AGENT_TURN` with no `segments` is one segment named by the turn, and a playout with no
     * `segment_id` reports that turn's single segment.
     */
    const unreportedNonInterruptible = (conversationId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ segmentId: string | null; turnId: string | null; channel: string; createdAt: Date; ttsAudioMs: number | null }>`
          WITH segments AS (
            SELECT e.conversation_id                                              AS conversation_id,
                   e.sequence_no                                                  AS sequence_no,
                   e.created_at                                                   AS created_at,
                   e.payload->>'turn_id'                                          AS turn_id,
                   COALESCE(s.value->>'segment_id', e.payload->>'turn_id')        AS segment_id,
                   COALESCE(s.value->>'speak_mode', e.payload->>'speak_mode')     AS speak_mode
            FROM conversation_events e
            LEFT JOIN LATERAL jsonb_array_elements(e.payload->'segments') s
              ON jsonb_typeof(e.payload->'segments') = 'array'
            WHERE e.conversation_id = ${conversationId} AND e.type = 'AGENT_TURN'
          )
          SELECT g.segment_id                        AS segment_id,
                 g.turn_id                           AS turn_id,
                 c.channel                           AS channel,
                 g.created_at                        AS created_at,
                 (t.result->>'tts_audio_ms')::float8 AS tts_audio_ms
          FROM segments g
          JOIN conversations c ON c.id = g.conversation_id
          LEFT JOIN conversation_turns t
            ON t.conversation_id = g.conversation_id AND t.turn_id = g.turn_id
          WHERE g.speak_mode = 'non_interruptible'
            -- The opening is reported by the opening_played signal, never by an AGENT_TURN_PLAYOUT,
            -- so it is permanently unreported and would otherwise hold the first real turn of every
            -- voice call waiting for evidence that never arrives.
            AND g.turn_id IS DISTINCT FROM 'opening'
            AND g.segment_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_events p
              WHERE p.conversation_id = g.conversation_id
                AND p.type = 'AGENT_TURN_PLAYOUT'
                AND CASE WHEN p.payload ? 'segment_id'
                         THEN p.payload->>'segment_id' = g.segment_id
                         ELSE p.payload->>'turn_id' = g.turn_id END
            )
          ORDER BY g.sequence_no DESC
          LIMIT 1`.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined || row.segmentId === null || row.turnId === null) return null;
        return { segmentId: row.segmentId, turnId: row.turnId, channel: row.channel, startedAtMs: row.createdAt.getTime(), ttsAudioMs: row.ttsAudioMs };
      });

    const lastDisposition = (conversationId: string, excludingTurnId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ disposition: string | null }>`
          SELECT result->>'disposition' AS disposition
          FROM conversation_turns
          WHERE conversation_id = ${conversationId} AND turn_id <> ${excludingTurnId} AND result IS NOT NULL
          ORDER BY started_at DESC, turn_id DESC
          LIMIT 1`.pipe(Effect.orDie);
        return rows[0]?.disposition ?? null;
      });

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

    const turnLatencyFacts = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({
        turnId: Schema.String,
        eouDelayMs: Schema.NullOr(Schema.Number),
        transcriptionDelayMs: Schema.NullOr(Schema.Number),
        ttftMs: Schema.NullOr(Schema.Number),
        ttsTtfbMs: Schema.NullOr(Schema.Number),
      }),
      execute: (conversationId) => sql`
        SELECT turn_id,
               (result->>'eou_delay_ms')::float8           AS eou_delay_ms,
               (result->>'transcription_delay_ms')::float8 AS transcription_delay_ms,
               (result->>'ttftMs')::float8                 AS ttft_ms,
               (result->>'tts_ttfb_ms')::float8            AS tts_ttfb_ms
        FROM conversation_turns
        WHERE conversation_id = ${conversationId} AND result IS NOT NULL
        ORDER BY started_at ASC`,
    });

    const turnTtsFacts = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ turnId: Schema.String, ttsAudioMs: Schema.NullOr(Schema.Number), ttsChars: Schema.NullOr(Schema.Number) }),
      execute: (conversationId) => sql`
        SELECT turn_id,
               (result->>'tts_audio_ms')::float8 AS tts_audio_ms,
               (result->>'tts_chars')::float8    AS tts_chars
        FROM conversation_turns
        WHERE conversation_id = ${conversationId} AND result IS NOT NULL
        ORDER BY started_at ASC`,
    });

    const mergeTurnResult = (params: { conversationId: string; turnId: string; patch: Record<string, unknown> }) =>
      sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) || ${sql.json(params.patch)}
          WHERE conversation_id = ${params.conversationId} AND turn_id = ${params.turnId}`.pipe(Effect.asVoid);

    return {
      mergeTurnResult,
      turnTtsFacts,
      turnLatencyFacts,
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
      reliabilityCountsFor,
      findConversation,
      lockConversation,
      hasActiveConversation,
      listConversations,
      countConversations,
      outcomeCounts,
      guardrailCounts,
      reliabilityCounts,
      priorConversations,
      claimTurn,
      takeOverTurn,
      releaseTurn,
      updateConversation,
      appendEvent,
      unreportedNonInterruptible,
      lastDisposition,
      contextForConversation,
      listEvents,
      insertTurn,
      findTurn,
      finishTurn,
    } as const;
  }),
}) {}
