/**
 * Outbox (SPEC §15.2): post-call jobs enqueued in the SAME transaction as the outcome
 * (summary, evaluation, vector-index stub), processed by a worker with retry/backoff.
 */
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

/**
 * Retry budgets, per job type. The judge gets a longer one than the deterministic jobs: those fail
 * only if the database or this code is broken, in which case retrying five times is five ways of
 * finding out the same thing, while the judge fails when someone else's API is having an hour.
 */
const MAX_RETRIES = 3;
const JUDGE_MAX_RETRIES = 5;
const retriesFor = (jobType: OutboxJobType): number => (jobType === "JUDGE" ? JUDGE_MAX_RETRIES : MAX_RETRIES);

/** Why a job was failed without being run: every attempt so far ended with a dead process (C3). */
export const RECLAIM_BUDGET_EXHAUSTED = "reclaimed past the retry budget; every attempt lost its process";

/**
 * What the judge came back with. `verdict` and `invalid` are exclusive: a verdict, or the reason
 * there isn't one after the retry D3 allows.
 */
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

    /** Enqueue post-call jobs (idempotent per job type) and log OUTBOX_ENQUEUED. Caller holds the tx. */
    const enqueuePostCall = (conversationId: string, now: Date) =>
      Effect.gen(function* () {
        const existing = new Set((yield* sched.existingJobTypes(conversationId)).map((r) => r.jobType));
        const created: OutboxJobType[] = [];
        // The judge is enqueued only when it is switched on. Enqueuing it regardless and skipping
        // it at processing time would leave every CI run and every load run with a trail of jobs
        // that look pending forever, which is indistinguishable on the console from a stuck worker.
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
     * Ask the judge about one call (spec 2026-08-26, D3).
     *
     * Deliberately **outside** the job's transaction, and called before it opens: a reasoning model
     * at medium effort takes tens of seconds, and holding a Postgres connection open across that
     * would let a slow judge exhaust the pool for the live call path.
     *
     * One retry on an unparseable verdict, as D3 says. A second failure is recorded as
     * `judge.invalid_output` and the job completes: a broken judge should be visible *as* a broken
     * judge, not as a call nobody has looked at, and it should not consume the retry budget meant
     * for the judge being unreachable — that is a different problem with a different fix.
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
        /**
         * The ledger is read **once per job**, here, and handed to both the judge and the
         * transaction. A JUDGE job used to read the whole conversation twice — once to give the
         * model something to read, once again inside the transaction — and a judged call's ledger
         * is the largest single read this system makes.
         *
         * Safe because every outbox job is post-call: `enqueuePostCall` is the only thing that
         * writes one, and it runs at finalize. The conversation is finished and its event log is
         * append-only, so a read taken a few milliseconds before the transaction opens sees exactly
         * what a read inside it would.
         */
        const events = yield* conv.listEvents(job.conversationId);
        // Everything that talks to another system happens before the transaction opens. Today that
        // is only the judge; the rule is the point.
        const judged = job.jobType === "JUDGE" ? yield* runJudge(job.conversationId, events) : null;
        return yield* processJobTx(job, now, judged, events);
      }).pipe(
        // Post-call work is per-conversation and runs minutes after the call, on a shared loop, so
        // its log lines are the least attributable in the system without this (D3).
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
              // Persist the cross-call wrap-up (research 2026-08-22 §3.3) onto the conversation row,
              // where `priorConversations` -> `buildMemoryBlock` reads it on the borrower's NEXT
              // call. Same jsonb the outcome tools already write, so nothing new to migrate or gate:
              // memory stays behind the right-party unlock like the rest of the metadata.
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
              // The compliance checks and call facts are all ledger-derived, so the work is a pure
              // function in the domain package (`evaluateCall`) and this job only persists it. The
              // values go to `conversation_scores`, where they aggregate and can be re-derived; the
              // job result keeps its long-standing `issues` / `compliance_ok` shape so the console's
              // outbox panel and anything reading old rows are unaffected.
              const evaluation = evaluateCall(events);
              // TTS facts live in the turn rows rather than the ledger, so they are read back here
              // and scored alongside the ledger-derived ones — one job, one set of post-call scores.
              const ttsRows = yield* conv.turnTtsFacts(job.conversationId);
              const silentTurns = silentPlayoutTurnIds(events);
              /**
               * The per-call SLO verdict (O6). `latency.slo_pass` has been in the closed score
               * vocabulary since it was written, typed BOOLEAN, with no producer anywhere — while
               * `scores.ts` says "an entry here is never a metric nobody emits". It is written here
               * because this job runs post-call, when every turn row exists and its worker-side
               * components have landed, and because "was this call within SLO" should be a
               * historical query rather than something recomputed on a page refresh.
               */
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
                // Null stays unwritten: a call that measured nothing has not passed the SLO, and a
                // green tick on it would be the flattering reading of an absence.
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
              // `judged` is always present here: `processJob` runs the model before opening the
              // transaction. The guard is for the type, and for anyone who calls this directly.
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
                      // Named from the closed dimension list rather than reflected out of the
                      // object, so a new dimension is a compile error here instead of a key that
                      // quietly stops being reported.
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

    /**
     * How many claimed jobs are processed at once (C2).
     *
     * The loop claimed up to 20 and then processed them **one at a time**, so a batch was as slow
     * as the sum of its jobs. Measured: a C=100 tier-1 run leaves 300 jobs and took **~70 seconds**
     * to drain them — long enough that the next load run started inside the backlog and reported a
     * throughput that was really the drain (the tier-1 harness now waits for exactly this reason).
     *
     * Four, against a pool of ten: each job opens one transaction, so four is comfortably inside the
     * pool with room for the turn path, which must never wait behind post-call work. Higher is an
     * env change, not a code change, because the right number depends on the pool and on whether
     * the judge is on — a JUDGE job spends most of its time waiting on a model, not on Postgres.
     */
    const OUTBOX_CONCURRENCY = Math.max(1, Number(process.env["OUTBOX_CONCURRENCY"] ?? 4));

    const runOnce = (limit = 20, nowOverride?: DateTime.Utc) =>
      Effect.gen(function* () {
        const now = DateTime.toDateUtc(nowOverride ?? (yield* DateTime.now));
        const jobs = yield* sql.withTransaction(sched.claimDueJobs({ now, limit }));
        /**
         * Order is not a property of this batch. Jobs are claimed with `SKIP LOCKED` from whatever
         * is due, they belong to different conversations, and each is idempotent by construction —
         * so processing them concurrently changes how long the batch takes and nothing else. The
         * results are still returned in claim order, because callers (and the DB tests) read them
         * positionally.
         */
        return yield* Effect.forEach(
          jobs,
          (job) =>
            /**
             * A job that has burned its whole budget on *reclaims* is a job that has taken a
             * process down every time it was tried, and it is stopped here rather than tried again
             * (C3).
             *
             * The lease is what makes this reachable at all. Before it a stranded claim was inert;
             * after it, a job whose work reliably kills its process would come back every lease
             * period forever — a slow crash loop introduced by the fix for the opposite problem.
             * The failure path below cannot catch that case, because a process that dies never
             * reaches a `catchAll`. So the count the claim keeps is read here, once, before any
             * work is done: at budget the job is `FAILED` with the reason, which is a state an
             * operator can see, rather than a loop nobody is told about.
             */
            Number(job.payload["retry_count"] ?? 0) >= retriesFor(job.jobType)
              ? sched
                  .finishJob({ id: job.id, status: "FAILED", result: {}, error: RECLAIM_BUDGET_EXHAUSTED, processedAt: now })
                  .pipe(Effect.as({ jobId: job.id, jobType: job.jobType, status: "FAILED" as const }))
              : processJob(job, now).pipe(
                  Effect.catchAll((err) =>
                    Effect.gen(function* () {
                      const retry = Number(job.payload["retry_count"] ?? 0) + 1;
                      if (retry < retriesFor(job.jobType)) {
                        yield* sched.finishJob({
                          id: job.id,
                          status: "PENDING",
                          result: {},
                          error: String(err),
                          processedAt: null,
                          availableAt: new Date(now.getTime() + Math.min(60, retry * 5) * 60_000),
                          payloadPatch: { retry_count: retry },
                        });
                        return { jobId: job.id, jobType: job.jobType, status: "PENDING" as const };
                      }
                      yield* sched.finishJob({ id: job.id, status: "FAILED", result: {}, error: String(err), processedAt: now, payloadPatch: { retry_count: retry } });
                      return { jobId: job.id, jobType: job.jobType, status: "FAILED" as const };
                    }),
                  ),
                ),
          { concurrency: OUTBOX_CONCURRENCY },
        );
      });

    /**
     * Keep claiming while the batch comes back full, so a backlog drains at the rate the work can
     * be done rather than at the rate the loop happens to poll (C2).
     *
     * **This is the half that actually mattered, and only measurement showed it.** Processing the
     * batch concurrently made a batch of 20 take ~1.3 s instead of ~5, and a 283-job backlog still
     * took **74 seconds** to clear — because the loop claims at most 20 every 5 seconds, so the
     * ceiling was 4 jobs/s no matter how fast each one was. The concurrency was necessary and not
     * sufficient; the pacing was the constraint.
     *
     * A short batch means the queue is empty, and the loop goes back to sleep for its interval. The
     * cap exists so one tick cannot monopolise the process: at 20 a batch that is 200 jobs, after
     * which the turn path gets the interval back whether or not the queue is clear.
     */
    const MAX_BATCHES_PER_TICK = 10;
    /**
     * `onBatch` exists so liveness is reported at the rate work is actually done (review #9).
     *
     * A full drain is up to 10 batches of 20, and with the judge on a single batch can wait tens of
     * seconds on a model — longer than the 15 s staleness window `/readyz` allows. So the busier
     * the outbox was, the more likely it was to be reported dead: the signal fired hardest when the
     * fiber was healthiest. Stamping per batch means the loop says "still working" while it works,
     * and the only thing that can go stale is a loop that has genuinely stopped.
     *
     * A callback rather than a `ProcessMetrics` dependency: this service knows when a batch is
     * done, and nothing else about who is watching.
     */
    const drain = (limit = 20, onBatch?: Effect.Effect<void>) =>
      Effect.gen(function* () {
        let processed = 0;
        for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
          const batch = yield* runOnce(limit);
          processed += batch.length;
          if (onBatch) yield* onBatch;
          if (batch.length < limit) break;
          // Cooperative: a full batch means there is more, and the turn path is on this event loop.
          yield* Effect.yieldNow();
        }
        return processed;
      });

    return { enqueuePostCall, processJob, runOnce, drain } as const;
  }),
  dependencies: [SchedulingRepo.Default, ConversationRepo.Default, IdGen.Default, Scores.Default],
}) {}
