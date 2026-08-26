/**
 * `conversation_liveness` — which conversations a voice worker is currently serving
 * (spec 2026-08-26, D6, the orphaned-call sweeper).
 *
 * The sweeper needs to answer "is anyone still working this call?", and the honest signal is worker
 * liveness, not event silence: silence is normal on a call (a 50 s read-back, a borrower thinking),
 * while a dead worker is not. The worker's existing 10 s heartbeat now carries the conversation ids
 * it is serving, and each one lands here.
 *
 * A table rather than an in-memory map, because the alternative fails catastrophically in exactly
 * the case that matters: after a control-plane restart an in-memory map is empty, every live call
 * looks abandoned, and the sweeper would finalize the entire fleet mid-conversation.
 *
 * Rows are updated, never deleted. Staleness is decided by age, so a finished call's row is simply
 * old, and one leftover row per conversation is a rounding error next to the ledger.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0003 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversation_liveness (
      conversation_id uuid PRIMARY KEY,
      last_seen_at timestamptz NOT NULL,
      agent_name text NOT NULL
    )`;
  /** The sweeper's only access path: everything last seen before a cutoff. */
  yield* sql`CREATE INDEX ix_conversation_liveness_seen ON conversation_liveness (last_seen_at)`;
});
