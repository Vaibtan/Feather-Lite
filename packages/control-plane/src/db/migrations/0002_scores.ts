/**
 * `conversation_scores` — the quality/SLO measurements about a call (spec 2026-08-26, D1).
 *
 * Deliberately NOT part of the event ledger. Events are append-only, sequenced and replayed to the
 * outcome; a score is a judgement about the call that a re-run of the evaluator or the judge is
 * expected to overwrite. Writing one must never take the conversation row lock or consume a
 * `sequence_no`, so it cannot slow down or reorder a live turn.
 *
 * Two shape decisions worth the ink:
 *
 *  - **No foreign key on `conversation_id`.** Every producer but one scores a real conversation.
 *    The exception is the scenario suite (D9), which scores a synthetic per-run id — the suite is
 *    a test run, not a call — and a FK would force a fake `conversations` row into existence to
 *    hold it. Scores are a derived side table; `pnpm demo/reset` and the test harness truncate them
 *    alongside the ledger.
 *  - **`UNIQUE ... NULLS NOT DISTINCT`** (Postgres 15+; this deployment is 16). `turn_id` is null
 *    for a call-level score, and under the default NULLS DISTINCT rule two call-level writes of the
 *    same name would both be inserted instead of upserting, which is exactly the duplicate the
 *    identity is meant to prevent.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export const migration0002 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversation_scores (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL,
      turn_id text NULL,
      name text NOT NULL,
      value double precision NOT NULL,
      data_type text NOT NULL,
      string_value text NULL,
      source text NOT NULL,
      comment text NULL,
      evidence jsonb NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  yield* sql`
    CREATE UNIQUE INDEX ux_conversation_scores_identity
      ON conversation_scores (conversation_id, turn_id, name, source) NULLS NOT DISTINCT`;
  yield* sql`CREATE INDEX ix_conversation_scores_conversation ON conversation_scores (conversation_id)`;
  /** The Quality view reads "this score across the last N calls"; name-first is that access path. */
  yield* sql`CREATE INDEX ix_conversation_scores_name_created ON conversation_scores (name, created_at DESC)`;
});
