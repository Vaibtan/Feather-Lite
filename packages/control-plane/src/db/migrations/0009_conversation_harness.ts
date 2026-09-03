/**
 * `NULL` means a real caller placed the call, which is true of every row written before the simulator
 * existed; rows are not back-filled. Segmenting on it keeps synthetic turns out of the SLO window.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0009 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE conversations ADD COLUMN harness text NULL`;
});
