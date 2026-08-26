/**
 * Protected-context leak test at the provider boundary (plan rev.2 R12): drive a call through the
 * real orchestrator with the OpenAI decider and a recording LLM client, then assert on the exact
 * request bodies: nothing protected before RIGHT_PARTY_CONFIRMED, everything needed after.
 *
 * This is the one place that asserts on **every** request body leaving this system for a model, so
 * the post-call judge is checked here too (spec 2026-08-26, D3). The judge is a second model that
 * reads the whole finished call, which makes it the obvious place for account data to escape by
 * accident: the borrower here is verified, so the *decider's* later prompts legitimately carry the
 * balance, and only the judge's input distinguishes "what the borrower was told" from "what the
 * system knows". The judge's behaviour is tested in `judgeJob.test.ts`; what is tested here is the
 * request body.
 */
import { Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationRepo,
  IdGen,
  NoopTracingLive,
  OpenAITurnDeciderLive,
  Orchestrator,
  OutboxService,
  Queries,
  RecordingLlmClient,
  SchedulingRepo,
  Scores,
  ScoresRepo,
  WorkflowService,
  FROZEN_NOW,
  type LlmDelta,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

// A "well-behaved model": clarifies once, confirms identity, proposes, confirms.
const rec = RecordingLlmClient((i, req): ReadonlyArray<LlmDelta> => {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (/who is this/i.test(lastUser)) return [{ _tag: "Content", text: "This is Ava from Feather-Lite Collections. Am I speaking with Jordan?" }, { _tag: "Finish", reason: "stop", usage: null }];
  if (/yes.*jordan|speaking/i.test(lastUser)) return [{ _tag: "ToolCallStart", index: 0, id: `c${i}`, name: "confirm_right_party" }, { _tag: "ToolCallArgs", index: 0, argsFragment: '{"confirmed":true}' }, { _tag: "Finish", reason: "tool_calls", usage: null }];
  if (/pay 550/i.test(lastUser)) return [{ _tag: "ToolCallStart", index: 0, id: `c${i}`, name: "propose_promise_to_pay" }, { _tag: "ToolCallArgs", index: 0, argsFragment: '{"amount":"550.00","date":"2026-08-21"}' }, { _tag: "Finish", reason: "tool_calls", usage: null }];
  if (/^yes$/i.test(lastUser.trim())) return [{ _tag: "ToolCallStart", index: 0, id: `c${i}`, name: "record_promise_to_pay" }, { _tag: "ToolCallArgs", index: 0, argsFragment: '{"confirmed":true}' }, { _tag: "Finish", reason: "tool_calls", usage: null }];
  return [{ _tag: "Content", text: "Could you say that again?" }, { _tag: "Finish", reason: "stop", usage: null }];
},
// The judge's reply. Its content does not matter here — what is under test is the request.
() =>
  JSON.stringify({
    task_completion: { pass: true, rationale: "promise recorded", evidence: "\"550 dollars\"" },
    compliance: { pass: true, rationale: "disclosure first", evidence: "\"attempt to collect a debt\"" },
    factual_accuracy: { pass: true, rationale: "matches", evidence: "\"550 dollars\"" },
    empathy_professionalism: { pass: true, rationale: "calm", evidence: "\"of course\"" },
    escalation_judgment: { pass: true, rationale: "nothing raised", evidence: "" },
    overall_pass: true,
    confidence: 0.9,
  }));

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
).pipe(
  Layer.provide(OpenAITurnDeciderLive.pipe(Layer.provide(rec.layer), Layer.provide(NoopTracingLive))),
  // The same recording client for the judge, so both models this system talks to are recorded in
  // one place; `provide` over the infra layer's refusing client.
  Layer.provide(rec.layer),
  Layer.provideMerge(makeInfraLayer({ judge: { enabled: true, model: "gpt-5.6-luna", reasoningEffort: "medium", maxTokens: 4000 } })),
);
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("LLM request bodies never carry protected context before verification", () => {
  it("full happy path through the OpenAI decider with a scripted provider", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550003001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 })}`;
        const wf = yield* WorkflowService;
        const orch = yield* Orchestrator;
        const q = yield* Queries;
        const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
        const say = (turnId: string, text: string) => orch.processTurn({ conversationId: started.conversationId, turnId, userText: text }, () => Effect.void);
        yield* say("t1", "who is this?");
        yield* say("t2", "yes this is Jordan");
        yield* say("t3", "I can pay 550 on Friday");
        const last = yield* say("t4", "yes");
        const detail = yield* q.conversationDetail(started.conversationId);
        return { last, detail };
      }),
    );
    expect(out.last.outcome).toBe("PROMISE_TO_PAY");
    expect(out.detail.replay.statePath).toEqual(["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME", "ENDING", "COMPLETED"]);

    const requests = rec.requests.map((r) => r.request);
    expect(requests).toHaveLength(4);
    const [r1, r2, r3, r4] = requests as [typeof requests[0], typeof requests[0], typeof requests[0], typeof requests[0]];
    // Before verification (t1: GREETING, t2: VERIFYING_IDENTITY):
    for (const r of [r1, r2]) {
      const body = JSON.stringify(r);
      expect(body).not.toMatch(/550\.00|Jordan Avery|DELINQUENT|2026-08-01/);
      expect(body).toContain("ACCOUNT: not available in this state");
      const tools = r.tools.map((t) => t.name);
      expect(tools).not.toContain("propose_promise_to_pay");
      expect(tools).not.toContain("record_promise_to_pay");
      expect(tools).not.toContain("get_account_context");
      expect(tools).toContain("confirm_right_party");
    }
    // After verification (t3: DISCUSSING_PAYMENT, t4: CONFIRMING_OUTCOME):
    expect(JSON.stringify(r3)).toContain("balance due 550.00");
    expect(r3.tools.map((t) => t.name)).toContain("propose_promise_to_pay");
    expect(r4.tools.map((t) => t.name)).toContain("record_promise_to_pay");
    expect(JSON.stringify(r4)).toContain("pay 550.00 on 2026-08-21");
    // Model text is never the confirmation: the agent's confirmation line came from the ledger.
    expect(out.detail.transcript.some((t) => t.speaker === "AGENT" && /recorded your promise to pay 550 dollars/.test(t.text))).toBe(true);
    // The model was told the state each time.
    expect(JSON.stringify(r1)).toContain("CURRENT STATE: GREETING");
    expect(JSON.stringify(r2)).toMatch(/CURRENT STATE: (GREETING|VERIFYING_IDENTITY)/);
    // Empty-arg tools get a proper object schema.
    expect(r1.tools.find((t) => t.name === "lookup_contact_profile")?.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(JSON.stringify(r3)).toContain("CURRENT STATE: DISCUSSING_PAYMENT");
    expect(JSON.stringify(r4)).toContain("CURRENT STATE: CONFIRMING_OUTCOME");
  });

  it("the post-call judge sees the call, not the account behind it", async () => {
    // D3: "the judge prompt must never receive protected account data beyond what the transcript
    // already contains". The call above ended in a promise, so its outbox is armed; run it.
    // Real clock, not FROZEN_NOW: the call above ran on the wall clock, so its jobs are due now.
    // Claiming with the frozen time would find nothing due and quietly assert on an empty list.
    const processed = await rt.runPromise(Effect.flatMap(OutboxService, (o) => o.runOnce(20)));
    expect(processed.filter((j) => j.jobType === "JUDGE").map((j) => j.status)).toEqual(["DONE"]);

    const judged = rec.completions.map((c) => c.request);
    expect(judged).toHaveLength(1);
    const body = JSON.stringify(judged[0]);

    // The loan facts the decider was legitimately given after verification. None of them reach the
    // judge: it is told what was said, and the ledger facts the evaluator derived, and nothing else.
    expect(body).not.toContain("10000.00");
    expect(body).not.toContain("DELINQUENT");
    expect(body).not.toContain("2026-08-01");
    // Nor the decider's prompt, which would smuggle the whole account block in with it.
    expect(body).not.toContain("CURRENT STATE:");
    expect(body).not.toContain("ACCOUNT:");
    expect(body).not.toContain("RULES:");
    // It does get the conversation, which is the point of having a judge at all.
    expect(body).toContain("PROMISE_TO_PAY");
    expect(body).toContain("Am I speaking with Jordan?");
  });
});
