/**
 * A turn can speak several times: the reply the framework builds from `delta` frames, plus one item
 * per `say`. Each is a segment the control plane named, and each reports its own playout.
 *
 * The fake `say()` mirrors 1.6.4's `ttsTask`, which inserts the assistant item and emits
 * `conversation_item_added` but never calls `speechHandle._itemAdded` — so nothing on a `say` handle
 * can stamp its item, and the binding has to come from the speech that is playing.
 */
import { describe, expect, it } from "vitest";
import { FeatherAgent } from "../src/feather-agent.js";

type Frame = Record<string, unknown>;

const say = (segmentId: string, text: string, allowInterruptions = false): Frame => ({ type: "say", segment_id: segmentId, text, allow_interruptions: allowInterruptions });
const turnEnd = (): Frame => ({ type: "turn_end", new_state: "CONFIRMING_OUTCOME", agent_text: "", tool_called: null, call_control_action: null, outcome: null, end_call: false, degraded: false, ttft_ms: 10 });

const makeAgent = (turns: ReadonlyArray<ReadonlyArray<Frame>>) => {
  const signals: Array<Record<string, unknown>> = [];
  const speeches: Array<{ id: string; text: string }> = [];
  let turnNo = 0;
  let speechNo = 0;
  const agent = new FeatherAgent({
    conversationId: "c-1",
    client: {
      signal: async (_id: string, body: Record<string, unknown>) => {
        signals.push(body);
        return {} as never;
      },
      providerEvents: async () => undefined,
      turn: async function* () {
        for (const f of turns[turnNo++] ?? []) yield f as never;
      },
    },
    log: () => undefined,
    onEndCall: async () => undefined,
  } as never);
  Object.defineProperty(agent, "session", {
    value: {
      say: (text: string) => {
        speechNo += 1;
        const id = `speech_${String(speechNo)}`;
        speeches.push({ id, text });
        return { id, waitForPlayout: async () => undefined };
      },
    },
  });
  /** The framework's id for the speech that said a line, which is all the worker binds a segment by. */
  const speechSaying = (text: string) => speeches.find((s) => s.text === text)?.id ?? "";
  return { agent, signals, speechSaying };
};

const chatCtx = (userText: string) => ({ items: [{ type: "message", role: "user", textContent: userText }] }) as never;

const runTurn = async (agent: FeatherAgent, userText: string, replySpeechId?: string) => {
  if (replySpeechId !== undefined) agent.noteSpeechCreated("generate_reply", { id: replySpeechId, waitForPlayout: async () => undefined });
  const stream = await agent.llmNode(chatCtx(userText), {} as never, {} as never);
  if (stream === null) return;
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
};

const playouts = (signals: Array<Record<string, unknown>>) => signals.filter((s) => s["kind"] === "playout");

/** Synthesis finished, then the item arrived: the order the framework produces them in. */
const spoke = (agent: FeatherAgent, speechId: string, text: string, interrupted = false) => {
  if (!interrupted) agent.onTtsMetrics(speechId, { ttfbMs: 380, audioDurationMs: 1200, charactersCount: text.length });
  agent.reportPlayout(speechId, { textContent: text, interrupted } as never);
};

const READ_BACK = "To confirm: you will pay 550 dollars.";

