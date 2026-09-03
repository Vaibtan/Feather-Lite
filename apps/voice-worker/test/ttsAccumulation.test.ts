/**
 * The framework emits `metrics_collected` once per synthesised segment and resets `ttfb`,
 * `audioDurationMs` and its start time between them, so a per-event signal reports the last
 * sentence rather than the turn.
 */
import { describe, expect, it, vi } from "vitest";
import { FeatherAgent } from "../src/feather-agent.js";

/** Just enough of the deps to watch what is signalled. */
const makeAgent = () => {
  const signals: Array<Record<string, unknown>> = [];
  const agent = new FeatherAgent({
    conversationId: "c-1",
    client: {
      signal: async (_id: string, body: Record<string, unknown>) => {
        signals.push(body);
        return {} as never;
      },
      providerEvents: async () => undefined,
    },
    log: () => undefined,
    onEndCall: async () => undefined,
  } as never);
  return { agent, signals };
};

/** The framework's three-sentence turn: three events, each describing one sentence. */
const threeSegments = (agent: FeatherAgent) => {
  agent.onTtsMetrics({ ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
  agent.onTtsMetrics({ ttfbMs: 90, audioDurationMs: 900, charactersCount: 30 });
  agent.onTtsMetrics({ ttfbMs: 85, audioDurationMs: 1500, charactersCount: 55 });
};

describe("turn_metrics across a multi-segment turn", () => {
  it("reports the turn's first byte, and its whole audio and characters", async () => {
    const { agent, signals } = makeAgent();
    // `currentTurnId` is private and set by `llmNode`; the turn id is what the accumulator keys on.
    (agent as unknown as { currentTurnId: string | null }).currentTurnId = "t1";
    agent.onEouMetrics({ eouDelayMs: 578, transcriptionDelayMs: 461 });
    threeSegments(agent);

    expect(signals.filter((s) => s["kind"] === "turn_metrics")).toHaveLength(0);

    agent.reportPlayout({ id: "item-1", interrupted: false, textContent: "the whole reply" } as never);
    // The turn reports when it is over, not when an item lands.
    expect(signals.filter((s) => s["kind"] === "turn_metrics")).toHaveLength(0);
    await (agent as unknown as { reportTurnPlayout: (t: string) => Promise<void> }).reportTurnPlayout("t1");
    const metrics = signals.filter((s) => s["kind"] === "turn_metrics");
    expect(metrics).toHaveLength(1);
    // The first segment's TTFB, not 85, the last sentence's.
    expect(metrics[0]?.["tts_ttfb_ms"]).toBe(380);
    expect(metrics[0]?.["tts_audio_ms"]).toBe(3600);
    expect(metrics[0]?.["tts_chars"]).toBe(125);
    expect(metrics[0]?.["eou_delay_ms"]).toBe(578);
    expect(metrics[0]?.["transcription_delay_ms"]).toBe(461);
  });

  it("still reports a turn whose synthesis produced nothing", async () => {
    const { agent, signals } = makeAgent();
    (agent as unknown as { currentTurnId: string | null }).currentTurnId = "t2";
    agent.onEouMetrics({ eouDelayMs: 600 });
    agent.reportPlayout({ id: "item-2", interrupted: false, textContent: "" } as never);
    await (agent as unknown as { reportTurnPlayout: (t: string) => Promise<void> }).reportTurnPlayout("t2");
    const metrics = signals.filter((s) => s["kind"] === "turn_metrics");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.["eou_delay_ms"]).toBe(600);
    expect(metrics[0]?.["tts_ttfb_ms"]).toBeUndefined();
  });
});
