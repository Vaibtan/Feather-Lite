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
  const providerEvents: Array<Record<string, unknown>> = [];
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
      providerEvents: async (events: ReadonlyArray<Record<string, unknown>>) => {
        providerEvents.push(...events);
      },
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
  return { agent, signals, providerEvents, speechSaying: (text: string) => speeches.find((s) => s.text === text)?.id ?? "" };
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
    await runTurn(agent, "yes this is Jordan", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 578, transcriptionDelayMs: 461 });

    const first = speechSaying("Thank you.");
    const second = speechSaying("To confirm.");
    agent.onTtsMetrics(first, { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    agent.onTtsMetrics(second, { ttfbMs: 90, audioDurationMs: 900, charactersCount: 30 });
    agent.onTtsMetrics(second, { ttfbMs: 85, audioDurationMs: 1500, charactersCount: 55 });

    agent.reportPlayout(first, { textContent: "Thank you.", interrupted: false } as never);
    agent.reportPlayout(second, { textContent: "To confirm.", interrupted: false } as never);
    await settle();
    // Its segments have all reported, and its numbers are still open: the end-of-utterance reading
    // arrives after the reply does, so a turn is only complete once another begins or the call ends.
    expect(metrics(signals)).toHaveLength(0);

    await agent.endCall("completed");
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

  it("completes a turn when the next one begins, rather than holding everything until the call ends", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()], [say("s2", "Two."), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 579 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await settle();
    expect(metrics(signals)).toHaveLength(0);

    // No `endCall`: starting the second turn is what completes the first, so a long call reports as
    // it goes instead of losing every turn if the room is torn down first.
    await runTurn(agent, "second", "speech_reply_2");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(579);
  });

  it("still reports a turn whose synthesis produced nothing", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), turnEnd()]]);
    await runTurn(agent, "yes", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 600 });
    agent.reportPlayout(speechSaying("Thank you."), { textContent: "", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(600);
    expect(m[0]?.["tts_ttfb_ms"]).toBeUndefined();
  });

  it("reports a turn that said nothing at all, which is what a wait is", async () => {
    const { agent, signals } = makeAgent([[turnEnd()]]);
    await runTurn(agent, "hold on, let me get my card", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 512, transcriptionDelayMs: 400 });
    await agent.endCall("completed");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(512);
  });

  it("carries the detector's own end-of-turn decision, taken at the pause that committed the turn", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), turnEnd()]]);
    // The detector predicts at every pause; the last before the turn is the one it acted on.
    agent.onEotPrediction({ probability: 0.31, threshold: 0.15, inferenceMs: 24 });
    agent.onEotPrediction({ probability: 0.87, threshold: 0.15, inferenceMs: 21 });
    await runTurn(agent, "yes this is Jordan", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 578 });
    agent.reportPlayout(speechSaying("Thank you."), { textContent: "Thank you.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_probability"]).toBe(0.87);
    expect(m[0]?.["eou_threshold"]).toBe(0.15);
    expect(m[0]?.["eou_inference_ms"]).toBe(21);
  });

  it("does not give a turn a prediction the detector made after that turn was committed", async () => {
    // The two instruments arrive on opposite sides of `llmNode` and are routed accordingly: the
    // prediction is made at the pause that ends the borrower's turn, so one that lands afterwards
    // belongs to whatever the borrower says next.
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()], [say("s2", "Two."), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 500 });
    agent.onEotPrediction({ probability: 0.87, threshold: 0.15, inferenceMs: 21 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await runTurn(agent, "second", "speech_reply_2");
    agent.onEouMetrics("speech_reply_2", { eouDelayMs: 512 });
    agent.reportPlayout(speechSaying("Two."), { textContent: "Two.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(2);
    expect(m[0]?.["eou_probability"]).toBeUndefined();
    expect(m[1]?.["eou_probability"]).toBe(0.87);
  });

  it("gives an end-of-utterance reading to the turn whose reply speech it names", async () => {
    // The framework emits the reading after `llmNode` has already minted the turn it belongs to, so
    // snapshotting it when the turn began gave every turn the previous turn's number and the last
    // turn none at all. It names the reply speech, which is what places it.
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()], [say("s2", "Two."), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 579, transcriptionDelayMs: 521 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await runTurn(agent, "second", "speech_reply_2");
    agent.onEouMetrics("speech_reply_2", { eouDelayMs: 401, transcriptionDelayMs: 388 });
    agent.reportPlayout(speechSaying("Two."), { textContent: "Two.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(2);
    expect(m[0]?.["eou_delay_ms"]).toBe(579);
    expect(m[1]?.["eou_delay_ms"]).toBe(401);
  });


  it("falls back to the open turn for a reading naming a speech it never saw", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()]]);
    await runTurn(agent, "first");
    agent.onEouMetrics("speech_nobody_told_us_about", { eouDelayMs: 444 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    expect(metrics(signals)[0]?.["eou_delay_ms"]).toBe(444);
  });

  it("reports the last turn's numbers when the session closes under the call, not only when the agent ends it", async () => {
    // A borrower who hangs up raises the SDK's Close event; no `end_call` frame ever arrives, so
    // nothing else would ever complete the turn that was open.
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 579, transcriptionDelayMs: 521 });
    agent.onTtsMetrics(speechSaying("One."), { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await settle();
    expect(metrics(signals)).toHaveLength(0);

    await agent.reportPendingTurns();
    await settle();

    const m = metrics(signals);
    expect(m).toHaveLength(1);
    expect(m[0]?.["eou_delay_ms"]).toBe(579);
    expect(m[0]?.["tts_audio_ms"]).toBe(1200);
  });

  it("does not report a turn twice when a late reading arrives for one already completed", async () => {
    // A second report would carry only the late numbers, and the control plane merges the patch key
    // by key: the turn's real delays would be overwritten with nulls.
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "One."), turnEnd()], [say("s2", "Two."), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 579 });
    await runTurn(agent, "second", "speech_reply_2");
    await settle();
    expect(metrics(signals)).toHaveLength(1);

    // The first turn's segment was still queued when its turn completed; its synthesis reports now.
    agent.onTtsMetrics(speechSaying("One."), { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    agent.reportPlayout(speechSaying("One."), { textContent: "One.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    const forFirst = metrics(signals).filter((x) => x["turn_id"] === metrics(signals)[0]?.["turn_id"]);
    expect(forFirst).toHaveLength(1);
    expect(forFirst[0]?.["eou_delay_ms"]).toBe(579);
  });

  it("does not call a turn the borrower talked over silent, however late its synthesis reports", async () => {
    // On a barge-in the framework aborts the TTS stream, so `tts_metrics` land after the truncated
    // item and the segment they name has already closed. Calling that turn silent would post a
    // provider timeout for a voice that worked.
    const { agent, signals, providerEvents, speechSaying } = makeAgent([[say("s1", "Your balance is 550 dollars and"), turnEnd()]]);
    await runTurn(agent, "first", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 579 });
    agent.reportPlayout(speechSaying("Your balance is 550 dollars and"), { textContent: "Your balance is 550", interrupted: true } as never);
    agent.onTtsMetrics(speechSaying("Your balance is 550 dollars and"), { ttfbMs: 872, audioDurationMs: 1400, charactersCount: 30 });
    await agent.endCall("completed");
    await settle();

    const p = signals.filter((x) => x["kind"] === "playout");
    expect(p[0]?.["heard_text"]).toBe("Your balance is 550");
    expect(p[0]?.["interrupted"]).toBe(true);
    expect(providerEvents).toHaveLength(0);
  });

  it("does not count a nudge's audio against the turn before it", async () => {
    const { agent, signals, speechSaying } = makeAgent([[say("s1", "Thank you."), turnEnd()]]);
    await runTurn(agent, "yes", "speech_reply_1");
    agent.onEouMetrics("speech_reply_1", { eouDelayMs: 500 });
    agent.onTtsMetrics(speechSaying("Thank you."), { ttfbMs: 380, audioDurationMs: 1200, charactersCount: 40 });
    // The silence clock's nudge is spoken through a speech no segment owns.
    agent.onTtsMetrics("speech_nudge", { ttfbMs: 120, audioDurationMs: 900, charactersCount: 20 });
    agent.reportPlayout(speechSaying("Thank you."), { textContent: "Thank you.", interrupted: false } as never);
    await agent.endCall("completed");
    await settle();

    expect(metrics(signals)[0]?.["tts_audio_ms"]).toBe(1200);
    expect(metrics(signals)[0]?.["tts_chars"]).toBe(40);
  });
});
