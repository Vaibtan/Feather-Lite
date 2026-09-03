import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0006 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX IF NOT EXISTS ix_outbox_jobs_conversation ON outbox_jobs (conversation_id, job_type)`;

  // Partial, and its predicate columns are deliberately ones the per-turn writes never touch: a HOT
  // update requires that no indexed or predicate column change.
  yield* sql`
    CREATE INDEX IF NOT EXISTS ix_conversations_open_voice ON conversations (channel, started_at)
    WHERE ended_at IS NULL AND final_outcome IS NULL`;

  // Not CONCURRENTLY, because this migrator runs each migration inside a transaction. Both are
  // `IF NOT EXISTS` so an operator who built them by hand beforehand does not hit 42P07 and take
  // every later migration down with it.
});
