import { describe, expect, it } from "vitest";
import { bargeInT90, turnTakingMetrics, type AgentSpeech, type BorrowerEvent, type TurnTakingEvents } from "../src/turnTaking.js";

const line = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "line", label, startMs, endMs });
const backchannel = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "backchannel", label, startMs, endMs });
const noise = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "noise", label, startMs, endMs });
const thirdParty = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "third_party", label, startMs, endMs });
const agent = (startMs: number, endMs: number, truncated: boolean): AgentSpeech => ({ startMs, endMs, truncated });

describe("turnTakingMetrics", () => {
  it("computes all six over two backchannels and one real interruption", () => {
    const m = turnTakingMetrics({
      borrower: [
        backchannel("mm-hm", 1_000, 1_200),
        backchannel("yeah", 2_000, 2_150),
        line("actually wait", 6_000, 6_800),
        line("I can pay 550 on Friday", 12_000, 14_000),
      ],
      agent: [
        agent(0, 4_000, false), // spoken through both backchannels, and played in full
        agent(5_000, 6_400, true), // interrupted at 6 000, stops at 6 400
        agent(14_500, 16_000, false), // the reply to the last line
      ],
    });

    expect(m.response_rate).toBe(0.5);
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(400);
    expect(m.false_interrupt_rate).toBe(0);
    expect(m.agent_interrupt_rate).toBe(0);
    expect(m.selectivity).toBe(1);
    expect(m.counts).toEqual({ lines: 2, interruptions: 1, non_directed: 2, non_directed_during_agent_speech: 2, unknown_truncation: 0 });
  });

  it("counts an agent that stops for a backchannel as a false interrupt, and as lost selectivity", () => {
    const m = turnTakingMetrics({
      borrower: [backchannel("mm-hm", 1_000, 1_200)],
      agent: [agent(0, 1_100, true)],
    });
    expect(m.false_interrupt_rate).toBe(1);
    expect(m.selectivity).toBe(0);
    expect(m.yield_rate).toBeNull();
    expect(m.yield_latency_ms).toBeNull();
  });

  it("does not blame a backchannel for a line that ended by itself two seconds later", () => {
    /** The two halves are the same table down to the millisecond and only the playout truth differs, which is why `truncated` is required: a 2 s window books a false interrupt on both. */
    const playedInFull = turnTakingMetrics({
      borrower: [backchannel("yeah", 2_000, 2_150)],
      agent: [agent(0, 4_000, false)],
    });
    expect(playedInFull.false_interrupt_rate).toBe(0);
    expect(playedInFull.selectivity).toBe(1);

    const cutShort = turnTakingMetrics({
      borrower: [backchannel("yeah", 2_000, 2_150)],
      agent: [agent(0, 4_000, true)],
    });
    expect(cutShort.false_interrupt_rate).toBe(1);
    expect(cutShort.selectivity).toBe(0);
  });

  it("blames the proximate cause, not every non-directed event in the stretch", () => {
    const m = turnTakingMetrics({
      borrower: [backchannel("mm-hm", 1_000, 1_150), line("actually wait", 3_000, 3_800)],
      agent: [agent(0, 3_400, true)],
    });
    expect(m.false_interrupt_rate).toBe(0);
    expect(m.counts.non_directed_during_agent_speech).toBe(1);
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(400);
  });

  it("credits an answer to a line the agent stopped for, and not the next line after one it spoke through", () => {
    /** Playout truth separates the two: a stretch the agent was stopped by is answered next, one it spoke through is its own turn continuing. */
    const answered = turnTakingMetrics({
      borrower: [line("actually wait", 1_000, 1_800)],
      agent: [agent(0, 1_400, true), agent(2_000, 4_000, false)],
    });
    expect(answered.response_rate).toBe(1);

    const spokenThrough = turnTakingMetrics({
      borrower: [backchannel("mm-hm", 1_000, 1_200)],
      agent: [agent(0, 4_000, false), agent(5_000, 6_400, false)],
    });
    expect(spokenThrough.selectivity).toBe(1);
    expect(spokenThrough.false_interrupt_rate).toBe(0);
  });

  it("does not count a non-directed event the agent spoke straight through", () => {
    const m = turnTakingMetrics({
      borrower: [noise("cough", 1_000, 1_100), thirdParty("who is it", 2_000, 2_500)],
      agent: [agent(0, 5_000, false)],
    });
    expect(m.false_interrupt_rate).toBe(0);
    expect(m.selectivity).toBe(1);
  });

  it("counts a reply to non-directed speech as lost selectivity even with the agent silent", () => {
    const m = turnTakingMetrics({
      borrower: [thirdParty("honey, who is it", 1_000, 2_000)],
      agent: [agent(2_400, 4_000, false)],
    });
    expect(m.false_interrupt_rate).toBeNull(); // none of them happened during agent speech
    expect(m.selectivity).toBe(0);
  });

  it("counts the agent talking over a borrower line, and not its own line being interrupted", () => {
    const m = turnTakingMetrics({
      borrower: [line("I can pay", 1_000, 4_000)],
      agent: [agent(2_000, 5_000, false)],
    });
    expect(m.agent_interrupt_rate).toBe(1);

    const interrupted = turnTakingMetrics({
      borrower: [line("actually wait", 2_000, 3_000)],
      agent: [agent(0, 2_400, true)],
    });
    expect(interrupted.agent_interrupt_rate).toBe(0);
  });

  it("calls an interruption unyielded when the agent talks past the window", () => {
    const m = turnTakingMetrics({
      borrower: [line("actually wait", 1_000, 2_000)],
      agent: [agent(0, 3_500, true)], // cut off, but 2 500 ms after the interruption started
    });
    expect(m.yield_rate).toBe(0);
    expect(m.yield_latency_ms).toBeNull();
  });

  it("calls an interruption unyielded when the agent finished the line regardless", () => {
    const m = turnTakingMetrics({
      borrower: [line("actually wait", 1_000, 2_000)],
      agent: [agent(0, 1_400, false)],
    });
    expect(m.counts.interruptions).toBe(1);
    expect(m.yield_rate).toBe(0);
    expect(m.yield_latency_ms).toBeNull();
  });

  it("takes the median when several interruptions yield at different speeds", () => {
    const m = turnTakingMetrics({
      borrower: [line("a", 1_000, 1_500), line("b", 5_000, 5_500), line("c", 9_000, 9_500)],
      agent: [agent(0, 1_200, true), agent(4_000, 5_800, true), agent(8_000, 9_900, true)],
    });
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(800);
  });

  it("reports null rather than zero for anything with no denominator", () => {
    const empty = turnTakingMetrics({ borrower: [], agent: [] });
    expect(empty.response_rate).toBeNull();
    expect(empty.yield_rate).toBeNull();
    expect(empty.yield_latency_ms).toBeNull();
    expect(empty.false_interrupt_rate).toBeNull();
    expect(empty.agent_interrupt_rate).toBeNull();
    expect(empty.selectivity).toBeNull();
  });

  it("does not credit a reply that belongs to the next line", () => {
    const m = turnTakingMetrics({
      borrower: [line("hello", 1_000, 2_000), line("hello?", 8_000, 9_000)],
      agent: [agent(9_500, 11_000, false)],
    });
    expect(m.response_rate).toBe(0.5);
  });

  it("is not confused by the order events are listed in", () => {
    const ordered = turnTakingMetrics({
      borrower: [line("a", 1_000, 2_000), line("b", 5_000, 6_000)],
      agent: [agent(2_500, 3_000, false), agent(6_500, 7_000, false)],
    });
    const shuffled = turnTakingMetrics({
      borrower: [line("b", 5_000, 6_000), line("a", 1_000, 2_000)],
      agent: [agent(6_500, 7_000, false), agent(2_500, 3_000, false)],
    });
    expect(shuffled).toEqual(ordered);
  });
});

