/**
 * Turn-taking, as six numbers (spec 2026-08-30, D4).
 *
 * "It talks over people" is the complaint this file turns into a measurement. The definitions are
 * FireRedChat's (2509.06502) and τ-Voice's (2603.13686), chosen over the richer alternatives
 * because they are simple enough to compute by hand from the table below — and a metric nobody can
 * recompute by hand is a metric nobody can dispute.
 *
 * Pure, and here rather than in the harness, because these are the numbers a phase is judged on and
 * the harness is the thing being judged. The inputs are what the harness already observes: agent
 * audio onset and offset from the RMS detector, borrower line boundaries from the script, and the
 * kind of each borrower event from the seeded turn-taking table.
 *
 * **The distinction the whole file rests on** is between speech that is a bid for the turn and
 * speech that is not. A `line` is a bid; a `backchannel` ("mm-hm"), a `noise` (a cough) and a
 * `third_party` ("honey, who is it") are not. An agent that stops for a bid is yielding, which is
 * correct; an agent that stops for anything else is being interrupted by nothing, which is the
 * two seconds of dead air D1 exists to remove.
 *
 * **Causation comes from the ledger, never from a clock** (spec 2026-09-01, Phase C0). Whether the
 * agent *stopped for* something is read off {@link AgentSpeech.truncated} — the playout truth ADR
 * 0008 established for "heard" — and only the promptness of the stop is a window. Inferring it from
 * proximity instead cannot separate "stopped because of the backchannel" from "the line ended two
 * seconds later anyway", and on this spec's own fixture it books the second as the first.
 *
 * Every rate is `null` when its denominator is zero, following the same rule as the funnel: "no
 * calls were made" and "no call reached a person" are different findings, and 0 says the second.
 */
import { percentile } from "./percentile.js";

/**
 * Whether a piece of borrower audio was a bid for the turn.
 *
 * `line` is; the rest are not. `noise` and `third_party` are kept apart from `backchannel` even
 * though they count together here, because the simulator's scenarios are named after them and a
 * failure that only happens on third-party speech is a different bug from one that happens on a
 * cough (2604.17358).
 */
export type BorrowerEventKind = "line" | "backchannel" | "noise" | "third_party";

/** One thing the borrower's side of the call did, in milliseconds from the start of the call. */
export interface BorrowerEvent {
  readonly kind: BorrowerEventKind;
  /** The scripted label, so a failing metric names the line it failed on. */
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A stretch of agent audio, as the RMS onset detector sees it: energy in, energy out. */
export interface AgentSpeech {
  readonly startMs: number;
  readonly endMs: number;
  /**
   * Whether the stretch was cut off, or reached its last word — the playout truth, not a guess.
   *
   * Required, and required for the same reason the 2026-08-23 playout work exists at all: energy
   * going out of the RMS detector cannot tell "stopped because the borrower spoke" from "the line
   * simply ended". The harness supplies it from `AGENT_TURN_PLAYOUT.interrupted` on the ledger,
   * joined to the stretch by time the way `harness-scores.ts` joins its per-turn scores — by
   * `started_at`, bounded by the next measurement's instant. There is no default: a caller that
   * does not know whether the agent was interrupted cannot be given a false-interrupt rate,
   * because every rule below turns on this flag.
   */
  readonly truncated: boolean;
}

export interface TurnTakingEvents {
  readonly borrower: readonly BorrowerEvent[];
  readonly agent: readonly AgentSpeech[];
}

/**
 * How long the agent may keep talking after a real interruption and still count as having yielded.
 *
 * A promptness bound only. It never decides *whether* the agent was stopped — {@link
 * AgentSpeech.truncated} decides that — because a window alone cannot tell a yield from a line that
 * happened to end soon afterwards, and on the spec's own fixture it gets that wrong.
 */
export const YIELD_WINDOW_MS = 2_000;

export interface TurnTakingMetrics {
  /** Borrower lines the agent answered. */
  readonly response_rate: number | null;
  /** Real interruptions after which the agent's audio stopped inside {@link YIELD_WINDOW_MS}. */
  readonly yield_rate: number | null;
  /** Median milliseconds from the interruption's onset to the agent falling silent, over the yields. */
  readonly yield_latency_ms: number | null;
  /** Non-directed events during agent speech that stopped it. The agent should not have stopped. */
  readonly false_interrupt_rate: number | null;
  /** Borrower lines the agent started talking over. */
  readonly agent_interrupt_rate: number | null;
  /** Non-directed events the agent neither yielded to nor answered. */
  readonly selectivity: number | null;
  /** The denominators, so a rate is never read without knowing how thin it is. */
  readonly counts: {
    readonly lines: number;
    readonly interruptions: number;
    readonly non_directed: number;
    readonly non_directed_during_agent_speech: number;
  };
}

const rate = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)));

