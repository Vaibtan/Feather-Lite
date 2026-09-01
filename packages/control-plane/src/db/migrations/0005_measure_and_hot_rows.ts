/**
 * Make Postgres measurable, and keep the per-turn updates off the indexes (spec 2026-08-27, D5b).
 *
 * Two unrelated-looking things in one migration because they are the same idea: the control-plane
 * work in D5 is about ~43 round trips per turn, and neither the count nor the fix can be judged by
 * a wall clock. `pg_stat_statements` turns that into a ranking, and `fillfactor` + autovacuum keep
 * the tables under it from drifting while the measurements are being taken.
 *
 * Postgres is **not** the current constraint — 52 MiB resident, under 2.7 % CPU and zero lock waits
 * at C=200 in the audit — so nothing here is expected to move a latency number on its own. It is
 * the instrument and the hygiene the D5 commits are measured against.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0005 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * The extension needs its library preloaded at server start (`shared_preload_libraries`, set on
   * the compose command), which a migration cannot do. A server without it fails this statement
   * with a clear message, and that must be a **warning, not a failed boot**: a deployment that has
   * not been restarted for it, or a managed Postgres that does not offer it, should still run the
   * product. What is lost is the measurement, not the service.
   *
   * **The savepoint is what makes that true** (review 2026-08-30, #2). Catching the Effect error
   * does not un-poison the Postgres session: a failed statement inside a transaction leaves it in
   * `25P02`, and every statement after it fails with "current transaction is aborted" — so the
   * `ALTER TABLE` two lines down took the whole migration down with it and the server could not
   * boot. That is the opposite of what the paragraph above promises, and it is exactly the
   * environment CI runs (`postgres:16-alpine` with no preload flag).
   *
   * A nested `withTransaction` is a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair
   * (`@effect/sql/dist/esm/internal/client.js:88-100`), which is the one construct that discards
   * the failed statement and leaves the enclosing transaction usable. `CREATE EXTENSION` is legal
   * inside a transaction block, so this costs nothing when the extension *is* available.
   */
  yield* sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.pipe(
    sql.withTransaction,
    Effect.catchAll((e) =>
      Effect.logWarning(
        `pg_stat_statements is not available, so load reports will have no statement ranking. ` +
          `Add \`-c shared_preload_libraries=pg_stat_statements\` to the Postgres command and restart it. (${String(e)})`,
      ),
    ),
  );

  /**
   * `conversations` is updated on **every turn** — the `active_turn_id` claim and release — and
   * `conversation_turns.result` on every playout and metrics signal. At the default fillfactor of
   * 100 a page has no room for a new row version, so each of those updates writes to a fresh page
   * and has to add an index entry pointing at it, on every index of the table.
   *
   * 80 leaves a fifth of each page free for the new versions to live beside the old ones — a
   * heap-only tuple update, which touches no index at all. The cost is a fifth more pages for a
   * table that is 9 MB on a dev database.
   *
   * **This only applies to pages written from now on.** Existing pages keep their old packing until
   * they are rewritten, so the ratio to watch (`n_tup_hot_upd / n_tup_upd`, target > 0.9) is
   * measured over a soak run's own writes rather than over the table's history.
   */
  yield* sql`ALTER TABLE conversations SET (fillfactor = 80)`;
  yield* sql`ALTER TABLE conversation_turns SET (fillfactor = 80)`;

  /**
   * The four write-heavy tables, vacuumed and analysed far more eagerly than the 20 %/10 % defaults.
   *
   * `outbox_jobs` and `scheduled_actions` are claimed with `FOR UPDATE SKIP LOCKED` over a small hot
   * set that every poll scans — one loop every 5 s and another every 15 s — so dead tuples there are
   * paid on each poll rather than once. `conversations` and `conversation_turns` are updated once or
   * twice per turn each. 2 % and 1 % are cheap on tables this size and stop the polls from walking
   * a growing pile of dead rows between vacuums.
   */
  // `apps/load-test/src/tier1.ts` reports the HOT ratio for exactly this list; keep the two in step.
  for (const table of ["conversations", "conversation_turns", "outbox_jobs", "scheduled_actions"] as const) {
    yield* sql`ALTER TABLE ${sql.unsafe(table)} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)`;
  }
});
