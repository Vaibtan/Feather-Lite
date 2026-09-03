import { DateTime, Effect, Either, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { EventRecord, JudgeVerdict, OutboxJobType, ScoreRecord } from "@feather-lite/domain";
import {
  booleanScore,
  buildJudgeInput,
  buildTranscript,
  callSloVerdict,
  decodeJudgeVerdict,
  evaluateCall,
  evaluationScores,
  silentPlayoutTurnIds,
  JUDGE_DIMENSIONS,
  JUDGE_RESPONSE_SCHEMA,
  judgePrompt,
  judgeScores,
  replay,
  ttsScores,
} from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { LlmCallFailed } from "../errors.js";
import type { OutboxJobRow } from "../db/rows.js";
import { LlmClient } from "../llm/LlmClient.js";
import { ConversationRepo } from "../repos/conversation.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";
import { Scores } from "./Scores.js";
import { Tracing } from "./Tracing.js";

const JOB_TYPES: ReadonlyArray<OutboxJobType> = ["SUMMARY", "EVALUATION", "VECTOR_INDEX"];

const MAX_RETRIES = 3;
const JUDGE_MAX_RETRIES = 5;
const retriesFor = (jobType: OutboxJobType): number => (jobType === "JUDGE" ? JUDGE_MAX_RETRIES : MAX_RETRIES);

export const RECLAIM_BUDGET_EXHAUSTED = "reclaimed past the retry budget; every attempt lost its process";

interface JudgeOutcome {
  readonly verdict: JudgeVerdict | null;
  readonly attempts: number;
  readonly invalid: string | null;
}

export class OutboxService extends Effect.Service<OutboxService>()("@feather-lite/OutboxService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sched = yield* SchedulingRepo;
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;
    const scores = yield* Scores;
    const cfg = yield* AppConfig;
    const llm = yield* LlmClient;
    const tracing = yield* Tracing;

    const enqueuePostCall = (conversationId: string, now: Date) =>
      Effect.gen(function* () {
        const existing = new Set((yield* sched.existingJobTypes(conversationId)).map((r) => r.jobType));
        const created: OutboxJobType[] = [];
        const jobTypes = cfg.judge.enabled ? [...JOB_TYPES, "JUDGE" as const] : JOB_TYPES;
        for (const jobType of jobTypes) {
          if (existing.has(jobType)) continue;
          yield* sched.insertOutboxJob({ id: yield* ids.next(), conversationId, jobType, availableAt: now });
          created.push(jobType);
        }
        if (created.length > 0) {
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId,
            event: { type: "OUTBOX_ENQUEUED", payload: { job_types: created } },
            createdAt: now,
          });
        }
        return created;
      });

    /**
     * Called before the job's transaction opens, never inside it: a reasoning model takes tens of
     * seconds, and holding a Postgres connection across that lets a slow judge exhaust the pool for
     * the live call path.
     */
    const runJudge = (conversationId: string, events: ReadonlyArray<EventRecord>): Effect.Effect<JudgeOutcome, LlmCallFailed> =>
      Effect.gen(function* () {
        const input = buildJudgeInput(events, evaluateCall(events));
        const messages = judgePrompt(input);
        const request = {
          model: cfg.judge.model,
          messages,
          maxTokens: cfg.judge.maxTokens,
          reasoningEffort: cfg.judge.reasoningEffort,
          jsonSchema: { name: "call_verdict", schema: JUDGE_RESPONSE_SCHEMA },
          metadata: { conversation_id: conversationId, purpose: "judge" },
        };
        let lastError = "";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const res = yield* llm.complete(request);
          yield* tracing.judge({
            conversationId,
            model: cfg.judge.model,
            input,
            output: res.text,
            latencyMs: res.latencyMs,
            usage: res.usage,
          });
          const parsed = Either.try({ try: () => JSON.parse(res.text) as unknown, catch: (e) => String(e) });
          const verdict = Either.isLeft(parsed) ? Either.left(`not JSON: ${parsed.left.slice(0, 120)}`) : decodeJudgeVerdict(parsed.right);
          if (Either.isRight(verdict)) return { verdict: verdict.right as JudgeVerdict, attempts: attempt, invalid: null };
          lastError = res.finishReason === "length" ? `truncated at ${cfg.judge.maxTokens} tokens` : verdict.left;
          yield* Effect.logWarning("judge returned an unusable verdict").pipe(Effect.annotateLogs({ conversation_id: conversationId, attempt, detail: lastError }));
        }
        return { verdict: null, attempts: 2, invalid: lastError };
      });

    const processJob = (job: OutboxJobRow, now: Date) =>
      Effect.gen(function* () {
        // Read once and handed to both the judge and the transaction. Safe because every outbox job
        // is post-call: the conversation is finished and its event log is append-only.
        const events = yield* conv.listEvents(job.conversationId);
        const judged = job.jobType === "JUDGE" ? yield* runJudge(job.conversationId, events) : null;
        return yield* processJobTx(job, now, judged, events);
      }).pipe(
        Effect.annotateLogs({ conversation_id: job.conversationId, outbox_job: job.jobType }),
      );

    const processJobTx = (job: OutboxJobRow, now: Date, judged: JudgeOutcome | null, events: ReadonlyArray<EventRecord>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const snapshot = replay(events);
          const transcript = buildTranscript(events);
          let result: Record<string, unknown>;
          switch (job.jobType) {
            case "SUMMARY": {
              const borrowerLines = transcript.filter((t) => t.speaker === "BORROWER").map((t) => t.text);
              const agentLines = transcript.filter((t) => t.speaker === "AGENT").map((t) => t.text);
              result = {
                final_outcome: snapshot.finalOutcome,
                state_path: snapshot.statePath,
                turns: transcript.length,
                borrower_last: borrowerLines.at(-1) ?? "",
                agent_last: (agentLines.at(-1) ?? "").slice(0, 220),
                tools: snapshot.executedTools,
              };
              const row = yield* conv.lockConversation(job.conversationId);
              if (Option.isSome(row)) {
                yield* conv.updateConversation(job.conversationId, {
                  finalOutcomeMetadata: {
                    ...row.value.finalOutcomeMetadata,
                    wrap_up: {
                      borrower_last: (borrowerLines.at(-1) ?? "").slice(0, 200),
                      turns: transcript.length,
                    },
                  },
                });
              }
              break;
            }
            case "EVALUATION": {
              const evaluation = evaluateCall(events);
              const ttsRows = yield* conv.turnTtsFacts(job.conversationId);
              const silentTurns = silentPlayoutTurnIds(events);
              const latencyRows = yield* conv.turnLatencyFacts(job.conversationId);
              const verdict = callSloVerdict(
                latencyRows.map((r) => ({
                  eou_delay_ms: r.eouDelayMs,
                  transcription_delay_ms: r.transcriptionDelayMs,
                  ttft_ms: r.ttftMs,
                  tts_ttfb_ms: r.ttsTtfbMs,
                })),
                cfg.slo,
              );
              const written = yield* scores.recordMany([
                ...evaluationScores(job.conversationId, evaluation),
                ...(verdict.pass === null
                  ? []
                  : [
                      booleanScore(job.conversationId, "latency.slo_pass", verdict.pass, "EVALUATOR", {
                        comment: verdict.pass ? `${String(verdict.measured)} component reading(s), all within target` : `over target: ${verdict.breached.join(", ")}`,
                        evidence: { breached: verdict.breached, readings: verdict.measured },
                      }),
                    ]),
                ...ttsScores(
                  job.conversationId,
                  ttsRows.map((r) => ({ turnId: r.turnId, audioMs: r.ttsAudioMs, chars: r.ttsChars, silent: silentTurns.has(r.turnId) })),
                ),
              ]);
              result = {
                issues: evaluation.issues,
                compliance_ok: evaluation.complianceOk,
                agent_turns: evaluation.agentTurns,
                borrower_turns: evaluation.borrowerTurns,
                right_party_verified: evaluation.rightPartyVerified,
                voicemail: evaluation.voicemail,
                mini_miranda_first: evaluation.miniMirandaFirst,
                no_protected_before_rpc: evaluation.noProtectedBeforeRpc,
                no_promise_without_readback: evaluation.noPromiseWithoutReadback,
                barge_in_count: evaluation.bargeInCount,
                no_input_count: evaluation.noInputCount,
                degraded_turns: evaluation.degradedTurns,
                tool_rejections: evaluation.toolRejections,
                duration_ms: evaluation.durationMs,
                scores_written: written,
              };
              break;
            }
            case "JUDGE": {
              if (judged === null) return yield* Effect.dieMessage("JUDGE job reached the transaction without a verdict");
              const written = yield* scores.recordMany(
                judged.verdict === null
                  ? ([booleanScore(job.conversationId, "judge.invalid_output", true, "JUDGE", { comment: judged.invalid })] satisfies ReadonlyArray<ScoreRecord>)
                  : judgeScores(job.conversationId, judged.verdict),
              );
              result =
                judged.verdict === null
                  ? { model: cfg.judge.model, invalid_output: true, detail: judged.invalid, attempts: judged.attempts, scores_written: written }
                  : {
                      model: cfg.judge.model,
                      overall_pass: judged.verdict.overall_pass,
                      confidence: judged.verdict.confidence,
                      failed_dimensions: JUDGE_DIMENSIONS.filter((d) => judged.verdict !== null && !judged.verdict[d].pass),
                      attempts: judged.attempts,
                      scores_written: written,
                    };
              break;
            }
            case "VECTOR_INDEX":
              result = { indexed: true, stub: true, final_outcome: snapshot.finalOutcome };
              break;
          }
          yield* sched.finishJob({ id: job.id, status: "DONE", result, error: null, processedAt: now });
          yield* conv.lockConversation(job.conversationId);
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId: job.conversationId,
            event: { type: "OUTBOX_PROCESSED", payload: { job_type: job.jobType, result } },
            createdAt: now,
          });
          return { jobId: job.id, jobType: job.jobType, status: "DONE" as const };
        }),
      );

    /** Four against a pool of ten: each job opens one transaction, leaving room for the turn path. */
    const OUTBOX_CONCURRENCY = Math.max(1, Number(process.env["OUTBOX_CONCURRENCY"] ?? 4));

    const runOnce = (limit = 20, nowOverride?: DateTime.Utc) =>
      Effect.gen(function* () {
        const now = DateTime.toDateUtc(nowOverride ?? (yield* DateTime.now));
        const jobs = yield* sql.withTransaction(sched.claimDueJobs({ now, limit }));
        return yield* Effect.forEach(
          jobs,
          (job) =>
            // A job whose work kills its process never reaches the `catchAll` below, so without
            // this check the lease would hand it back every period forever. The count is read
            // before any work is done.
            Number(job.payload["retry_count"] ?? 0) >= retriesFor(job.jobType)
              ? sched
                  .finishJob({ id: job.id, status: "FAILED", result: {}, error: RECLAIM_BUDGET_EXHAUSTED, processedAt: now })
                  .pipe(Effect.as({ jobId: job.id, jobType: job.jobType, status: "FAILED" as const }))
              : processJob(job, now).pipe(
                  Effect.catchAll((err) =>
                    Effect.gen(function* () {
                      // Read here rather than reused from the claim, because a job can fail long
                      // after the batch was stamped. Deliberately the same clock the claim reads,
                      // not `Date.now()`: a wall-clock stamp under a frozen test clock puts the
                      // retry permanently out of reach.
                      const failedAt = DateTime.toDateUtc(yield* DateTime.now);
                      const retry = Number(job.payload["retry_count"] ?? 0) + 1;
                      if (retry < retriesFor(job.jobType)) {
                        yield* sched.finishJob({
                          id: job.id,
                          status: "PENDING",
                          result: {},
                          error: String(err),
                          processedAt: null,
                          availableAt: new Date(failedAt.getTime() + Math.min(60, retry * 5) * 60_000),
                          payloadPatch: { retry_count: retry },
                        });
                        return { jobId: job.id, jobType: job.jobType, status: "PENDING" as const };
                      }
                      yield* sched.finishJob({ id: job.id, status: "FAILED", result: {}, error: String(err), processedAt: failedAt, payloadPatch: { retry_count: retry } });
                      return { jobId: job.id, jobType: job.jobType, status: "FAILED" as const };
                    }),
                  ),
                ),
          { concurrency: OUTBOX_CONCURRENCY },
        );
      });

    /** The cap stops one tick monopolising the process, so the turn path gets the interval back. */
    const MAX_BATCHES_PER_TICK = 10;
    const drain = (limit = 20, onBatch?: Effect.Effect<void>) =>
      Effect.gen(function* () {
        let processed = 0;
        for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
          const batch = yield* runOnce(limit);
          processed += batch.length;
          if (onBatch) yield* onBatch;
          if (batch.length < limit) break;
          yield* Effect.yieldNow();
        }
        return processed;
      });

    return { enqueuePostCall, processJob, runOnce, drain } as const;
  }),
  dependencies: [SchedulingRepo.Default, ConversationRepo.Default, IdGen.Default, Scores.Default],
}) {}
