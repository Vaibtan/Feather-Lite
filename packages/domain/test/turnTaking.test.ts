/**
 * The six turn-taking numbers, over synthetic event tables (spec 2026-08-30, D4).
 *
 * The definitions come from FireRedChat (2509.06502) and τ-Voice (2603.13686); the spec's Testing
 * Decisions name the shape of the fixture: "a call with two backchannels and one real interruption
 * yields the expected six numbers". Every case below is hand-computable from its own table, which
 * is the point — a metric nobody can compute by hand is a metric nobody can dispute.
 *
 * Every agent stretch states its playout truth (`truncated`), because that — not a time window —
 * is what says whether the borrower's noise stopped the agent (spec 2026-09-01, Phase C0). The
 * helper takes it as a required argument for the same reason: a fixture that does not say is a
 * fixture whose expectations cannot be derived.
 *
 * Milliseconds from the start of the call throughout.
 */
import { describe, expect, it } from "vitest";
import { bargeInT90, turnTakingMetrics, type AgentSpeech, type BorrowerEvent } from "../src/turnTaking.js";

const line = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "line", label, startMs, endMs });
const backchannel = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "backchannel", label, startMs, endMs });
const noise = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "noise", label, startMs, endMs });
const thirdParty = (label: string, startMs: number, endMs: number): BorrowerEvent => ({ kind: "third_party", label, startMs, endMs });
const agent = (startMs: number, endMs: number, truncated: boolean): AgentSpeech => ({ startMs, endMs, truncated });

describe("turnTakingMetrics", () => {
  it("computes all six over the spec's own fixture: two backchannels and one real interruption", () => {
    // The agent speaks three times. The borrower backchannels twice into the first line (ignored,
    // as it should be), interrupts the second for real (the agent yields after 400 ms), and speaks
    // a plain line at the end which the agent answers.
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

    // Two borrower lines. The first is an interruption and is not separately "answered"; the second
    // is answered by the agent's third stretch.
    expect(m.response_rate).toBe(0.5);
    // One real interruption, yielded within the 2 s window.
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(400);
    // Two backchannels, neither of which stopped the agent — the first stretch played in full.
    expect(m.false_interrupt_rate).toBe(0);
    // The agent never started speaking inside a borrower line.
    expect(m.agent_interrupt_rate).toBe(0);
    // Both non-directed events correctly ignored.
    expect(m.selectivity).toBe(1);
    expect(m.counts).toEqual({ lines: 2, interruptions: 1, non_directed: 2, non_directed_during_agent_speech: 2 });
  });

  it("counts an agent that stops for a backchannel as a false interrupt, and as lost selectivity", () => {
    // The failure the spec's D1 `resume` exists for: a "mm-hm" pauses the agent for up to the
    // 2 s false-interruption timer.
    const m = turnTakingMetrics({
      borrower: [backchannel("mm-hm", 1_000, 1_200)],
      agent: [agent(0, 1_100, true)],
    });
    expect(m.false_interrupt_rate).toBe(1);
    expect(m.selectivity).toBe(0);
    // A backchannel is not an interruption, so it must not appear in the yield numbers at all.
    expect(m.yield_rate).toBeNull();
    expect(m.yield_latency_ms).toBeNull();
  });

  it("does not blame a backchannel for a line that ended by itself two seconds later", () => {
    // The case a time window cannot express, and the whole reason `truncated` is required. The two
    // halves are the same table down to the millisecond; only the playout truth differs, and it is
    // the playout truth that decides. Under a 2 s window both halves book a false interrupt,
    // because 4 000 − 2 000 lands on the bound exactly.
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
    // The agent was cut off — by the borrower's real line at 3 000, the latest thing she did inside
    // that stretch. The "mm-hm" two seconds earlier did not stop it and must not be charged for it.
    const m = turnTakingMetrics({
      borrower: [backchannel("mm-hm", 1_000, 1_150), line("actually wait", 3_000, 3_800)],
      agent: [agent(0, 3_400, true)],
    });
    expect(m.false_interrupt_rate).toBe(0);
    expect(m.counts.non_directed_during_agent_speech).toBe(1);
    // The same stretch is a clean yield: truncated, and silent 400 ms after the line's onset.
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(400);
  });

  it("credits an answer to a line the agent stopped for, and not the next line after one it spoke through", () => {
    // Two ways an agent stretch can follow a borrower event, and only one of them is a reply.
    // Playout truth separates them here too: if the agent was stopped *by* this event, what it says
    // next answers it; if it carried on to its own last word, its next line is its own turn
    // continuing, and calling that "answering the mm-hm" costs the agent its selectivity for
    // speech it correctly ignored.
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
    // "Still Between Us?" (2604.17358): the semantic shortcut is answering speech that was not
    // addressed to you. The agent was not interrupted here — it simply replied to a third party.
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
      // Starts inside the borrower's line: the agent talked over her.
      agent: [agent(2_000, 5_000, false)],
    });
    expect(m.agent_interrupt_rate).toBe(1);

    const interrupted = turnTakingMetrics({
      borrower: [line("actually wait", 2_000, 3_000)],
      // Started before the line: this is the agent being interrupted, not interrupting.
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
    // No yield, so no latency to report — not a zero, which would read as instant.
    expect(m.yield_latency_ms).toBeNull();
  });

  it("calls an interruption unyielded when the agent finished the line regardless", () => {
    // Silence 400 ms after the barge-in, but the line played in full: the agent reached its last
    // word and stopped, which is not the same as making way. A window alone reads this as a fast
    // yield and flatters the agent on exactly the turn it ignored the borrower.
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
    // 200, 800, 900 -> median 800.
    expect(m.yield_rate).toBe(1);
    expect(m.yield_latency_ms).toBe(800);
  });

  it("reports null rather than zero for anything with no denominator", () => {
    // The repo's rule everywhere else: "no calls were made" and "no call reached a person" are
    // different findings, and a rate of 0 says the second.
    const empty = turnTakingMetrics({ borrower: [], agent: [] });
    expect(empty.response_rate).toBeNull();
    expect(empty.yield_rate).toBeNull();
    expect(empty.yield_latency_ms).toBeNull();
    expect(empty.false_interrupt_rate).toBeNull();
    expect(empty.agent_interrupt_rate).toBeNull();
    expect(empty.selectivity).toBeNull();
  });

  it("does not credit a reply that belongs to the next line", () => {
    // The agent said nothing to the first line; the borrower spoke again and *that* was answered.
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
    // FireRedChat's definition: ms of user speech until 90 % of true barge-ins are honoured.
    //
    // 900, not 1 000: every percentile in this repo is nearest-rank without interpolation (O1,
    // `percentile.ts`), so p90 of ten samples is rank ceil(0.9 × 10) = 9 — the ninth value. The
    // ten-sample case is here precisely because it is where an off-by-one rank shows, and an
    // interpolating p90 would name a duration no barge-in actually took. Do not "fix" this back to
    // 1 000 without changing `percentile.ts`, which the SLO gate reads too.
    expect(bargeInT90([100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000])).toBe(900);
    expect(bargeInT90([200, 200, 200, 200])).toBe(200);
  });

  it("has no value with nothing to measure", () => {
    expect(bargeInT90([])).toBeNull();
  });
});
