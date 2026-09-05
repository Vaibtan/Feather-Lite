/**
 * The framework emits `metrics_collected` once per synthesised segment and resets `ttfb`,
 * `audioDurationMs` and its start time between them, so a per-event signal reports the last
 * sentence rather than the turn. The turn's numbers are the sum over the segments it spoke.
 */
import { describe, expect, it } from "vitest";
import { FeatherAgent } from "../src/feather-agent.js";

type Frame = Record<string, unknown>;
const say = (segmentId: string, text: string): Frame => ({ type: "say", segment_id: segmentId, text, allow_interruptions: false });
const turnEnd = (): Frame => ({ type: "turn_end", new_state: "DISCUSSING_PAYMENT", agent_text: "", tool_called: null, call_control_action: null, outcome: null, end_call: false, degraded: false, ttft_ms: 10 });

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
  return { agent, signals, speechSaying: (text: string) => speeches.find((s) => s.text === text)?.id ?? "" };
};

const chatCtx = (userText: string) => ({ items: [{ type: "message", role: "user", textContent: userText }] }) as never;

const runTurn = async (agent: FeatherAgent, userText: string, replySpeechId?: string) => {
  if (replySpeechId !== undefined) agent.noteSpeechCreated("generate_reply", { id: replySpeechId, waitForPlayout: async () => undefined });
  const stream = await agent.llmNode(chatCtx(userText), {} as never, {} as never);
  if (stream === null) return;
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
};

const metrics = (signals: Array<Record<string, unknown>>) => signals.filter((s) => s["kind"] === "turn_metrics");
/** Reports are posted without being awaited, exactly as on a call; let them land before asserting. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("turn_metrics across a multi-segment turn", () => {
  it("reports the turn's first byte, and its whole audio and characters", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), say("s2", "To confirm."), turnEnd()]]);
    agent.onEouMetrics({ eouDelayMs: 578, transcriptionDelayMs: 461 });
    await runTurn(agent, "yes this is Jordan");

    const first = speechSaying("Thank you.");
    const second = speechSaying("To confirm.");
    agent.onTtsMetrics(first, { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    agent.onTtsMetrics(second, { ttfbMs: 90, audioDurationMs: 900, charactersCount: 30 });
    agent.onTtsMetrics(second, { ttfbMs: 85, audioDurationMs: 1500, charactersCount: 55 });

    agent.reportPlayout(first, { textContent: "Thank you.", interrupted: false } as never);
    await settle();
    // The turn reports when every segment it named is over, not when the first item lands.
    expect(metrics(signals)).toHaveLength(0);
    agent.reportPlayout(second, { textContent: "To confirm.", interrupted: false } as never);
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    // The first segment's TTFB, not 85, the last sentence's.
    expect(m[0]?.["tts_ttfb_ms"]).toBe(380);
    expect(m[0]?.["tts_audio_ms"]).toBe(3600);
    expect(m[0]?.["tts_chars"]).toBe(125);
    expect(m[0]?.["eou_delay_ms"]).toBe(578);
    expect(m[0]?.["transcription_delay_ms"]).toBe(461);
  });

  it("still reports a turn whose synthesis produced nothing", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), turnEnd()]]);
    agent.onEouMetrics({ eouDelayMs: 600 });
    await runTurn(agent, "yes");
    agent.reportPlayout(speechSaying("Thank you."), { textContent: "", interrupted: false } as never);
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(600);
    expect(m[0]?.["tts_ttfb_ms"]).toBeUndefined();
  });

  it("reports a turn that said nothing at all, which is what a wait is", async () => {
    const { agent, signals } = makeAgent([[turnEnd()]]);
    agent.onEouMetrics({ eouDelayMs: 512, transcriptionDelayMs: 400 });
    await runTurn(agent, "hold on, let me get my card");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(512);
  });

  it("does not count a nudge's audio against the turn before it", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), turnEnd()]]);
    agent.onEouMetrics({ eouDelayMs: 500 });
    await runTurn(agent, "yes");
    agent.onTtsMetrics(speechSaying("Thank you."), { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    // The silence clock's nudge is spoken through a speech no segment owns.
    agent.onTtsMetrics("speech_nudge", { ttfbMs: 120, audioDurationMs: 900, charactersCount: 20 });
    agent.reportPlayout(speechSaying("Thank you."), { textContent: "Thank you.", interrupted: false } as never);
    await settle();

    expect(metrics(signals)[0]?.["tts_audio_ms"]).toBe(1200);
    expect(metrics(signals)[0]?.["tts_chars"]).toBe(40);
  });
});
