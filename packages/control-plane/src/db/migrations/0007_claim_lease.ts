/**
 * `scheduled_actions.claimed_at` — the column that makes a claim a lease (C3).
 *
 * `outbox_jobs` has carried `claimed_at` since 0001 and nothing ever read it; `scheduled_actions`
 * did not have it at all, so its claim could not even be dated. Both are claimed with
 * `FOR UPDATE SKIP LOCKED` and marked `CLAIMED`, and until now nothing ever moved a row out of that
 * state but the process that took it — so a worker killed mid-tick stranded its rows permanently: a
 * callback that never fires, a retry that never runs, and on the outbox side no SUMMARY, so the
 * borrower's next call opens without the `wrap_up` the last one wrote.
 *
 * Nullable and with no default, so this is a catalogue update rather than a table rewrite, and
 * every existing row reads `NULL`. That is the right value for them and not merely a convenient
 * one: `NULL < now - lease` is unknown, so a row already sitting in `CLAIMED` when this migration
 * runs is **not** swept up by the first tick afterwards. Those rows are the historical damage this
 * fix exists to prevent rather than to repair, and re-running an unknown number of month-old
 * post-call jobs — judge calls included — on the first boot after a deploy is not something a
 * migration should do quietly. They are listed by the query in the commit message; requeueing any
 * of them is a deliberate act.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0007 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE scheduled_actions ADD COLUMN claimed_at timestamptz NULL`;

  // No index. Both claim statements already filter on `status` and an ordering column
  // (`due_at` / `available_at`) and take a `LIMIT`, and the lease predicate only ever narrows the
  // rows already reached that way. Indexes here come from evidence (migration 0006's rule), and
  // the evidence for this one would be a `pg_stat_statements` row that does not exist yet.
});
