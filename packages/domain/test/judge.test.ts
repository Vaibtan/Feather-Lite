/**
 * The LLM judge's pure half (spec 2026-08-26, D3): what it is shown, what it is allowed to return,
 * and what its verdict becomes in the score table. The model call itself is the outbox job's
 * business and is tested against the recording client in `packages/control-plane/test/db`.
 */
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildJudgeInput,
  decodeJudgeVerdict,
  decodeEventRecord,
  JUDGE_DIMENSIONS,
  JUDGE_RATIONALE_MAX,
  JUDGE_RESPONSE_SCHEMA,
  judgePrompt,
  judgeScores,
  type EventRecord,
  type JudgeVerdict,
} from "../src/index.js";

const rec = (sequence_no: number, type: string, payload: Record<string, unknown>): EventRecord => {
  const decoded = decodeEventRecord({ sequence_no, created_at: `2026-08-26T10:00:${String(sequence_no).padStart(2, "0")}.000Z`, type, payload });
  if (Either.isLeft(decoded)) throw new Error(`fixture invalid: ${type} ${JSON.stringify(payload)}`);
  return decoded.right;
};

const dimension = (pass: boolean) => ({ pass, rationale: "because of the thing", evidence: "\"a quoted span\"" });
const verdict = (overrides: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
  task_completion: dimension(true),
  compliance: dimension(true),
  factual_accuracy: dimension(true),
  empathy_professionalism: dimension(true),
  escalation_judgment: dimension(true),
  overall_pass: true,
  confidence: 0.8,
  ...overrides,
});

describe("JUDGE_RESPONSE_SCHEMA", () => {
  // OpenAI's strict structured output rejects a schema that leaves any property optional or lets
  // extra ones through. Getting this wrong is a 400 at request time, on a path that only runs
  // post-call — so it is pinned here rather than discovered in production.
  const walk = (node: Record<string, unknown>): void => {
    if (node["type"] !== "object") return;
    const properties = node["properties"] as Record<string, Record<string, unknown>>;
    expect(node["additionalProperties"]).toBe(false);
    expect([...(node["required"] as string[])].sort()).toEqual(Object.keys(properties).sort());
    for (const child of Object.values(properties)) walk(child);
  };

  it("requires every property at every level and forbids extras", () => {
    walk(JUDGE_RESPONSE_SCHEMA);
  });

  it("asks for exactly the five dimensions the rubric names", () => {
    const properties = Object.keys(JUDGE_RESPONSE_SCHEMA["properties"] as Record<string, unknown>);
    expect(properties.filter((p) => p !== "overall_pass" && p !== "confidence").sort()).toEqual([...JUDGE_DIMENSIONS].sort());
  });
});

describe("decodeJudgeVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const out = decodeJudgeVerdict(verdict());
    expect(Either.isRight(out)).toBe(true);
  });

  it("rejects a verdict missing a dimension, rather than scoring the ones that arrived", () => {
    // A partial verdict is not a partial opinion — the model may have failed halfway through, and
    // four dimensions with a silent fifth would read on the page as "the fifth was not applicable".
    const { compliance, ...partial } = verdict();
    expect(Either.isLeft(decodeJudgeVerdict(partial))).toBe(true);
  });

  it("rejects a confidence outside 0..1", () => {
    expect(Either.isLeft(decodeJudgeVerdict(verdict({ confidence: 1.5 })))).toBe(true);
  });

  it("rejects a pass that is not a boolean, however plausible the string", () => {
    expect(Either.isLeft(decodeJudgeVerdict({ ...verdict(), overall_pass: "true" }))).toBe(true);
  });

  it("rejects prose where a verdict was asked for", () => {
    expect(Either.isLeft(decodeJudgeVerdict("The call went well overall."))).toBe(true);
  });

  it("keeps a long rationale by clamping it, rather than failing the whole verdict", () => {
    // The schema asks for 200 characters. A model that overshoots has still done the work, and
    // throwing away five dimensions over a long sentence would be the wrong trade.
    const long = "x".repeat(JUDGE_RATIONALE_MAX + 50);
    const out = decodeJudgeVerdict(verdict({ compliance: { pass: false, rationale: long, evidence: "\"quote\"" } }));
    expect(Either.isRight(out)).toBe(true);
    if (Either.isRight(out)) expect(out.right.compliance.rationale.length).toBeLessThanOrEqual(JUDGE_RATIONALE_MAX);
  });
});

