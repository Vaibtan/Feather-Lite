/**
 * Outbox (SPEC §15.2): post-call jobs enqueued in the SAME transaction as the outcome
 * (summary, evaluation, vector-index stub), processed by a worker with retry/backoff.
 */
import { DateTime, Effect, Option } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { OutboxJobType } from "@feather-lite/domain";
import { buildTranscript, evaluateCall, evaluationScores, isSilentPlayout, replay, ttsScores } from "@feather-lite/domain";
import type { OutboxJobRow } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";
import { Scores } from "./Scores.js";

const JOB_TYPES: ReadonlyArray<OutboxJobType> = ["SUMMARY", "EVALUATION", "VECTOR_INDEX"];
const MAX_RETRIES = 3;

export class OutboxService extends Effect.Service<OutboxService>()("@feather-lite/OutboxService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sched = yield* SchedulingRepo;
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;
    const scores = yield* Scores;

    /** Enqueue post-call jobs (idempotent per job type) and log OUTBOX_ENQUEUED. Caller holds the tx. */
    const enqueuePostCall = (conversationId: string, now: Date) =>
      Effect.gen(function* () {
        const existing = new Set((yield* sched.existingJobTypes(conversationId)).map((r) => r.jobType));
        const created: OutboxJobType[] = [];
        for (const jobType of JOB_TYPES) {
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

    const processJob = (job: OutboxJobRow, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const events = yield* conv.listEvents(job.conversationId);
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
              const silentTurns = new Set(events.filter(isSilentPlayout).map((e) => e.payload.turn_id));
              const written = yield* scores.recordMany([
                ...evaluationScores(job.conversationId, evaluation),
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

    const runOnce = (limit = 20, nowOverride?: DateTime.Utc) =>
      Effect.gen(function* () {
        const now = DateTime.toDateUtc(nowOverride ?? (yield* DateTime.now));
        const jobs = yield* sql.withTransaction(sched.claimDueJobs({ now, limit }));
        const out: Array<{ jobId: string; jobType: OutboxJobType; status: "DONE" | "PENDING" | "FAILED" }> = [];
        for (const job of jobs) {
          const r = yield* processJob(job, now).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                const retry = Number(job.payload["retry_count"] ?? 0) + 1;
                if (retry < MAX_RETRIES) {
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
          );
          out.push(r);
        }
        return out;
      });

    return { enqueuePostCall, processJob, runOnce } as const;
  }),
  dependencies: [SchedulingRepo.Default, ConversationRepo.Default, IdGen.Default, Scores.Default],
}) {}
