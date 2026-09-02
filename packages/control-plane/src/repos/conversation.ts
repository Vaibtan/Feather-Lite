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

    /**
     * The five rows the prompt context needs, in one round trip (D5).
     *
     * `ContextBuilder` asked for borrower, attempt, workflow, contact point and loan one at a time,
     * and it does so inside T1 while the conversation row lock is held — five serial round trips on
     * one pooled connection, on the hot path of every turn. They are one join: the attempt names
     * the workflow and the contact point, and the borrower and the loan hang off the borrower id
     * the conversation row already carries.
     *
     * Written as a purpose-built query rather than a generic join helper because the *question* is
     * specific: this is "what does the prompt need to know", and the caller should not have to
     * reassemble it from five row types.
     *
     * `LEFT JOIN LATERAL` for the loan keeps `primaryLoanForBorrower`'s ordering
     * (`delinquency_days DESC, due_date ASC, id ASC`) exactly, and keeps the row when there is no
     * loan — a borrower with none has a public context and no protected one, which the gate
     * already understands.
     */
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

    /* --------------------------- conversations --------------------------- */

    const insertConversation = (row: {
      id: string;
      callAttemptId: string;
      borrowerId: string;
      agentVersionId: string;
      startedAt: Date;
      channel: string;
      /** How the voice leg was established, so a re-dial knows whether it can be placed (C4). */
      origin: string;
      /** Which harness placed the call; null means a real caller did (issue #1, D4). */
      harness: string | null;
      /** Which conversationalist will serve this call, for the SLO segment (O2). */
      decider: string;
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

    /**
     * The reliability counts D6 asks for, derived from the ledger rather than incremented in
     * process (spec 2026-08-26, D6).
     *
     * The first version of this incremented an in-memory counter as each event was written. That
     * was wrong twice over: the write happens inside the three-phase turn's transaction, so a
     * rollback after the append left the counter claiming an event that no longer exists; and it
     * put an interpretation of every event type inside a repository whose job is CRUD. Every one of
     * these is a fact about committed rows, so counting them as such is both simpler and exact —
     * and it survives a restart, which a process counter does not.
     *
     * `readbacks_repeated_unheard` keys off the rejection detail because `record_promise_to_pay` /
     * INVALID_ARGS covers two opposite situations: the fully-heard guard refusing a real proposal
     * the borrower did not hear, and the model asking to record a promise that was never proposed.
     * Only the first is a read-back repeated unheard.
     */
    /**
     * The same six counts over an explicit set of conversations (O10).
     *
     * The all-time variant below is what the Quality page was showing under a "last N calls"
     * header: a report whose funnel, SLO and promises all describe one window, with one card
     * silently describing every call ever made. It is also a full scan of `conversation_events`
     * with a correlated NOT EXISTS, which is why `/status` costs ~0.29 s on a 14 000-conversation
     * database regardless of what else is optimised.
     *
     * Same predicates, same SQL twins of the domain's rules — only the scope differs.
     */
    const reliabilityCountsFor = (conversationIds: ReadonlyArray<string>) =>
      conversationIds.length === 0
        ? Effect.succeed({ turnsSuperseded: 0, noInputCloses: 0, deciderUnavailable: 0, ttsSilentPlayouts: 0, readbacksRepeatedUnheard: 0, callsOrphaned: 0 })
        : sql<{
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
          -- The SQL twin of the domain's silentPlayoutTurnIds, and the third copy of it. The NOT
          -- EXISTS is load-bearing: a turn the borrower superseded before the agent replied reports
          -- the same shape and is not a TTS failure. **Change this, change the all-time query below
          -- and the domain predicate.**
          count(*) FILTER (
            WHERE type = 'AGENT_TURN_PLAYOUT' AND payload->>'interrupted' = 'true' AND payload->>'heard_text' = ''
              AND NOT EXISTS (
                SELECT 1 FROM conversation_events s
                WHERE s.conversation_id = conversation_events.conversation_id
                  AND s.type = 'TURN_SUPERSEDED' AND s.payload->>'turn_id' = conversation_events.payload->>'turn_id'
              )
          )::text AS tts_silent_playouts,
          count(*) FILTER (WHERE type = 'TOOL_REJECTED' AND payload->>'name' = 'record_promise_to_pay'
                             AND payload->>'reason' = 'INVALID_ARGS' AND payload->>'detail' IN ${sql.in(READBACK_UNHEARD_DETAILS)})::text AS readbacks_repeated_unheard,
          count(*) FILTER (WHERE type = 'CALL_CONTROL' AND payload->>'action' = 'HANGUP' AND payload->>'reason' = ${ORPHANED_REASON})::text AS calls_orphaned
        FROM conversation_events
        WHERE conversation_id IN ${sql.in(conversationIds)}`.pipe(
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

    const reliabilityCounts = SqlSchema.single({
      Request: Schema.Void,
      Result: Schema.Struct({
        turnsSuperseded: Schema.NumberFromString,
        noInputCloses: Schema.NumberFromString,
        deciderUnavailable: Schema.NumberFromString,
        ttsSilentPlayouts: Schema.NumberFromString,
        readbacksRepeatedUnheard: Schema.NumberFromString,
        callsOrphaned: Schema.NumberFromString,
      }),
      execute: () => sql`
        SELECT
          count(*) FILTER (WHERE type = 'TURN_SUPERSEDED')::text AS turns_superseded,
          count(*) FILTER (WHERE type = 'CALL_CONTROL' AND payload->>'action' = 'NO_INPUT_CLOSE')::text AS no_input_closes,
          count(*) FILTER (WHERE type = 'TURN_DECISION_REJECTED' AND payload->>'reason' = 'DECIDER_UNAVAILABLE')::text AS decider_unavailable,
          -- The SQL twin of the domain's silentPlayoutTurnIds. The NOT EXISTS is load-bearing: a
          -- turn the borrower superseded before the agent replied reports the same shape and is not
          -- a TTS failure. Change one, change both.
          count(*) FILTER (
            WHERE type = 'AGENT_TURN_PLAYOUT' AND payload->>'interrupted' = 'true' AND payload->>'heard_text' = ''
              AND NOT EXISTS (
                SELECT 1 FROM conversation_events s
                WHERE s.conversation_id = conversation_events.conversation_id
                  AND s.type = 'TURN_SUPERSEDED' AND s.payload->>'turn_id' = conversation_events.payload->>'turn_id'
              )
          )::text AS tts_silent_playouts,
          count(*) FILTER (WHERE type = 'TOOL_REJECTED' AND payload->>'name' = 'record_promise_to_pay'
                             AND payload->>'reason' = 'INVALID_ARGS' AND payload->>'detail' IN ${sql.in(READBACK_UNHEARD_DETAILS)})::text AS readbacks_repeated_unheard,
          count(*) FILTER (WHERE type = 'CALL_CONTROL' AND payload->>'action' = 'HANGUP' AND payload->>'reason' = ${ORPHANED_REASON})::text AS calls_orphaned
        FROM conversation_events`,
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

    /**
     * Number the row and write it in **one** statement.
     *
     * It used to be two: `SELECT COALESCE(MAX(sequence_no),0)+1` and then an `INSERT` with the
     * answer. Together they were a sixth of every statement this system executes — 2 200 calls each
     * over a C=100 run, and a terminal turn writes eight events, so sixteen round trips inside the
     * conversation row lock for what is one write.
     *
     * **What was actually costing anything.** `pg_stat_statements` put the aggregate at 0.045 ms a
     * call: it is an index-only `MAX` over `(conversation_id, sequence_no)`, and 2 200 of them are
     * 99 ms of server time in a run that spends 1 450. The cost was never the aggregate — it was
     * the round trip, the event-loop turn, and the pool checkout, all held under the row lock.
     *
     * **Which is why `conversations.next_sequence_no` is not built.** D5b offered it as the
     * alternative and told the implementer to choose on the numbers: a counter column would save
     * those 99 ms and add a second write to the hottest row in the schema on every event, to remove
     * a round trip this already removes. The spec says do not ship both; this is the one the
     * measurement argues for.
     *
     * The safety property is unchanged. The caller still holds the conversation row lock, so the
     * `MAX` cannot race, and `UNIQUE (conversation_id, sequence_no)` is still the backstop if a
     * caller ever forgets.
     */
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

    /**
     * Append one event. Caller must hold the conversation row lock (transaction) so the
     * MAX+1 sequence number is race-free. Returns the stored record.
     */
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

    /** Events decoded into the domain union. Rows that fail to decode are skipped (logged upstream). */
    /**
     * The non-interruptible segment this conversation is still playing, if any (issue #1 D1, F2).
     *
     * An `AGENT_TURN` with `speak_mode: 'non_interruptible'` and **no** `AGENT_TURN_PLAYOUT` behind
     * it: the agent was told to say something the borrower may not talk over, and the worker has not
     * yet reported that it finished. That is the window in which a barge-in produces the repeated
     * read-back — the borrower's "yes" commits a turn, the fully-heard guard refuses it because the
     * read-back was not heard in full, and eight seconds play again.
     *
     * **No `FOR UPDATE`, and no transaction.** The thing being waited for is reported by a different
     * process, so the ledger is the only place every replica can observe it; and holding a row lock
     * for the length of a spoken sentence is not something a claim transaction may do. This is why
     * `held` is a phase before T1 rather than a step inside it.
     *
     * `ttsAudioMs` is usually null here: it reaches `conversation_turns.result` on the later
     * `turn_metrics` signal, which the worker sends *after* the segment finishes. `holdPolicy` has a
     * bounded default for exactly that.
     */
    const unreportedNonInterruptible = (conversationId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ turnId: string | null; channel: string; createdAt: Date; ttsAudioMs: number | null }>`
          SELECT e.payload->>'turn_id'              AS turn_id,
                 c.channel                          AS channel,
                 e.created_at                       AS created_at,
                 (t.result->>'tts_audio_ms')::float8 AS tts_audio_ms
          FROM conversation_events e
          JOIN conversations c ON c.id = e.conversation_id
          LEFT JOIN conversation_turns t
            ON t.conversation_id = e.conversation_id AND t.turn_id = e.payload->>'turn_id'
          WHERE e.conversation_id = ${conversationId}
            AND e.type = 'AGENT_TURN'
            AND e.payload->>'speak_mode' = 'non_interruptible'
            -- The opening is reported by the opening_played signal, never by an AGENT_TURN_PLAYOUT,
            -- so it is permanently unreported and would hold the first real turn of every voice call
            -- for evidence that never arrives. Found by running it: a live call took heldMs 4257 on
            -- turn one, superseded the borrower payment offer, and ended NO_ANSWER with no promise.
            AND e.payload->>'turn_id' IS DISTINCT FROM 'opening'
            AND NOT EXISTS (
              SELECT 1 FROM conversation_events p
              WHERE p.conversation_id = e.conversation_id
                AND p.type = 'AGENT_TURN_PLAYOUT'
                AND p.payload->>'turn_id' = e.payload->>'turn_id'
            )
          ORDER BY e.sequence_no DESC
          LIMIT 1`.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined || row.turnId === null) return null;
        return { turnId: row.turnId, channel: row.channel, startedAtMs: row.createdAt.getTime(), ttsAudioMs: row.ttsAudioMs };
      });

    /**
     * What the control plane did about the previous turn (issue #1, D1).
     *
     * Read from `conversation_turns.result`, which is where `TurnResult` already lands — the ledger
     * is the truth about the call (Q4), and a second consecutive `wait` has to be recognised from
     * something durable rather than from process memory a replica would not share.
     */
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

    /**
     * The TTS shape the voice worker reported per turn (D5). Read back post-call by the EVALUATION
     * job, which otherwise only sees events — these numbers arrive on the `turn_metrics` signal and
     * live in the turn row, not in the ledger, because they are telemetry rather than something
     * that happened on the call.
     */
    /**
     * The four latency components per turn, for the per-call SLO verdict the EVALUATION job writes
     * (O6). Separate from `turnTtsFacts` because they answer different questions and this one runs
     * post-call, once, rather than on every page load.
     */
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

    /**
     * Merge extra keys into a finished turn's `result` without disturbing what is already there.
     * Used for the voice worker's latency numbers, which arrive after the turn has been written.
     * `||` is jsonb concatenation, so this is a single statement and needs no read-modify-write.
     */
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
