/**
 * `conversations.decider` — which conversationalist served the call (O2).
 *
 * The SLO is a claim about the product's latency, and the window it was computed over mixed two
 * populations that have nothing to say about each other. Measured: a tier-1 load run added 36
 * scripted turns to the "last 50 calls" window and `slo.measured.ttft_ms` fell 3 228 -> 1 252 ms,
 * dropping `ttft_ms` off the breach list entirely. Nothing got faster; the window filled with turns
 * decided by a `switch` statement instead of a model.
 *
 * Channel alone does not separate them — a simulated call and a voice call can both run the real
 * decider, and `TURN_DECIDER=scripted` can serve either — so the decider is recorded per
 * conversation at the moment the call starts, from the config that will actually serve it.
 *
 * No index ships with it; see the note in the body. Nullable, and null on every row written before
 * this migration — deliberately: those calls *were* served by something, but this database does not
 * know what, and back-filling a guess would put invented rows inside the very window the
 * segmentation exists to keep honest. A segment query asking for `decider = 'openai'` will simply
 * not see them.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0004 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Metadata-only on every supported Postgres: a nullable column with no default does not rewrite
  // the table and does not hold a lock for longer than the catalogue update.
  yield* sql`ALTER TABLE conversations ADD COLUMN decider text NULL`;

  // **No index here, deliberately.** The obvious one is `(channel, decider, started_at DESC)` to
  // serve the segment window's access path, and it was written and then removed for two reasons.
  //
  // First, this migrator runs each migration inside a transaction, and `CREATE INDEX CONCURRENTLY`
  // cannot run in a transaction block — so the only index this tooling can build is the blocking
  // kind, taking ACCESS EXCLUSIVE on the table every live turn row-locks. The two existing indexes
  // on `conversations` were created in 0001 while it was empty; this would have been the first one
  // added over data.
  //
  // Second, the spec says indexes come from evidence: D5b adds "only what the top-10 [of
  // `pg_stat_statements`] shows", after a soak run. The segment query carries a LIMIT and can use
  // `ix_conversations_started` for its ordering, so it has a plan; whether it needs its own index
  // is a measurement nobody has taken yet.
});
