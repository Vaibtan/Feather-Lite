/**
 * `conversations.origin` — how the call was placed, so a re-dial knows whether it can be (C4).
 *
 * The control plane knew the *channel* of a call (`voice` or `simulated`) and not how the voice leg
 * was established. Both a browser tab holding a WebRTC session and an outbound PSTN dial are
 * `channel: 'voice'`, and `finalize` scheduled a `RETRY_CALL` for either one on `NO_ANSWER` — a
 * retry that `prepare` then dispatched in `sip` mode, because a scheduled re-dial is by definition
 * outbound.
 *
 * For a call that only ever existed as a browser session — which is every call the load harness
 * places — there is no phone leg to call back. The retry could not succeed even with a trunk
 * configured, so it is not scheduled at all.
 *
 * Nullable, no default: a catalogue update rather than a table rewrite, and rows written before
 * this migration read `NULL`. `NULL` is treated as "not known to be browser-originated", which
 * preserves exactly today's behaviour for historical rows rather than inventing an origin for calls
 * this database cannot speak for — the same rule migration 0004 applied to `decider`, and for the
 * same reason.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0008 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE conversations ADD COLUMN origin text NULL`;

  // No index: the column is read one row at a time, through the primary key, by the conversation
  // that is finalizing. Indexes come from evidence (migration 0006's rule) and there is none.
});
