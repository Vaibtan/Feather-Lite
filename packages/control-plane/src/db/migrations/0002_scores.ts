/**
 * No foreign key on `conversation_id`: the scenario suite scores a synthetic per-run id that has no
 * `conversations` row. The identity index uses NULLS NOT DISTINCT because `turn_id` is null for a
 * call-level score, and under the default rule two such writes would both insert instead of upserting.
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
  yield* sql`CREATE INDEX ix_conversation_scores_name_created ON conversation_scores (name, created_at DESC)`;
});
