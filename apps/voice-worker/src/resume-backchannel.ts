/**
 * Resume the agent immediately when the borrower was only listening (issue #1, D1's `resume`).
 *
 * The SDK already pauses the agent's audio on a barge-in and, if nothing turns out to have been
 * said, resumes it after `falseInterruptionTimeout` — 2 000 ms here. That timeout is the whole
 * problem: a borrower who says "mm-hm" gets two seconds of dead air in the middle of the agent's
 * sentence, and `turn.false_interrupt_rate` counts it.
 *
 * **D5.2 is why this exists.** The spec made the interim classifier conditional on a measurement:
 * raise `interruption.minDuration` to ~700 ms and see whether the pauses go away. Measured on the
 * simulator's backchannel scenario, they did not — 4 and 2 agent lines cut at 700 ms against 3 and 2
 * at the 500 ms default — so the knob was not the fix and this is owed.
 *
 * The mechanism is the SDK's own resume path, reached early rather than reimplemented:
 * `startFalseInterruptionTimer(0)` re-arms the existing timer to fire on the next tick, so the
 * resume, the `agent_false_interruption` event and the VAD suppression all happen exactly as they
 * would have two seconds later. `session._activity` is the seam the SDK documents for this
 * ("exposed so tightly-coupled internals (e.g. AMD) can reach it").
 *
 * If the interim grows past a backchannel before the final arrives, nothing is done and the
 * interruption proceeds as today — the ordinary timer is still running underneath.
 */
import { backchannel } from "@feather-lite/domain";

/** The bit of `AgentActivity` this needs, named so the coupling is visible and checkable. */
interface PausableActivity {
  readonly pausedSpeech?: unknown;
  readonly startFalseInterruptionTimer?: (timeoutMs: number) => void;
}

export interface ResumeDecision {
  /** Whether to resume the paused speech now. */
  readonly resume: boolean;
  /** Why not, when not — for the log line that makes a missed resume diagnosable. */
  readonly why: "resumed" | "not-paused" | "not-a-backchannel" | "no-seam";
}

/**
 * Decide whether this interim transcript should resume the agent. Pure, so the rule is testable
 * without a session: the caller does the resuming.
 */
export const shouldResume = (interimText: string, activity: PausableActivity | undefined): ResumeDecision => {
  if (activity === undefined || typeof activity.startFalseInterruptionTimer !== "function") return { resume: false, why: "no-seam" };
  // Nothing is paused, so there is nothing to resume — the common case on every ordinary interim.
  if (activity.pausedSpeech === undefined || activity.pausedSpeech === null) return { resume: false, why: "not-paused" };
  if (!backchannel(interimText)) return { resume: false, why: "not-a-backchannel" };
  return { resume: true, why: "resumed" };
};

/**
 * Apply the decision. Returns whether it resumed, so the caller can time it and report `resume` on
 * the next `turn_metrics`.
 */
export const resumeIfBackchannel = (interimText: string, activity: PausableActivity | undefined): boolean => {
  const decision = shouldResume(interimText, activity);
  // `resume: true` implies the seam is there — `shouldResume` returns "no-seam" otherwise — but the
  // narrowing does not survive the function boundary, so it is re-checked rather than asserted away.
  if (!decision.resume || activity === undefined) return false;
  // Zero, not a direct call: re-arming the SDK's own timer keeps the resume, the event it emits and
  // the VAD suppression on exactly the path they would have taken two seconds later.
  activity.startFalseInterruptionTimer?.(0);
  return true;
};
