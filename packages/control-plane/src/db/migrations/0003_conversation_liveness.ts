/**
 * Rows are updated, never deleted: staleness is decided by age, so a finished call's row is simply
 * old. A table rather than an in-memory map, which after a control-plane restart would be empty and
 * make the sweeper finalize every live call.
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
  yield* sql`CREATE INDEX ix_conversation_liveness_seen ON conversation_liveness (last_seen_at)`;
});
