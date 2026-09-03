/**
 * Nullable with no default, so rows already sitting in `CLAIMED` read `NULL` and `NULL < now - lease`
 * is unknown: the first tick after this migration does not sweep them up and re-run months of
 * post-call jobs. Requeueing any of them is a deliberate act.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0007 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE scheduled_actions ADD COLUMN claimed_at timestamptz NULL`;
});
