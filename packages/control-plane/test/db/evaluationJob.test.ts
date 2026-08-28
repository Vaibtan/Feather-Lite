/**
 * The EVALUATION outbox job as a score producer (spec 2026-08-26, D2).
 *
 * The facts themselves are proved pure in `packages/domain/test/evaluation.test.ts`; what is worth
 * asserting here is the job's external behaviour on the real seams: the scores that land in the
 * ledger, that a second run corrects them in place rather than doubling them, and that the job
 * result keeps the `issues` / `compliance_ok` shape the console's outbox panel has always read.
 */
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
      // The whole body runs on a frozen clock. `enqueuePostCall` stamps `available_at` from the
      // orchestrator's clock, so pinning only the `startCall` and `runOnce` arguments would leave
      // the jobs due in real time and `runOnce` would claim nothing.
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
        // An opt-out closes the call in one turn, so the ledger is complete and the outbox is armed.
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
        yield* outbox.runOnce(20, now);
        const afterFirst = yield* scores.listForConversation(started.conversationId);
        const jobs = yield* q.outboxJobsFor(started.conversationId);

        // Re-running the evaluator must correct scores in place, never append a second opinion.
        const evaluation = jobs.find((j) => j.jobType === "EVALUATION")!;
        yield* sched.insertOutboxJob({ id: yield* (yield* IdGen).next(), conversationId: started.conversationId, jobType: "EVALUATION", availableAt: DateTime.toDateUtc(now) });
        yield* outbox.runOnce(20, now);
        const afterSecond = yield* scores.listForConversation(started.conversationId);
        return { conversationId: started.conversationId, afterFirst, afterSecond, evaluation };
      })),
    );

    const byName = new Map(out.afterFirst.map((r) => [r.name, r]));
    // Every score the evaluator produces for this call, and nothing else.
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
    // An opt-out never reaches right-party confirmation and records no promise, so the read-back
    // check has nothing to judge and writes no score at all.
    expect(byName.get("call.right_party_verified")!.value).toBe(0);
    expect(byName.has("compliance.no_promise_without_readback")).toBe(false);

    // Job result keeps its historical shape for the console's outbox panel.
    expect(out.evaluation.result["compliance_ok"]).toBe(true);
    expect(out.evaluation.result["issues"]).toEqual([]);
    expect(out.evaluation.result["scores_written"]).toBe(out.afterFirst.length);

    // Second run: same rows, corrected in place.
    expect(out.afterSecond).toHaveLength(out.afterFirst.length);
  });

  it("scores the speech shape the voice worker reported, per turn, beside the ledger's facts", async () => {
    // Spec D5. The path under test is the real one end to end: the worker's `turn_metrics` signal
    // carries the TTS shape, the orchestrator merges it into the turn row, and the EVALUATION job
    // reads it back — none of which the pure `ttsScores` tests can prove.
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
        // A second turn whose synthesis produced nothing: the ADR 0008 failure, reported by the
        // worker as a playout that heard nothing and was cut short.
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "please stop calling me" }, () => Effect.void);
        yield* orch.processSignal(started.conversationId, { kind: "playout", turnId: "t2", heardText: "", interrupted: true });
        yield* orch.processSignal(started.conversationId, { kind: "turn_metrics", turnId: "t2", ttsTtfbMs: 390, ttsAudioMs: 0, ttsChars: 45 });
        yield* outbox.runOnce(20, now);
        return yield* scores.listForConversation(started.conversationId);
      })),
    );

    // Sorted by turn then name: the read path chooses its own order, and which one it picks is not
    // what this test is about.
    const tts = out.filter((r) => r.name.startsWith("tts.")).sort((a, b) => `${a.turnId}${a.name}`.localeCompare(`${b.turnId}${b.name}`));
    expect(tts.every((r) => r.source === "SYSTEM")).toBe(true);
    expect(tts.map((r) => [r.name, r.turnId, r.value])).toEqual([
      // 60 characters over 4 s of audio.
      ["tts.chars_per_second", "t1", 15],
      ["tts.silent_playout", "t1", 0],
      // No rate for turn 2: it never played, which is what its silent_playout already says.
      ["tts.silent_playout", "t2", 1],
    ]);
    // The evaluator's own scores are unaffected and still call-level.
    expect(out.filter((r) => r.source === "EVALUATOR").every((r) => r.turnId === null)).toBe(true);
  });

  it("persists the SLO verdict per call, and withholds it from a call that measured nothing (O6)", async () => {
    // `latency.slo_pass` sat in the closed score vocabulary, typed BOOLEAN, with no producer
    // anywhere in the tree - while `scores.ts` says "an entry here is never a metric nobody emits".
    // Written by the EVALUATION job, which runs post-call when every turn row and its worker-side
    // components exist, so "was this call within SLO" is a historical query and not a page refresh.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const wf = yield* WorkflowService;
          const orch = yield* Orchestrator;
          const outbox = yield* OutboxService;
          const scores = yield* Scores;

          /**
           * Each call is driven to a close first — "please stop calling me" ends it — because the
           * EVALUATION job is only enqueued at finalize. The components are written onto the turn
           * rows afterwards but before `runOnce`, which is the real ordering: the worker's
           * `turn_metrics` signal lands during the call, the job reads the rows after it.
           */
          // A voice call whose end-of-utterance delay is far past target.
          const slow = yield* seedBorrower("Slow Voice", "+15550004001");
          const slowCall = yield* wf.startCall({ borrowerId: slow.borrowerId, contactPointId: slow.cpId, channel: "voice", now: NOW });
          yield* orch.processTurn({ conversationId: slowCall.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${slowCall.conversationId}`;

          // A voice call comfortably inside every target it measured.
          const fast = yield* seedBorrower("Fast Voice", "+15550004002");
          const fastCall = yield* wf.startCall({ borrowerId: fast.borrowerId, contactPointId: fast.cpId, channel: "voice", now: NOW });
          yield* orch.processTurn({ conversationId: fastCall.conversationId, turnId: "t1", userText: "please stop calling me" }, () => Effect.void);
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 400, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${fastCall.conversationId}`;

          // A call with no component measurement at all: never measured, rather than measured and
          // fine. The orchestrator's decide TTFT is stripped to make that the case.
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
    // The comment names the component, so the persisted row says *which* target was missed.
    expect(breached?.comment).toContain("eou_delay_ms");

    expect(slo(out.fast)?.value).toBe(1);

    // Nothing measured is not a pass. A green tick here would be the flattering reading of an
    // absence, which is the whole reason this vocabulary entry existed unfilled.
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
        // Rewrite the opening line in the ledger to drop the disclosure — the same corruption a
        // prompt regression would cause, expressed directly on the events the evaluator reads.
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
