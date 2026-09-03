import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0005 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A failed statement poisons the enclosing transaction (25P02), so a nested `withTransaction` is
  // used for its SAVEPOINT/ROLLBACK TO SAVEPOINT: without it a server lacking the preloaded library
  // takes every later migration down with it.
  yield* sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.pipe(
    sql.withTransaction,
    Effect.catchAll((e) =>
      Effect.logWarning(
        `pg_stat_statements is not available, so load reports will have no statement ranking. ` +
          `Add \`-c shared_preload_libraries=pg_stat_statements\` to the Postgres command and restart it. (${String(e)})`,
      ),
    ),
  );

  // 80 leaves a fifth of each page free so the per-turn updates stay heap-only and touch no index.
  // It applies only to pages written from now on; existing pages keep their old packing.
  yield* sql`ALTER TABLE conversations SET (fillfactor = 80)`;
  yield* sql`ALTER TABLE conversation_turns SET (fillfactor = 80)`;

  for (const table of ["conversations", "conversation_turns", "outbox_jobs", "scheduled_actions"] as const) {
    yield* sql`ALTER TABLE ${sql.unsafe(table)} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)`;
  }
});
