/**
 * How long a turn waits for a non-interruptible agent segment to finish playing (issue #1, D1 — F2).
 *
 * The defect this exists for: the borrower says "yes" while the promise read-back is still playing.
 * It is transcribed, it commits a turn, the fully-heard guard refuses it because the read-back was
 * not heard in full, and eight seconds of read-back play again — on the turn the borrower was most
 * ready to agree on. Tier 3's `yes-during-read-back` reproduces it on demand and counts two
 * read-backs where one belongs.
 *
 * `held` is a phase **before** T1 and never inside it. Two reasons, and both are load-bearing:
 * holding inside the claim transaction would keep a row locked for the length of a spoken sentence,
 * and the thing being waited for is reported by a *different process* — the voice worker — so the
 * only correct place to observe it is the ledger, which every replica shares. That also rules out an
 * in-process `Deferred` registry: it would be right on one replica and wrong on two.
 *
 * This module is the policy alone, so the numbers are reviewable without reading the plumbing.
 */

/**
 * Added to the remaining audio before giving up.
 *
 * The playout report travels worker -> control plane after the last audio frame, so the segment ends
 * slightly before the evidence that it ended arrives. Waiting exactly the audio length would time
 * out just as the report was landing.
 */
export const HOLD_MARGIN_MS = 400;

/**
 * The ceiling, whatever the segment claims.
 *
 * A wedged or mis-reported segment must not hold a turn open indefinitely: the borrower is waiting,
 * and a turn that starts a little early is a repeated read-back, while a turn that never starts is a
 * dead call.
 */
export const HOLD_MAX_MS = 12_000;

/**
 * Used when the segment's audio length is not known yet — which is the *usual* case during a hold.
 *
 * `tts_audio_ms` reaches the ledger on the `turn_metrics` signal, which the worker sends after the
 * segment finishes. While it is still playing there is nothing to read, so the wait has to be a
 * guess; the longest thing the agent says is the ~8 s read-back, and this is that plus room.
 */
export const HOLD_DEFAULT_MS = 9_000;

export interface HoldInput {
  /** How long the segment's audio was, if the ledger knows yet. */
  readonly ttsAudioMs: number | null;
  /** How long ago the segment started. */
  readonly elapsedMs: number;
  /** Only a voice call has a runtime that reports playout. */
  readonly channel: string;
}

/**
 * How long to keep polling the ledger for this segment's playout report. Zero means do not hold.
 */
export const holdBudgetMs = (input: HoldInput): number => {
  /**
   * The guard that keeps this from breaking every non-voice call.
   *
   * A simulated call has no voice runtime, so no `AGENT_TURN_PLAYOUT` is ever reported and the
   * segment would look unfinished forever: every turn would pay the full budget for a segment that
   * finished the instant it was written.
   */
  if (input.channel !== "voice") return 0;
  // Clock skew between the worker's timestamps and the ledger's is not a reason to skip the hold.
  const elapsed = Math.max(0, input.elapsedMs);
  const total = input.ttsAudioMs === null ? HOLD_DEFAULT_MS : input.ttsAudioMs;
  const remaining = total - elapsed;
  if (remaining <= 0) return 0;
  return Math.min(HOLD_MAX_MS, remaining + HOLD_MARGIN_MS);
};