describe("buildJudgeInput", () => {
  const events: ReadonlyArray<EventRecord> = [
    rec(1, "CALL_STARTED", { workflow_execution_id: "w", call_attempt_id: "a", contact_point_id: "c", channel: "voice", attempt_no: 1 }),
    rec(2, "AGENT_TURN", { text: "This is an attempt to collect a debt. Is this Jordan?", state: "GREETING", turn_id: "t1" }),
    rec(3, "USER_TURN_FINAL", { text: "yes speaking", turn_id: "t1" }),
    rec(4, "STATE_TRANSITION", { from: "GREETING", to: "VERIFYING_IDENTITY", triggered_by: "RIGHT_PARTY_CONFIRMED" }),
    rec(5, "AGENT_TURN", { text: "Your balance is 550 dollars.", state: "DISCUSSING_PAYMENT", turn_id: "t2" }),
    rec(6, "AGENT_TURN_PLAYOUT", { turn_id: "t2", heard_text: "Your balance is", interrupted: true }),
    rec(7, "TOOL_RESULT", { name: "record_promise_to_pay", tool_call_id: "x", ok: true, result: { amount: "550.00" } }),
  ];

  it("shows the judge what the borrower heard, not what was generated", () => {
    // A barged-in line the borrower never heard the end of cannot be held against the agent, and
    // cannot be credited to it either. The transcript already prefers heard text; the judge sees
    // the same thing the console does.
    const input = buildJudgeInput(events);
    const agentLines = input.transcript.filter((t) => t.speaker === "AGENT").map((t) => t.text);
    expect(agentLines).toContain("Your balance is");
    expect(agentLines).not.toContain("Your balance is 550 dollars.");
  });

  it("carries the state path, the tools that ran and the outcome, so the judge does not re-derive them", () => {
    const input = buildJudgeInput(events);
    expect(input.state_path).toEqual(["VERIFYING_IDENTITY"]);
    expect(input.tools).toEqual([{ name: "record_promise_to_pay", ok: true }]);
  });

  it("contains nothing but what the ledger already holds", () => {
    // D3: "Not the raw prompt, not account context beyond the transcript." The judge must not
    // become a second path by which protected account data leaves the system, so the input is
    // assembled from events alone — there is no parameter through which context could arrive.
    const serialized = JSON.stringify(buildJudgeInput(events));
    expect(serialized).not.toContain("prompt");
    expect(buildJudgeInput.length).toBe(2);
  });
});

describe("judgePrompt", () => {
  const input = buildJudgeInput([
    rec(1, "AGENT_TURN", { text: "This is an attempt to collect a debt.", state: "GREETING", turn_id: "t1" }),
    rec(2, "USER_TURN_FINAL", { text: "ok", turn_id: "t1" }),
  ]);

  it("asks for evidence before the verdict and warns against the friendly wrong call", () => {
    const system = judgePrompt(input)[0]!.content.toLowerCase();
    expect(system).toContain("evidence");
    // The failure mode this judge exists to catch: a call that sounded warm and achieved nothing.
    expect(system).toMatch(/polite|friendly|warm|fluen/);
  });

  it("puts the call in the user message and the rubric in the system one", () => {
    const messages = judgePrompt(input);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toContain("attempt to collect a debt");
  });
});

describe("judgeScores", () => {
  it("writes one score per dimension plus the overall verdict, each carrying its evidence", () => {
    const scores = judgeScores("c1", verdict({ compliance: { pass: false, rationale: "no disclosure", evidence: "\"Hi, is Jordan there?\"" } }));
    const byName = new Map(scores.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([
      "judge.compliance",
      "judge.empathy_professionalism",
      "judge.escalation_judgment",
      "judge.factual_accuracy",
      "judge.overall_pass",
      "judge.task_completion",
    ]);
    expect(scores.every((s) => s.source === "JUDGE" && s.turnId === null)).toBe(true);
    expect(byName.get("judge.compliance")!.value).toBe(0);
    expect(byName.get("judge.compliance")!.comment).toBe("no disclosure");
    // The quote is what makes a verdict checkable in seconds, so it is structured, not prose.
    expect(byName.get("judge.compliance")!.evidence).toEqual({ quote: "\"Hi, is Jordan there?\"" });
  });

  it("keeps the judge's confidence beside the overall verdict rather than as a metric of its own", () => {
    const scores = judgeScores("c1", verdict({ confidence: 0.4 }));
    expect(scores.find((s) => s.name === "judge.overall_pass")!.evidence).toMatchObject({ confidence: 0.4 });
  });
});
