import { Chunk, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EMPTY_MEMORY } from "@feather-lite/domain";
import {
  AppConfigTest,
  NoopTracingLive,
  OpenAITurnDeciderLive,
  RecordingLlmClient,
  TurnDecider,
  buildMessages,
  toolSpecsFor,
  type DeciderInput,
  type LlmDelta,
} from "../../src/index.js";

const input = (over: Partial<DeciderInput> = {}): DeciderInput => ({
  conversationId: "c1",
  turnId: "t1",
  state: "GREETING",
  userText: "yes this is Jordan",
  heardAgentText: null,
  context: {
    publicContext: { agent_name: "Ava", company: "Feather-Lite Collections", callback_number: "+1 800 555 0100", workflow_type: "PAYMENT_REMINDER", attempt_no: 1, local_time_description: "Sunday 2:00 PM EDT", borrower_first_name: "Jordan" },
    protectedContext: null,
    memory: null,
  },
  allowedTools: ["lookup_contact_profile", "confirm_right_party", "record_wrong_party_contact"],
  pendingProposal: null,
  recentTranscript: [{ speaker: "AGENT", text: "May I please speak with Jordan?" }, { speaker: "BORROWER", text: "yes this is Jordan" }],
  model: "gpt-test",
  borrowerLocalDate: "2026-08-16",
  borrowerTimeZone: "America/New_York",
  borrowerFirstName: "Jordan",
  ...over,
});

const run = (script: ReadonlyArray<LlmDelta>, i: DeciderInput) => {
  const rec = RecordingLlmClient(() => script);
  const layer = OpenAITurnDeciderLive.pipe(Layer.provide(rec.layer), Layer.provide(NoopTracingLive), Layer.provide(AppConfigTest()));
  const program = Effect.gen(function* () {
    const d = yield* TurnDecider;
    const chunks = yield* Stream.runCollect(d.decide(i));
    return { chunks: Chunk.toReadonlyArray(chunks), requests: rec.requests };
  });
  return Effect.runPromise(program.pipe(Effect.provide(layer), Effect.either));
};

describe("OpenAITurnDecider — two-mode streaming", () => {
  it("chat mode: content deltas stream through, then a Decision without a tool", async () => {
    const r = await run(
      [{ _tag: "Content", text: "Before I continue, " }, { _tag: "Content", text: "is this Jordan?" }, { _tag: "Finish", reason: "stop", usage: { promptTokens: 100, completionTokens: 8, cachedTokens: 0 } }],
      input({ userText: "who is this" }),
    );
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.chunks.map((c) => c._tag)).toEqual(["TextDelta", "TextDelta", "Decision"]);
      const dec = r.right.chunks.at(-1);
      expect(dec?._tag === "Decision" && dec.decision.message).toBe("Before I continue, is this Jordan?");
      expect(dec?._tag === "Decision" && dec.decision.toolCall).toBeNull();
    }
  });

  it("tool mode: a tool call first suppresses any prose and yields a Decision with the tool", async () => {
    const r = await run(
      [
        { _tag: "ToolCallStart", index: 0, id: "call_1", name: "confirm_right_party" },
        { _tag: "ToolCallArgs", index: 0, argsFragment: '{"confirmed":' },
        { _tag: "Content", text: "Great, I've recorded that." }, // must be discarded
        { _tag: "ToolCallArgs", index: 0, argsFragment: "true}" },
        { _tag: "Finish", reason: "tool_calls", usage: null },
      ],
      input(),
    );
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.chunks.map((c) => c._tag)).toEqual(["Decision"]);
      const dec = r.right.chunks[0];
      expect(dec?._tag === "Decision" && dec.decision.toolCall).toEqual({ name: "confirm_right_party", args: { confirmed: true }, toolCallId: "call_1" });
    }
  });

  it("pseudo-tools become state suggestions", async () => {
    const r = await run(
      [{ _tag: "ToolCallStart", index: 0, id: null, name: "renegotiate" }, { _tag: "ToolCallArgs", index: 0, argsFragment: '{"reason":"wants a smaller amount"}' }, { _tag: "Finish", reason: "tool_calls", usage: null }],
      input({ state: "CONFIRMING_OUTCOME", allowedTools: ["record_promise_to_pay", "schedule_callback"] }),
    );
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      const dec = r.right.chunks[0];
      expect(dec?._tag === "Decision" && dec.decision.suggestedNextState).toBe("DISCUSSING_PAYMENT");
      expect(dec?._tag === "Decision" && dec.decision.toolCall).toBeNull();
    }
  });

  it("malformed tool arguments and empty completions are named failures", async () => {
    const bad = await run([{ _tag: "ToolCallStart", index: 0, id: null, name: "propose_promise_to_pay" }, { _tag: "ToolCallArgs", index: 0, argsFragment: "{not json" }, { _tag: "Finish", reason: "tool_calls", usage: null }], input({ state: "DISCUSSING_PAYMENT", allowedTools: ["propose_promise_to_pay"] }));
    expect(bad._tag === "Left" && bad.left._tag).toBe("TurnDeciderInvalidOutput");
    const empty = await run([{ _tag: "Finish", reason: "stop", usage: null }], input());
    expect(empty._tag === "Left" && empty.left._tag).toBe("TurnDeciderInvalidOutput");
  });
});

