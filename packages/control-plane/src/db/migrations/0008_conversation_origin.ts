/**
 * `NULL` means "not known to be browser-originated", which preserves the previous behaviour for rows
 * written before this migration rather than inventing an origin this database cannot speak for.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0008 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE conversations ADD COLUMN origin text NULL`;
});
