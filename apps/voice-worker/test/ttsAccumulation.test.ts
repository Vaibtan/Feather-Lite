/**
 * A turn's TTS numbers are the turn's, not its last sentence's (issue #4, W2).
 *
 * `tts/tts.js` in the installed 1.6.4 emits `metrics_collected` when a chunk arrives with
 * `audio.final` — once per synthesised segment — and resets `ttfb`, `audioDurationMs` and
 * `#startedHrTime` between them. The worker posted one `turn_metrics` signal per event and the
 * control plane merges each into the same turn row, so the last segment overwrote the rest:
 * `tts_ttfb_ms` was the time to the *last* sentence's first byte and `tts_chars` was that
 * sentence's length, which made the chars-per-second heuristic a measure of sentence length.
 *
 * The accumulation is exercised through the agent's own two entry points against a recording
 * client, because that is the seam the signal actually leaves by.
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

    // Nothing is posted per segment any more.
    expect(signals.filter((s) => s["kind"] === "turn_metrics")).toHaveLength(0);

    await agent.reportPlayout({ id: "item-1", interrupted: false, textContent: "the whole reply" } as never);
    const metrics = signals.filter((s) => s["kind"] === "turn_metrics");
    expect(metrics).toHaveLength(1);
    // The first segment's TTFB: when the borrower first heard anything. Not 85, the last sentence's.
    expect(metrics[0]?.["tts_ttfb_ms"]).toBe(380);
    // Summed, not last: 1200 + 900 + 1500, and 40 + 30 + 55.
    expect(metrics[0]?.["tts_audio_ms"]).toBe(3600);
    expect(metrics[0]?.["tts_chars"]).toBe(125);
    // The EOU numbers still ride the same signal.
    expect(metrics[0]?.["eou_delay_ms"]).toBe(578);
    expect(metrics[0]?.["transcription_delay_ms"]).toBe(461);
  });

  it("still reports a turn whose synthesis produced nothing", async () => {
    // The turn whose latency an operator most wants to see is the one that failed to speak.
    const { agent, signals } = makeAgent();
    (agent as unknown as { currentTurnId: string | null }).currentTurnId = "t2";
    agent.onEouMetrics({ eouDelayMs: 600 });
    await agent.reportPlayout({ id: "item-2", interrupted: false, textContent: "" } as never);
    const metrics = signals.filter((s) => s["kind"] === "turn_metrics");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.["eou_delay_ms"]).toBe(600);
    expect(metrics[0]?.["tts_ttfb_ms"]).toBeUndefined();
  });
});