describe("bargeInT90", () => {
  it("is the borrower speech a barge-in needs before nine in ten are honoured", () => {
    /**
     * 900, not 1 000: percentiles here are nearest-rank without interpolation, so p90 of ten samples
     * is rank 9. Do not "fix" this without changing `percentile.ts`, which the SLO gate also reads.
     */
    expect(bargeInT90([100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000])).toBe(900);
    expect(bargeInT90([200, 200, 200, 200])).toBe(200);
  });

  it("has no value with nothing to measure", () => {
    expect(bargeInT90([])).toBeNull();
  });
});

describe("a stretch whose playout is unknown", () => {
  it("is excluded from the rates rather than counted as untruncated", () => {
    /** Booking an unjoined playout as `false` would say the agent was not interrupted, which is a claim the harness cannot make. */
    const events: TurnTakingEvents = {
      borrower: [{ kind: "backchannel", label: "mm-hm", startMs: 1_200, endMs: 1_400 }],
      agent: [{ startMs: 1_000, endMs: 3_000, truncated: null }],
    };
    const m = turnTakingMetrics(events);
    expect(m.false_interrupt_rate).toBeNull();
    expect(m.counts.unknown_truncation).toBe(1);
  });

  it("counts the unknown stretches so a thin denominator is visible", () => {
    const events: TurnTakingEvents = {
      borrower: [{ kind: "line", label: "opening reply", startMs: 0, endMs: 500 }],
      agent: [
        { startMs: 1_000, endMs: 2_000, truncated: null },
        { startMs: 3_000, endMs: 4_000, truncated: false },
        { startMs: 5_000, endMs: 6_000, truncated: null },
      ],
    };
    expect(turnTakingMetrics(events).counts.unknown_truncation).toBe(2);
  });

  it("still reads a known stretch normally", () => {
    const events: TurnTakingEvents = {
      borrower: [{ kind: "line", label: "barge-in", startMs: 1_200, endMs: 1_600 }],
      agent: [{ startMs: 1_000, endMs: 1_500, truncated: true }],
    };
    const m = turnTakingMetrics(events);
    expect(m.counts.unknown_truncation).toBe(0);
    expect(m.yield_rate).not.toBeNull();
  });
});

