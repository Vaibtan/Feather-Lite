import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0004 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A nullable column with no default is metadata-only: no table rewrite, and the lock is held only
  // for the catalogue update.
  yield* sql`ALTER TABLE conversations ADD COLUMN decider text NULL`;

  // No index ships with it: this migrator runs each migration in a transaction, and CREATE INDEX
  // CONCURRENTLY cannot run in one, so the only buildable index would take ACCESS EXCLUSIVE on a
  // table every live turn row-locks.
});
