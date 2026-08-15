/**
 * Initial schema — SPEC §6 tables, indexes and constraints, plus the v2 additions:
 *   conversations.current_state / active_turn_id / pending_proposal / no_input_count (hot state,
 *   always derivable from events; kept for CAS + fast reads), conversation_turns (turn idempotency),
 *   agent_heartbeats (worker liveness).
 * Byte-compatible with the Python reference where the tables overlap.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0001 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE borrowers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      preferred_language text NOT NULL DEFAULT 'en',
      timezone text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX ix_borrowers_status ON borrowers (status)`;

  yield* sql`
    CREATE TABLE contact_points (
      id uuid PRIMARY KEY,
      type text NOT NULL DEFAULT 'PHONE',
      value text NOT NULL UNIQUE,
      is_valid boolean NOT NULL DEFAULT true,
      consent_status text NOT NULL DEFAULT 'UNKNOWN',
      timezone_override text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  yield* sql`
    CREATE TABLE borrower_contact_points (
      borrower_id uuid NOT NULL REFERENCES borrowers(id),
      contact_point_id uuid NOT NULL REFERENCES contact_points(id),
      priority integer NOT NULL DEFAULT 1,
      relationship text NOT NULL DEFAULT 'PRIMARY',
      PRIMARY KEY (borrower_id, contact_point_id)
    )`;
  yield* sql`CREATE INDEX ix_borrower_contact_points_priority ON borrower_contact_points (borrower_id, priority)`;

  yield* sql`
    CREATE TABLE loans (
      id uuid PRIMARY KEY,
      borrower_id uuid NOT NULL REFERENCES borrowers(id),
      principal numeric(12,2) NOT NULL,
      balance_due numeric(12,2) NOT NULL,
      due_date date NOT NULL,
      status text NOT NULL,
      delinquency_days integer NOT NULL DEFAULT 0,
      last_promise_date date NULL
    )`;
  yield* sql`CREATE INDEX ix_loans_borrower ON loans (borrower_id)`;

  yield* sql`
    CREATE TABLE agent_versions (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      prompt_hash text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;

  yield* sql`
    CREATE TABLE workflow_executions (
      id uuid PRIMARY KEY,
      borrower_id uuid NOT NULL REFERENCES borrowers(id),
      loan_id uuid NOT NULL REFERENCES loans(id),
      workflow_type text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      current_attempt_no integer NOT NULL DEFAULT 0,
      scheduled_for timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX ix_workflow_executions_borrower_status ON workflow_executions (borrower_id, status)`;

  yield* sql`
    CREATE TABLE call_attempts (
      id uuid PRIMARY KEY,
      workflow_execution_id uuid NOT NULL REFERENCES workflow_executions(id),
      contact_point_id uuid NOT NULL REFERENCES contact_points(id),
      direction text NOT NULL,
      provider_call_id text NULL,
      attempt_status text NOT NULL DEFAULT 'INITIATED',
      started_at timestamptz NOT NULL,
      ended_at timestamptz NULL
    )`;
  yield* sql`CREATE INDEX ix_call_attempts_workflow_started ON call_attempts (workflow_execution_id, started_at DESC)`;
  yield* sql`CREATE INDEX ix_call_attempts_contact_started ON call_attempts (contact_point_id, started_at DESC)`;

  yield* sql`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      call_attempt_id uuid NOT NULL UNIQUE REFERENCES call_attempts(id),
      borrower_id uuid NOT NULL REFERENCES borrowers(id),
      agent_version_id uuid NOT NULL REFERENCES agent_versions(id),
      started_at timestamptz NOT NULL,
      ended_at timestamptz NULL,
      final_outcome text NULL,
      final_outcome_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      channel text NOT NULL,
      transfer_target text NULL,
      protected_context_unlocked boolean NOT NULL DEFAULT false,
      current_state text NOT NULL DEFAULT 'GREETING',
      active_turn_id text NULL,
      pending_proposal jsonb NULL,
      no_input_count integer NOT NULL DEFAULT 0
    )`;
  yield* sql`CREATE INDEX ix_conversations_borrower_started ON conversations (borrower_id, started_at DESC)`;
  yield* sql`CREATE INDEX ix_conversations_started ON conversations (started_at DESC)`;

  yield* sql`
    CREATE TABLE conversation_events (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      sequence_no bigint NOT NULL,
      type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL,
      UNIQUE (conversation_id, sequence_no)
    )`;

  yield* sql`
    CREATE TABLE conversation_turns (
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      turn_id text NOT NULL,
      status text NOT NULL,
      user_text text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NULL,
      result jsonb NULL,
      PRIMARY KEY (conversation_id, turn_id)
    )`;

  yield* sql`
    CREATE TABLE scheduled_actions (
      id uuid PRIMARY KEY,
      workflow_execution_id uuid NOT NULL REFERENCES workflow_executions(id),
      action_type text NOT NULL,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX ix_scheduled_actions_workflow ON scheduled_actions (workflow_execution_id, status, due_at)`;
  yield* sql`CREATE INDEX ix_scheduled_actions_due ON scheduled_actions (status, due_at)`;

  yield* sql`
    CREATE TABLE outbox_jobs (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      job_type text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      result jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text NULL,
      available_at timestamptz NOT NULL,
      claimed_at timestamptz NULL,
      processed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX ix_outbox_jobs_status_available ON outbox_jobs (status, available_at)`;

  yield* sql`
    CREATE TABLE agent_heartbeats (
      agent_name text PRIMARY KEY,
      last_seen_at timestamptz NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )`;
});
