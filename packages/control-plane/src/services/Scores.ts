/**
 * Postgres is written before Langfuse is mirrored, so a failed mirror still leaves the score and a
 * failed write claims nothing. Records contradicting their own name's data type are rejected here,
 * because Langfuse silently drops a BOOLEAN score whose value is 0.7.
 */
import { DateTime, Effect } from "effect";
import type { ScoreRecord } from "@feather-lite/domain";
import { clampScoreComment, dataTypeOf, scoreRecordProblem } from "@feather-lite/domain";
import { ScoresRepo } from "../repos/scores.js";
import { Tracing } from "./Tracing.js";

export class Scores extends Effect.Service<Scores>()("@feather-lite/Scores", {
  effect: Effect.gen(function* () {
    const repo = yield* ScoresRepo;
    const tracing = yield* Tracing;

    const recordMany = (records: ReadonlyArray<ScoreRecord>) =>
      Effect.gen(function* () {
        if (records.length === 0) return 0;
        const now = DateTime.toDateUtc(yield* DateTime.now);
        let written = 0;
        for (const raw of records) {
          const record: ScoreRecord = { ...raw, comment: clampScoreComment(raw.comment) };
          const problem = scoreRecordProblem(record);
          if (problem !== null) {
            yield* Effect.logWarning(`score rejected: ${problem}`);
            continue;
          }
          yield* repo.upsert(record, now);
          yield* tracing.score({
            conversationId: record.conversationId,
            turnId: record.turnId,
            name: record.name,
            value: record.value,
            dataType: dataTypeOf(record.name),
            stringValue: record.stringValue ?? null,
            source: record.source,
            comment: record.comment ?? null,
          });
          written += 1;
        }
        // Scores are written after the call has ended, so the conversation's own trace flush has
        // already run and the batch would otherwise sit buffered until an unrelated call finished.
        if (written > 0) yield* tracing.flushScores();
        return written;
      });

    const record = (one: ScoreRecord) => recordMany([one]);

    const listForConversation = (conversationId: string) => repo.listForConversation(conversationId);

    return { record, recordMany, listForConversation } as const;
  }),
  dependencies: [ScoresRepo.Default],
}) {}
