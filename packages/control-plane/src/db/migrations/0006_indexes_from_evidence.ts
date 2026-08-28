/**
 * Two indexes, both from `pg_stat_statements` and `EXPLAIN` rather than from intuition (D5b).
 *
 * The spec's rule for this phase is that an index has to be argued for by a measurement. These two
 * were the only ones a C=100 run and the sweeper's own plan asked for; everything else the audit
 * speculated about (`conversation_events (conversation_id, type)`, an expression index on
 * `payload->>'turn_id'`) did not appear in the ranking and is not built.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0006 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * **The most expensive statement in a C=100 run**: 601 ms of the run's 1 521 ms of database
   * time — 40 % — spread over 100 calls at 6.013 ms each. It runs once per finished call, from
   * `Outbox.enqueuePostCall`, to find out which post-call jobs already exist.
   *
   * `EXPLAIN` on the dev database: `Seq Scan on outbox_jobs`, 32 838 rows, 2 255 buffers, 6.08 ms,
   * to return three. `outbox_jobs` had exactly one index — `(status, available_at)` for the claim
   * query — and nothing for the by-conversation lookup.
   *
   * `(conversation_id, job_type)` rather than `conversation_id` alone so the `DISTINCT job_type`
   * is answered from the index without visiting the heap.
   */
  yield* sql`CREATE INDEX ix_outbox_jobs_conversation ON outbox_jobs (conversation_id, job_type)`;

  /**
   * The orphaned-call sweeper's candidate query, run every 10 seconds forever.
   *
   * `EXPLAIN` on the dev database: `Seq Scan on conversations`, **14 250 rows removed by filter**
   * to return none, 650 buffers, 2 ms — and both numbers grow with every call ever made. A poll
   * whose cost is proportional to history is a poll that eventually becomes the load.
   *
   * Partial, because the rows it wants are the rare ones: a conversation that is open and
   * undecided. On this database that is a handful out of 14 250, so the index is a few pages
   * against the table's 650.
   *
   * **It does not cost the HOT updates that `0005` set `fillfactor` for.** A HOT update requires
   * that no indexed column *and no predicate column* change, and the per-turn writes touch
   * `active_turn_id`, `current_state` and `no_input_count` — none of which appear here.
   * `ended_at` and `final_outcome` change once, at finalize, and that one update is allowed to
   * cost an index entry.
   */
  yield* sql`
    CREATE INDEX ix_conversations_open_voice ON conversations (channel, started_at)
    WHERE ended_at IS NULL AND final_outcome IS NULL`;

  /**
   * Not `CONCURRENTLY`, for the reason `0004` records: this migrator runs each migration inside a
   * transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. Both tables are small enough
   * here (33 k and 14 k rows) that the ACCESS EXCLUSIVE lock is milliseconds. A deployment with a
   * large history should build these by hand, concurrently, before deploying.
   */
});
