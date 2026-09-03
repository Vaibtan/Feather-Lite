/**
 * The SDK's own resume path, reached early rather than reimplemented: `startFalseInterruptionTimer(0)`
 * re-arms the existing timer for the next tick, so the resume, the `agent_false_interruption` event
 * and the VAD suppression all happen exactly as they would after `falseInterruptionTimeout`.
 * Deliberately run on the final transcript as well as the interim, because a backchannel short
 * enough to matter often produces no interim at all.
 */
import { backchannel } from "@feather-lite/domain";

interface PausableActivity {
  readonly pausedSpeech?: unknown;
  readonly startFalseInterruptionTimer?: (timeoutMs: number) => void;
}

export interface ResumeDecision {
  readonly resume: boolean;
  readonly why: "resumed" | "not-paused" | "not-a-backchannel" | "no-seam";
}

export const shouldResume = (interimText: string, activity: PausableActivity | undefined): ResumeDecision => {
  // A missing seam degrades to a no-op rather than throwing: the SDK's ordinary timer still runs.
  if (activity === undefined || typeof activity.startFalseInterruptionTimer !== "function") return { resume: false, why: "no-seam" };
  if (activity.pausedSpeech === undefined || activity.pausedSpeech === null) return { resume: false, why: "not-paused" };
  if (!backchannel(interimText)) return { resume: false, why: "not-a-backchannel" };
  return { resume: true, why: "resumed" };
};

export const resumeIfBackchannel = (interimText: string, activity: PausableActivity | undefined): boolean => {
  const decision = shouldResume(interimText, activity);
  if (!decision.resume || activity === undefined) return false;
  activity.startFalseInterruptionTimer?.(0);
  return true;
};
