/**
 * Persistence for `conversation_scores` (spec 2026-08-26, D1).
 *
 * `upsert` is the only write. A score's identity is `(conversation_id, turn_id, name, source)`, so
 * re-running the evaluator, re-judging a call or re-running the harness over it corrects the row in
 * place instead of appending a second opinion — the same idempotence Langfuse gives a score with a
 * stable `id`. Nothing here takes the conversation row lock: scores must never be able to delay a
 * live turn.
 */
import { Effect, Schema } from "effect";
import { SqlSchema } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { ScoreRecord } from "@feather-lite/domain";
import { dataTypeOf } from "@feather-lite/domain";
import { ScoreRow } from "../db/rows.js";
import { IdGen } from "../services/Ids.js";

const SCORE_COLS = "id, conversation_id, turn_id, name, value, data_type, string_value, source, comment, evidence, created_at";

export class ScoresRepo extends Effect.Service<ScoresRepo>()("@feather-lite/ScoresRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;

    /**
     * Insert or correct one score. `created_at` is preserved on update (it is when the call was
     * first measured); `updated_at` moves, so "the judge changed its mind" is visible in the row.
     */
    const upsert = (record: ScoreRecord, now: Date) =>
      Effect.gen(function* () {
        const id = yield* ids.next();
        yield* sql`
          INSERT INTO conversation_scores ${sql.insert({
            id,
            conversationId: record.conversationId,
            turnId: record.turnId,
            name: record.name,
            value: record.value,
            dataType: dataTypeOf(record.name),
            stringValue: record.stringValue ?? null,
            source: record.source,
            comment: record.comment ?? null,
            evidence: record.evidence === null || record.evidence === undefined ? null : sql.json(record.evidence),
            createdAt: now,
            updatedAt: now,
          })}
          ON CONFLICT (conversation_id, turn_id, name, source) DO UPDATE SET
            value        = EXCLUDED.value,
            data_type    = EXCLUDED.data_type,
            string_value = EXCLUDED.string_value,
            comment      = EXCLUDED.comment,
            evidence     = EXCLUDED.evidence,
            updated_at   = EXCLUDED.updated_at`.pipe(Effect.asVoid);
      });

    const listForConversation = SqlSchema.findAll({
      Request: Schema.String,
      Result: ScoreRow,
      execute: (conversationId) => sql`
        SELECT ${sql.unsafe(SCORE_COLS)} FROM conversation_scores
        WHERE conversation_id = ${conversationId}
        ORDER BY name ASC, source ASC, turn_id ASC NULLS FIRST`,
    });

    return { upsert, listForConversation } as const;
  }),
  dependencies: [IdGen.Default],
}) {}
