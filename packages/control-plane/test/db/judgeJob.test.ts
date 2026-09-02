/**
 * The JUDGE outbox job (spec 2026-08-26, D3), on the real seams: a call driven through the real
 * orchestrator, judged by the recording LLM client, and asserted on what reached the ledger.
 *
 * The verdict's *shape* is proved pure in `packages/domain/test/judge.test.ts`. What is worth
 * asserting here is everything the pure tests cannot see: that the request carries the parameters a
 * reasoning model needs and none it rejects, that an unusable verdict is recorded as a broken judge
 * rather than as silence, that the judge is not a second path for account data to escape, and that
 * switching it off leaves no trail of jobs behind.
 */
import { DateTime, Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JudgeVerdict } from "@feather-lite/domain";
import {
  ConversationRepo,
  IdGen,
  Orchestrator,
  OutboxService,
  Queries,
  RecordingLlmClient,
  SchedulingRepo,
  Scores,
  ScoresRepo,
  ScriptedTurnDeciderLive,
  withFrozenClock,
  WorkflowService,
  type LlmDelta,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, playoutOfAgentTurn, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

const dimension = (pass: boolean, rationale: string, evidence: string) => ({ pass, rationale, evidence });
const VERDICT: JudgeVerdict = {
  task_completion: dimension(true, "a promise was recorded and read back", "\"you will pay 550 dollars\""),
  compliance: dimension(false, "the disclosure was not the first thing said", "\"Hi, is Jordan there?\""),
  factual_accuracy: dimension(true, "the amount matches the ledger", "\"550 dollars\""),
  empathy_professionalism: dimension(true, "no pressure applied", "\"whenever suits you\""),
  escalation_judgment: dimension(true, "nothing to escalate", ""),
  overall_pass: false,
  confidence: 0.7,
};

/**
 * The judge's replies, consumed in order. A queue rather than an index so each test can set up its
 * own replies without knowing how many calls the tests before it made; running dry is how a judge
 * that cannot be reached at all is expressed.
 *
 * The stream side is never used: the conversation itself runs on the scripted decider, so every
 * recorded completion is the judge's.
 */
const judgeReplies: Array<string> = [];
const rec = RecordingLlmClient(
  (): ReadonlyArray<LlmDelta> => [],
  () => judgeReplies.shift() ?? null,
);

const judgeOn = Layer.mergeAll(
  Orchestrator.Default,
  WorkflowService.Default,
  OutboxService.Default,
  Queries.Default,
  Scores.Default,
  ScoresRepo.Default,
  ConversationRepo.Default,
  SchedulingRepo.Default,
  IdGen.Default,
).pipe(
  Layer.provide(ScriptedTurnDeciderLive),
  Layer.provide(rec.layer),
  Layer.provideMerge(makeInfraLayer({ judge: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium", maxTokens: 4000 } })),
);
const rt = makeRuntime(judgeOn);

let phone = 7000;
/** Drive one call to a promise to pay, through the real three-phase turn. */
const promiseCall = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    phone += 1;
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555000${phone}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 })}`;
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    const orch = yield* Orchestrator;
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is speaking" }, () => Effect.void);
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
    // The worker reports the read-back it played; without it the fully-heard guard (C1) refuses
    // to record the promise on a voice call, and this fixture is a call that reaches one.
    const playout = yield* playoutOfAgentTurn(started.conversationId, "t2");
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "yes", playout }, () => Effect.void);
    return started.conversationId;
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("JUDGE outbox job", () => {
  it("turns a verdict into one score per dimension, each carrying its quote", async () => {
    judgeReplies.push(JSON.stringify(VERDICT));
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const id = yield* promiseCall("Judged Person");
          yield* (yield* OutboxService).runOnce(20, NOW);
          const rows = yield* (yield* Scores).listForConversation(id);
          const jobs = yield* (yield* Queries).outboxJobsFor(id);
          return { rows, job: jobs.find((j) => j.jobType === "JUDGE")! };
        }),
      ),
    );

    const judge = out.rows.filter((r) => r.source === "JUDGE");
    expect(judge.map((r) => r.name).sort()).toEqual([
      "judge.compliance",
      "judge.empathy_professionalism",
      "judge.escalation_judgment",
      "judge.factual_accuracy",
      "judge.overall_pass",
      "judge.task_completion",
    ]);
    const compliance = judge.find((r) => r.name === "judge.compliance")!;
    expect(compliance.value).toBe(0);
    expect(compliance.comment).toBe("the disclosure was not the first thing said");
    // The quote is what makes a verdict checkable in seconds without relistening to the call.
    expect(compliance.evidence).toEqual({ quote: "\"Hi, is Jordan there?\"" });
    expect(judge.find((r) => r.name === "judge.overall_pass")!.value).toBe(0);
    // Scores are not events: the judge never takes a sequence number.
    expect(judge.every((r) => r.turnId === null)).toBe(true);

    expect(out.job.status).toBe("DONE");
    expect(out.job.result["model"]).toBe("gpt-5.6-luna");
    expect(out.job.result["failed_dimensions"]).toEqual(["compliance"]);
    expect(out.job.result["attempts"]).toBe(1);
  });

  it("asks the model the way a reasoning model must be asked", async () => {
    // Verified against OpenAI's current docs (2026-08-27): `gpt-5.6-luna` is the efficient tier of
    // the GPT-5.6 family and the bare `gpt-5.6` alias routes to Sol, the frontier tier. Reasoning
    // models reject sampling parameters, so the completion request has no temperature to omit.
    const request = rec.completions.at(-1)!.request;
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.reasoningEffort).toBe("medium");
    expect(Object.keys(request)).not.toContain("temperature");
    // Strict structured output: every property required, no extras, at every level.
    expect(request.jsonSchema?.schema["additionalProperties"]).toBe(false);
    expect(request.jsonSchema?.name).toBe("call_verdict");
    // Reasoning tokens are billed against the same budget as the answer, so it is generous.
    expect(request.maxTokens).toBeGreaterThanOrEqual(2000);
  });

  it("shows the judge the call and nothing else about the account", async () => {
    // D3: "Not the raw prompt, not account context beyond the transcript." The judge must not
    // become a second path by which protected data leaves the system.
    const body = JSON.stringify(rec.completions.at(-1)!.request);
    expect(body).not.toContain("DELINQUENT");
    expect(body).not.toContain("2026-08-01");
    expect(body).not.toContain("10000.00");
    // Nor the decider's prompt scaffolding, which would carry the account block with it.
    expect(body).not.toContain("CURRENT STATE:");
    expect(body).not.toContain("ACCOUNT:");
    // It does get the call: the transcript, the states, the outcome.
    expect(body).toContain("attempt to collect a debt");
    expect(body).toContain("PROMISE_TO_PAY");
  });

  it("records a broken judge as a broken judge, not as a call nobody looked at", async () => {
    // Two unusable replies: the model gets one retry, as D3 says. Silence here would show on the
    // Quality page as a call awaiting review, which is a much more reassuring claim than the truth.
    judgeReplies.push("I think the call went quite well overall.", "{\"task_completion\": {\"pass\": true}}");
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const id = yield* promiseCall("Unjudgeable Person");
          yield* (yield* OutboxService).runOnce(20, NOW);
          const rows = yield* (yield* Scores).listForConversation(id);
          const jobs = yield* (yield* Queries).outboxJobsFor(id);
          return { rows, job: jobs.find((j) => j.jobType === "JUDGE")! };
        }),
      ),
    );
    const judge = out.rows.filter((r) => r.source === "JUDGE");
    expect(judge.map((r) => r.name)).toEqual(["judge.invalid_output"]);
    expect(judge[0]!.value).toBe(1);
    // The job itself succeeded: the judge answered, the answer was unusable. Failing the job would
    // spend the retry budget meant for the judge being unreachable, which is a different problem.
    expect(out.job.status).toBe("DONE");
    expect(out.job.result["invalid_output"]).toBe(true);
    expect(out.job.result["attempts"]).toBe(2);
  });

  it("retries the job, rather than recording a verdict, when the judge cannot be reached", async () => {
    // A transport failure is not an opinion. It must leave no score at all and come back later.
    expect(judgeReplies).toEqual([]);
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const id = yield* promiseCall("Unreachable Judge");
          const processed = yield* (yield* OutboxService).runOnce(20, NOW);
          const rows = yield* (yield* Scores).listForConversation(id);
          return { rows, judged: processed.find((p) => p.jobType === "JUDGE")! };
        }),
      ),
    );
    expect(out.judged.status).toBe("PENDING");
    expect(out.rows.filter((r) => r.source === "JUDGE")).toEqual([]);
    // The deterministic jobs are unaffected: a judge outage does not stop the compliance checks.
    expect(out.rows.some((r) => r.source === "EVALUATOR")).toBe(true);
  });
});

describe("JUDGE_ENABLED=false", () => {
  const judgeOff = Layer.mergeAll(
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
  const offRt = makeRuntime(judgeOff);
  afterAll(async () => {
    await offRt.dispose();
  });

  it("enqueues no judge job at all, rather than one that is skipped forever", async () => {
    // A job enqueued and then skipped is indistinguishable on the console from a stuck worker, and
    // every CI run and load run would leave a trail of them.
    const jobs = await offRt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const id = yield* promiseCall("Unjudged Person");
          return yield* (yield* Queries).outboxJobsFor(id);
        }),
      ),
    );
    expect(jobs.map((j) => j.jobType).sort()).toEqual(["EVALUATION", "SUMMARY", "VECTOR_INDEX"]);
  });
});