export const turnTakingMetrics = (events: TurnTakingEvents): TurnTakingMetrics => {
  const borrower = [...events.borrower].sort((a, b) => a.startMs - b.startMs);
  const agent = [...events.agent].sort((a, b) => a.startMs - b.startMs);

  const lines = borrower.filter((e) => e.kind === "line");
  const nonDirected = borrower.filter((e) => e.kind !== "line");

  /** The agent stretch a borrower event landed in the middle of, if any. */
  const interrupted = (e: BorrowerEvent): AgentSpeech | undefined => agent.find((s) => s.startMs <= e.startMs && e.startMs < s.endMs);

  /**
   * What stopped a stretch of agent audio: the last thing the borrower's side did while it was
   * still playing. Causation runs backwards from the cut, not forwards from the noise — a "mm-hm"
   * early in a line the borrower later interrupted for real did not stop it, and charging it for
   * that is how a backchannel gets blamed for a barge-in.
   */
  const proximateCause = (speech: AgentSpeech): BorrowerEvent | undefined =>
    [...borrower].reverse().find((e) => speech.startMs <= e.startMs && e.startMs < speech.endMs);

  /**
   * The agent's reply to a borrower event: speech that begins after the event and before the
   * borrower says anything else. Without that upper bound a silent turn borrows the next turn's
   * reply and the response rate reads 1.0 on a call the agent sat out.
   */
  const nextBorrowerStart = (e: BorrowerEvent): number => borrower.find((b) => b.startMs > e.startMs)?.startMs ?? Number.POSITIVE_INFINITY;
  const replyTo = (e: BorrowerEvent): AgentSpeech | undefined => {
    const during = interrupted(e);
    // The agent was already mid-line when this happened, and finished that line: whatever it says
    // next is its own turn continuing, not an answer. Without this an agent that correctly speaks
    // straight through a "mm-hm" is booked as having answered it and loses its selectivity for the
    // one thing it got right. When the line *was* cut off by this event, what follows does answer
    // it — the same playout truth, applied to the other direction.
    if (during !== undefined && !(during.truncated && proximateCause(during) === e)) return undefined;
    return agent.find((s) => s.startMs >= e.endMs && s.startMs < nextBorrowerStart(e));
  };

  /**
   * A real interruption: a bid for the turn made while the agent was already speaking. A line that
   * begins in silence is a turn, not an interruption, and belongs only to the response rate.
   */
  const interruptions = lines.flatMap((l) => {
    const speech = interrupted(l);
    return speech === undefined ? [] : [{ line: l, speech }];
  });
  /**
   * A yield: an interruption the agent actually stopped for, promptly. Both halves are load-bearing
   * — an untruncated stretch that happens to end 400 ms after the barge-in is the agent finishing
   * its line over her, which is the failure, not the success.
   */
  const yields = interruptions.flatMap(({ line, speech }) => {
    const latency = speech.endMs - line.startMs;
    return speech.truncated && latency <= YIELD_WINDOW_MS ? [latency] : [];
  });

  const duringAgentSpeech = nonDirected.filter((e) => interrupted(e) !== undefined);

  /**
   * A false interrupt: a stretch the playout says was cut off, whose proximate cause was not a bid
   * for the turn. An untruncated stretch produces none however much happened during it, and a
   * truncated one produces at most the single event that ended it.
   */
  const falseInterrupts = [
    ...new Set(
      agent.flatMap((speech) => {
        if (!speech.truncated) return [];
        const cause = proximateCause(speech);
        return cause !== undefined && cause.kind !== "line" ? [cause] : [];
      }),
    ),
  ];

  /**
   * Selectivity is over *every* non-directed event, not only the ones during agent speech: an agent
   * that answers a third party it was not talking over has still failed to ignore it, and that is
   * the compliance failure, not a latency one.
   */
  const ignored = nonDirected.filter((e) => !falseInterrupts.includes(e) && replyTo(e) === undefined);

  /** The agent began speaking inside a borrower line — it talked over her rather than waiting. */
  const talkedOver = lines.filter((l) => agent.some((s) => l.startMs < s.startMs && s.startMs < l.endMs));

  return {
    response_rate: rate(lines.filter((l) => replyTo(l) !== undefined).length, lines.length),
    yield_rate: rate(yields.length, interruptions.length),
    yield_latency_ms: yields.length === 0 ? null : Math.round(percentile(yields, 50) ?? 0),
    false_interrupt_rate: rate(falseInterrupts.length, duringAgentSpeech.length),
    agent_interrupt_rate: rate(talkedOver.length, lines.length),
    selectivity: rate(ignored.length, nonDirected.length),
    counts: {
      lines: lines.length,
      interruptions: interruptions.length,
      non_directed: nonDirected.length,
      non_directed_during_agent_speech: duringAgentSpeech.length,
    },
  };
};

/**
 * The barge-in `T90` (FireRedChat, 2509.06502): the milliseconds of borrower speech a barge-in needs
 * before nine in ten of them are honoured.
 *
 * Fed from an interrupt-offset sweep rather than from one call — a single call yields one sample,
 * and a 90th percentile of one number is that number. Kept separate from
 * {@link turnTakingMetrics} for exactly that reason: it is a property of the sweep, not of a call,
 * and putting it beside the six would invite it to be quoted from a single run.
 */
export const bargeInT90 = (speechMsBeforeYield: readonly number[]): number | null =>
  speechMsBeforeYield.length === 0 ? null : Math.round(percentile(speechMsBeforeYield, 90) ?? 0);
