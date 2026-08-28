/**
 * The one way a score is written (spec 2026-08-26, D1).
 *
 * Every producer — the deterministic evaluator, the LLM judge, the voice harness, a human labelling
 * a call in the console, the sweeper — goes through `record`. It does two things in a fixed order:
 * persist to the ledger-side `conversation_scores` table, then mirror to Langfuse through the
 * `Tracing` seam. Postgres first is the whole point: the console, the quality endpoint and the fleet
 * report read a durable table, and Langfuse is the copy that makes quality visible next to latency
 * and cost. If the mirror fails the score still exists; if the write fails, nothing is claimed.
 *
 * Records that contradict their own name's data type are rejected before either side sees them —
 * Langfuse silently drops a BOOLEAN score whose value is 0.7, and a metric that disappears at the
 * ingestion boundary is worse than one that fails where it was produced.
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
            // A malformed score is a producer bug, not a call failure: log it loudly and keep going
            // so one bad name cannot cost a call its other measurements.
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
        // Send them now and read the answer (O7). Scores are written after the call has ended, so
        // the conversation's own trace flush has already run; without this the batch would sit
        // buffered until some unrelated call finished. Off the hot path by construction — this runs
        // in the EVALUATION and JUDGE outbox jobs, not in a turn.
        if (written > 0) yield* tracing.flushScores();
        return written;
      });

    const record = (one: ScoreRecord) => recordMany([one]);

    const listForConversation = (conversationId: string) => repo.listForConversation(conversationId);

    return { record, recordMany, listForConversation } as const;
  }),
  dependencies: [ScoresRepo.Default],
}) {}