describe("prompt construction — the request the model actually sees", () => {
  it("before verification: no account data in any message and no protected tools offered", () => {
    const msgs = buildMessages(input());
    const text = msgs.map((m) => m.content).join("\n");
    expect(text).toContain("ACCOUNT: not available in this state");
    expect(text).not.toMatch(/550|balance due \d|Avery/);
    const tools = toolSpecsFor("GREETING", ["lookup_contact_profile", "confirm_right_party", "record_wrong_party_contact"]).map((t) => t.name);
    expect(tools).toContain("confirm_right_party");
    expect(tools).not.toContain("record_promise_to_pay");
    expect(tools).not.toContain("get_account_context");
    expect(tools).toContain("end_call");
  });

  it("after verification: account block present, memory rendered, proposal tools offered", () => {
    const msgs = buildMessages(
      input({
        state: "DISCUSSING_PAYMENT",
        context: {
          publicContext: input().context.publicContext,
          protectedContext: { borrower_full_name: "Jordan Avery", balance_due: "550.00", due_date: "2026-08-01", loan_status: "DELINQUENT", delinquency_days: 15, last_promise_date: null },
          memory: { ...EMPTY_MEMORY, recent_outcomes: ["NO_ANSWER"], prior_conversation_count: 1 },
        },
        allowedTools: ["get_account_context", "propose_promise_to_pay", "schedule_callback"],
      }),
    );
    // Account and memory are volatile, so they live in the trailing block, not the cached prefix.
    const text = msgs.at(-2)!.content;
    expect(text).toContain("balance due 550.00");
    expect(text).toContain("HISTORY: 1 prior call(s); recent outcomes NO_ANSWER");
    expect(toolSpecsFor("DISCUSSING_PAYMENT", ["propose_promise_to_pay"]).map((t) => t.name)).toEqual(["propose_promise_to_pay", "end_call", "request_human"]);
    // Tool JSON schema is derived from the domain schema.
    const spec = toolSpecsFor("DISCUSSING_PAYMENT", ["propose_promise_to_pay"])[0]!;
    expect(JSON.stringify(spec.parameters)).toMatch(/amount/);
    expect(JSON.stringify(spec.parameters)).toMatch(/date/);
  });

  it("interrupted previous line is surfaced to the model", () => {
    const msgs = buildMessages(input({ heardAgentText: "Thank you, Jordan. I'm calling about" }));
    expect(msgs.at(-2)!.content).toContain('they heard only: "Thank you, Jordan. I\'m calling about"');
  });
});

describe("prompt layout is cache-aligned (research §3.1c)", () => {
  const transcript = [
    { speaker: "AGENT" as const, text: "May I please speak with Jordan?" },
    { speaker: "BORROWER" as const, text: "yes this is Jordan" },
    { speaker: "AGENT" as const, text: "Thank you. Your balance is 550 dollars." },
    { speaker: "BORROWER" as const, text: "I can pay on Friday" },
  ];

  it("puts only static instructions first and every volatile field last", () => {
    const msgs = buildMessages(input({ recentTranscript: transcript, userText: "I can pay on Friday" }));
    const first = msgs[0]!;
    expect(first.role).toBe("system");
    // The cached prefix must not carry anything that changes turn to turn.
    expect(first.content).toContain("RULES:");
    expect(first.content).not.toContain("CURRENT STATE");
    expect(first.content).not.toContain("Borrower local time");
    expect(first.content).not.toContain("ACCOUNT");
    // ...and all of it must still reach the model, in the trailing block.
    const volatileBlock = msgs.at(-2)!;
    expect(volatileBlock.role).toBe("system");
    expect(volatileBlock.content).toContain("CURRENT STATE: GREETING");
    expect(volatileBlock.content).toContain("Borrower local time: Sunday 2:00 PM EDT");
    expect(volatileBlock.content).toContain("ACCOUNT: not available in this state");
    // The borrower's current line is spoken once, at the very end.
    expect(msgs.at(-1)).toEqual({ role: "user", content: "I can pay on Friday" });
  });

  it("the prefix before the volatile block only grows as the call proceeds", () => {
    const prefixOf = (msgs: ReadonlyArray<{ role: string; content: string }>) => msgs.slice(0, -2);
    const turn1 = prefixOf(buildMessages(input({ recentTranscript: transcript.slice(0, 2), userText: "yes this is Jordan" })));
    const turn2 = prefixOf(buildMessages(input({ recentTranscript: transcript, userText: "I can pay on Friday" })));
    // Turn 2's prefix starts with turn 1's, byte for byte -- which is what a prefix cache needs.
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(turn2.length).toBeGreaterThan(turn1.length);
  });

  it("does not repeat the current borrower line in the history", () => {
    const msgs = buildMessages(input({ recentTranscript: transcript, userText: "I can pay on Friday" }));
    expect(msgs.filter((m) => m.role === "user" && m.content === "I can pay on Friday")).toHaveLength(1);
  });
});
