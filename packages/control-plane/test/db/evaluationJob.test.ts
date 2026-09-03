import { DateTime, Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationRepo,
  IdGen,
  Orchestrator,
  OutboxService,
  Queries,
  SchedulingRepo,
  Scores,
  ScoresRepo,
  ScriptedTurnDeciderLive,
  withFrozenClock,
  WorkflowService,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = Layer.mergeAll(
  Orchestrator.Default,
  WorkflowService.Default,
  OutboxService.Default,
  Queries.Default,
  Scores.Default,
  ScoresRepo.Default,
  ConversationRepo.Default,
  SchedulingRepo.Default,
  IdGen.Default,
).pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

/** 14:00 UTC is 10:00 in America/New_York — inside the TCPA contact window. */
const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

const seedBorrower = (name: string, phone: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    return { borrowerId, cpId };
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("EVALUATION outbox job", () => {
  it("writes the evaluator's facts as scores and upserts them on a re-run", async () => {
    const out = await rt.runPromise(
      // The whole body needs the frozen clock: `enqueuePostCall` stamps `available_at` from the
      // orchestrator's clock, so otherwise the jobs are due in real time and `runOnce` claims nothing.
      withFrozenClock(NOW)(Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Evaluated Person", "+15550003001");
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const outbox = yield* OutboxService;
        const scores = yield* Scores;
        const sched = yield* SchedulingRepo;
        const q = yield* Queries;
        const now = NOW;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now });
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
        yield* outbox.runOnce(20, now);
        const afterFirst = yield* scores.listForConversation(started.conversationId);
        const jobs = yield* q.outboxJobsFor(started.conversationId);

        const evaluation = jobs.find((j) => j.jobType === "EVALUATION")!;
        yield* sched.insertOutboxJob({ id: yield* (yield* IdGen).next(), conversationId: started.conversationId, jobType: "EVALUATION", availableAt: DateTime.toDateUtc(now) });
        yield* outbox.runOnce(20, now);
        const afterSecond = yield* scores.listForConversation(started.conversationId);
        return { conversationId: started.conversationId, afterFirst, afterSecond, evaluation };
      })),
    );

    const byName = new Map(out.afterFirst.map((r) => [r.name, r]));
    expect([...byName.keys()].sort()).toEqual([
      "call.agent_turns",
      "call.barge_in_count",
      "call.borrower_turns",
      "call.degraded_turns",
      "call.duration_ms",
      "call.no_input_count",
      "call.right_party_verified",
      "call.tool_rejections",
      "call.voicemail",
      "compliance.mini_miranda_first",
      "compliance.no_protected_before_rpc",
    ]);
    expect(out.afterFirst.every((r) => r.source === "EVALUATOR" && r.turnId === null)).toBe(true);
    expect(byName.get("compliance.mini_miranda_first")!.value).toBe(1);
    expect(byName.get("compliance.no_protected_before_rpc")!.value).toBe(1);
    // An opt-out records no promise, so the read-back check has nothing to judge and writes no score.
    expect(byName.get("call.right_party_verified")!.value).toBe(0);
    expect(byName.has("compliance.no_promise_without_readback")).toBe(false);

    expect(out.evaluation.result["compliance_ok"]).toBe(true);
    expect(out.evaluation.result["issues"]).toEqual([]);
    expect(out.evaluation.result["scores_written"]).toBe(out.afterFirst.length);

    expect(out.afterSecond).toHaveLength(out.afterFirst.length);
  });

  it("scores the speech shape the voice worker reported, per turn, beside the ledger's facts", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Spoken To", "+15550003003");
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const outbox = yield* OutboxService;
        const scores = yield* Scores;
        const now = NOW;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "voice", now });
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is jordan" }, () => Effect.void);
        yield* orch.processSignal(started.conversationId, { kind: "turn_metrics", turnId: "t1", ttsTtfbMs: 420, ttsAudioMs: 4000, ttsChars: 60 });
        // A second turn whose synthesis produced nothing, reported as a playout that heard nothing.
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "please stop calling me" }, () => Effect.void);
        yield* orch.processSignal(started.conversationId, { kind: "playout", turnId: "t2", heardText: "", interrupted: true });
        yield* orch.processSignal(started.conversationId, { kind: "turn_metrics", turnId: "t2", ttsTtfbMs: 390, ttsAudioMs: 0, ttsChars: 45 });
        yield* outbox.runOnce(20, now);
        return yield* scores.listForConversation(started.conversationId);
      })),
    );

    // Sorted by turn then name, because the read path chooses its own order.
    const tts = out.filter((r) => r.name.startsWith("tts.")).sort((a, b) => `${a.turnId}${a.name}`.localeCompare(`${b.turnId}${b.name}`));
    expect(tts.every((r) => r.source === "SYSTEM")).toBe(true);
    expect(tts.map((r) => [r.name, r.turnId, r.value])).toEqual([
      // 60 characters over 4 s of audio.
      ["tts.chars_per_second", "t1", 15],
      ["tts.silent_playout", "t1", 0],
      // No rate for turn 2: it never played, which is what its silent_playout already says.
      ["tts.silent_playout", "t2", 1],
    ]);
    expect(out.filter((r) => r.source === "EVALUATOR").every((r) => r.turnId === null)).toBe(true);
  });

  it("persists the SLO verdict per call, and withholds it from a call that measured nothing", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const wf = yield* WorkflowService;
          const orch = yield* Orchestrator;
          const outbox = yield* OutboxService;
          const scores = yield* Scores;

          // Each call is driven to a close first, because the EVALUATION job is only enqueued at
          // finalize; the components are written onto the turn rows afterwards but before `runOnce`.
          const slow = yield* seedBorrower("Slow Voice", "+15550004001");
          const slowCall = yield* wf.startCall({ borrowerId: slow.borrowerId, contactPointId: slow.cpId, channel: "voice", now: NOW });
          yield* orch.processTurn({ conversationId: slowCall.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${slowCall.conversationId}`;

          const fast = yield* seedBorrower("Fast Voice", "+15550004002");
          const fastCall = yield* wf.startCall({ borrowerId: fast.borrowerId, contactPointId: fast.cpId, channel: "voice", now: NOW });
          yield* orch.processTurn({ conversationId: fastCall.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 400, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${fastCall.conversationId}`;

          // The orchestrator's decide TTFT is stripped so this call has measured nothing at all.
          const sim = yield* seedBorrower("Simulated Only", "+15550004003");
          const simCall = yield* wf.startCall({ borrowerId: sim.borrowerId, contactPointId: sim.cpId, channel: "simulated", now: NOW });
          yield* orch.processTurn({ conversationId: simCall.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          yield* sql`UPDATE conversation_turns SET result = result - 'ttftMs' WHERE conversation_id = ${simCall.conversationId}`;

          yield* outbox.runOnce(50, NOW);
          return {
            slow: yield* scores.listForConversation(slowCall.conversationId),
            fast: yield* scores.listForConversation(fastCall.conversationId),
            sim: yield* scores.listForConversation(simCall.conversationId),
          };
        }),
      ),
    );

    const slo = (rows: ReadonlyArray<{ name: string; value: number; comment: string | null; source: string }>) => rows.find((r) => r.name === "latency.slo_pass");

    const breached = slo(out.slow);
    expect(breached?.value).toBe(0);
    expect(breached?.source).toBe("EVALUATOR");
    expect(breached?.comment).toContain("eou_delay_ms");

    expect(slo(out.fast)?.value).toBe(1);

    // Nothing measured is not a pass.
    expect(slo(out.sim)).toBeUndefined();
  });

  it("flags a call whose first line skipped the Mini-Miranda", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(Effect.gen(function* () {
        const { borrowerId, cpId } = yield* seedBorrower("Undisclosed Person", "+15550003002");
        const sql = yield* PgClient.PgClient;
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const outbox = yield* OutboxService;
        const scores = yield* Scores;
        const q = yield* Queries;
        const now = NOW;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now });
        // The disclosure is dropped straight in the ledger, which is where the evaluator reads it.
        yield* sql`UPDATE conversation_events SET payload = jsonb_set(payload, '{text}', '"Hi, is Jordan there?"')
                   WHERE conversation_id = ${started.conversationId} AND type = 'AGENT_TURN'`;
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
        yield* outbox.runOnce(20, now);
        const rows = yield* scores.listForConversation(started.conversationId);
        const jobs = yield* q.outboxJobsFor(started.conversationId);
        return { rows, evaluation: jobs.find((j) => j.jobType === "EVALUATION")! };
      })),
    );
    const miniMiranda = out.rows.find((r) => r.name === "compliance.mini_miranda_first")!;
    expect(miniMiranda.value).toBe(0);
    expect(miniMiranda.comment).toContain("FDCPA");
    expect(out.evaluation.result["issues"]).toEqual(["MINI_MIRANDA_MISSING"]);
    expect(out.evaluation.result["compliance_ok"]).toBe(false);
  });
});
