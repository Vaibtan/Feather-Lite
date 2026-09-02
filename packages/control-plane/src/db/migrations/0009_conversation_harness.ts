/**
 * `conversations.harness` — which harness placed the call, so a synthetic one cannot move a real
 * number (issue #1, D4's segment rule).
 *
 * The SLO window is already segmented by `channel` and `decider` (ADR 0010 D3), and neither
 * separates a simulator call from a real one: a tier-3 call is `channel: 'voice'` served by the real
 * decider, which is exactly what the default segment selects. So the moment the simulator runs — with
 * degraded audio, seeded interruptions and accent personas, all deliberately harder than a real
 * call — its turns would land in the window the product's latency claim is computed over.
 *
 * Measured precedent for why that matters: a tier-1 load run put 36 scripted turns into the "last 50
 * calls" window and `slo.measured.ttft_ms` fell from 3 228 to 1 252 ms. Nothing got faster. The
 * segmentation exists because that happened once already.
 *
 * Nullable, no default, so this is a catalogue update rather than a table rewrite, and `NULL` means
 * "a real caller placed this" — which is true of every row written before the simulator existed.
 * Rows are **not** back-filled for the same reason migration 0004 did not back-fill `decider`.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0009 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE conversations ADD COLUMN harness text NULL`;

  // No index: the segment query already orders by `started_at DESC` with a LIMIT and can use
  // `ix_conversations_started`; whether this predicate needs its own index is a measurement nobody
  // has taken (migration 0006's rule).
});
