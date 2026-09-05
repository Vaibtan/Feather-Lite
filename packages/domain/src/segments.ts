/**
 * A turn speaks in segments, and each is named by the control plane when it is appended. The worker
 * reports playout per segment, so which turn a spoken item belongs to is a fact of the contract
 * rather than something either side infers from what is current.
 */
import type { PayloadOf } from "./events.js";
import type { SpeakMode } from "./events.js";

export interface AgentSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly speakMode: SpeakMode;
}

/**
 * A turn appended before segment ids named none, and it spoke once: its own id is that segment's.
 * A turn with no id of its own — the no-input nudge, the voicemail line — has no segment to name.
 */
export const segmentsOf = (payload: PayloadOf<"AGENT_TURN">): ReadonlyArray<AgentSegment> => {
  const named = payload.segments ?? [];
  if (named.length > 0) return named.map((s) => ({ segmentId: s.segment_id, text: s.text, speakMode: s.speak_mode }));
  if (payload.turn_id === undefined) return [];
  return [{ segmentId: payload.turn_id, text: payload.text, speakMode: payload.speak_mode ?? "interruptible" }];
};

/**
 * The compatibility rule the whole change rests on: a playout row written before segment ids is the
 * turn's single segment, so a replayed conversation reaches the same verdicts it always did. Mirrored
 * in `unreportedNonInterruptible`'s SQL, which cannot share this code.
 */
export const playoutMatchesSegment = (playout: PayloadOf<"AGENT_TURN_PLAYOUT">, segment: { readonly segmentId: string; readonly turnId: string }): boolean =>
  playout.segment_id === undefined ? playout.turn_id === segment.turnId : playout.segment_id === segment.segmentId;