describe("which segment a spoken item belongs to", () => {
  it("books an item to the segment that asked for it, not the turn that happens to be current", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("seg-read-back", READ_BACK), turnEnd()], [turnEnd()]]);
    await runTurn(agent, "I can pay 550 on Friday");
    const readBackSpeech = speechSaying(READ_BACK);

    // The borrower says "yes" over the read-back and the next turn claims the call before the
    // read-back's item is delivered.
    await runTurn(agent, "yes");
    spoke(agent, readBackSpeech, READ_BACK);

    const p = playouts(signals);
    expect(p).toHaveLength(1);
    expect(p[0]?.["segment_id"]).toBe("seg-read-back");
    expect(p[0]?.["heard_text"]).toBe(READ_BACK);
    expect(p[0]?.["interrupted"]).toBe(false);
  });

  it("reports every segment it spoke, once each, rather than one concatenation", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("seg-1", "Thank you."), say("seg-2", READ_BACK), turnEnd()]]);
    await runTurn(agent, "yes this is Jordan");
    spoke(agent, speechSaying("Thank you."), "Thank you.");
    spoke(agent, speechSaying(READ_BACK), READ_BACK);

    const p = playouts(signals);
    expect(p.map((s) => s["segment_id"])).toEqual(["seg-1", "seg-2"]);
    expect(p.map((s) => s["heard_text"])).toEqual(["Thank you.", READ_BACK]);
    expect(p.every((s) => s["interrupted"] === false)).toBe(true);
  });

  it("names the model reply after its turn, which is the segment the control plane gave it", async () => {
    const { agent, signals } = makeAgent([[{ type: "delta", text: "I understand." }, turnEnd()]]);
    await runTurn(agent, "I lost my job", "speech_reply");
    spoke(agent, "speech_reply", "I understand.");

    const p = playouts(signals);
    expect(p).toHaveLength(1);
    expect(p[0]?.["segment_id"]).toBe(p[0]?.["turn_id"]);
    expect(p[0]?.["heard_text"]).toBe("I understand.");
  });

  it("keeps the truncated text of a segment the borrower talked over", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("seg-1", READ_BACK), turnEnd()]]);
    await runTurn(agent, "I can pay 550 on Friday");
    agent.onTtsMetrics(speechSaying(READ_BACK), { ttfbMs: 380, audioDurationMs: 900, charactersCount: 20 });
    spoke(agent, speechSaying(READ_BACK), "To confirm: you will", true);


    const p = playouts(signals);
    expect(p[0]?.["heard_text"]).toBe("To confirm: you will");
    expect(p[0]?.["interrupted"]).toBe(true);
  });

  it("reports nothing for a speech no segment owns, which is what the opening and a nudge are", async () => {
    const { agent, signals } = makeAgent([[turnEnd()]]);
    await runTurn(agent, "hello");
    spoke(agent, "speech_nudge", "Are you still there?");
    expect(playouts(signals)).toHaveLength(0);
  });
});

describe("a segment whose TTS produced nothing", () => {
  it("is reported unheard, so the guard repeats the read-back", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("seg-1", READ_BACK), turnEnd()]]);
    await runTurn(agent, "I can pay 550 on Friday");
    // Deliberately no `onTtsMetrics`: the item claims it played and no audio was ever synthesised.
    agent.reportPlayout(speechSaying(READ_BACK), { textContent: READ_BACK, interrupted: false } as never);

    const p = playouts(signals);
    expect(p[0]?.["heard_text"]).toBe("");
    expect(p[0]?.["interrupted"]).toBe(true);
  });
});

describe("a turn that ends the call", () => {
  it("waits for its reply's item before tearing down, rather than reporting it unheard", async () => {
    const endsCall = (): Frame => ({ ...turnEnd(), outcome: "PROMISE_TO_PAY", end_call: true });
    const { agent, signals } = makeAgent([[{ type: "delta", text: "Thank you. Goodbye." }, endsCall()]]);
    // The reply speech resolves its playout only once the framework has delivered the item.
    let deliver: () => void = () => undefined;
    const played = new Promise<void>((resolve) => {
      deliver = () => {
        spoke(agent, "speech_reply", "Thank you. Goodbye.");
        resolve();
      };
    });
    agent.noteSpeechCreated("generate_reply", { id: "speech_reply", waitForPlayout: () => played });
    const stream = await agent.llmNode(chatCtx("yes"), {} as never, {} as never);
    const reader = stream === null ? null : stream.getReader();
    if (reader !== null) for (;;) if ((await reader.read()).done) break;
    // `end_call` on the frame has already started the teardown; the item arrives only after that.
    // A tear-down that did not wait for the reply would have reported it unheard by now.
    setTimeout(deliver, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    const p = playouts(signals);
    expect(p).toHaveLength(1);
    expect(p[0]?.["heard_text"]).toBe("Thank you. Goodbye.");
    expect(p[0]?.["interrupted"]).toBe(false);
  });
});

describe("a segment the framework never delivered an item for", () => {
  it("is reported unheard when the call ends, rather than left as evidence that never arrives", async () => {
    const { agent, signals } = makeAgent([[say("seg-1", READ_BACK), turnEnd()]]);
    await runTurn(agent, "I can pay 550 on Friday");
    await agent.endCall("completed");

    const p = playouts(signals);
    expect(p).toHaveLength(1);
    expect(p[0]?.["segment_id"]).toBe("seg-1");
    expect(p[0]?.["heard_text"]).toBe("");
    expect(p[0]?.["interrupted"]).toBe(true);
  });
});
