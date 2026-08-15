/**
 * Outbox (SPEC §15.2): post-call jobs enqueued in the SAME transaction as the outcome
 * (summary, evaluation, vector-index stub), processed by a worker with retry/backoff.
 */
import { DateTime, Effect } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { OutboxJobType } from "@feather-lite/domain";
import { buildTranscript, replay } from "@feather-lite/domain";
import type { OutboxJobRow } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";

const JOB_TYPES: ReadonlyArray<OutboxJobType> = ["SUMMARY", "EVALUATION", "VECTOR_INDEX"];
const MAX_RETRIES = 3;

export class OutboxService extends Effect.Service<OutboxService>()("@feather-lite/OutboxService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sched = yield* SchedulingRepo;
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;

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
              break;
            }
            case "EVALUATION": {
              // Deterministic compliance checks; the LLM-as-judge is a later stretch.
              const unlockSeq = events.find((e) => e.type === "STATE_TRANSITION" && e.payload.triggered_by === "RIGHT_PARTY_CONFIRMED")?.sequence_no ?? null;
              const protectedLeak = events.some(
                (e) =>
                  e.type === "AGENT_TURN" &&
                  (unlockSeq === null || e.sequence_no < unlockSeq) &&
                  /balance|due date|owe/i.test(e.payload.text),
              );
              const miniMirandaFirst = events.find((e) => e.type === "AGENT_TURN")?.payload.text.includes("attempt to collect a debt") ?? false;
              const issues: string[] = [];
              if (protectedLeak) issues.push("PROTECTED_CONTEXT_BEFORE_VERIFICATION");
              if (!miniMirandaFirst) issues.push("MINI_MIRANDA_MISSING");
              result = { issues, compliance_ok: issues.length === 0, agent_turns: transcript.filter((t) => t.speaker === "AGENT").length };
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
  dependencies: [SchedulingRepo.Default, ConversationRepo.Default, IdGen.Default],
}) {}
