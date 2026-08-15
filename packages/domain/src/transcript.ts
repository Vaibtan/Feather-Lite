/**
 * Transcript and timeline assembly (PRD §5.2.6, SPEC §12.4).
 *
 * Transcripts are never stored as a blob; they are derived from
 * USER_TURN_FINAL / AGENT_TURN events. When the voice runtime reported what
 * the borrower *actually* heard (AGENT_TURN_PLAYOUT after a barge-in), the
 * transcript prefers that text — the ground truth is what was heard, not what
 * was generated.
 */
import type { EventRecord } from "./events.js";

export interface TranscriptEntry {
  readonly speaker: "AGENT" | "BORROWER";
  readonly text: string;
  readonly timestamp: string;
  readonly sequence_no: number;
  /** True when this agent line was cut short by the borrower. */
  readonly interrupted?: boolean;
}

export interface TimelineEntry {
  readonly sequence_no: number;
  readonly type: EventRecord["type"];
  readonly payload: EventRecord["payload"];
  readonly created_at: string;
}

const ordered = (events: ReadonlyArray<EventRecord>): ReadonlyArray<EventRecord> =>
  [...events].sort((a, b) => a.sequence_no - b.sequence_no);

export const buildTranscript = (events: ReadonlyArray<EventRecord>): ReadonlyArray<TranscriptEntry> => {
  const playouts = new Map<string, { heard_text: string; interrupted: boolean }>();
  for (const e of events) {
    if (e.type === "AGENT_TURN_PLAYOUT") playouts.set(e.payload.turn_id, e.payload);
  }
  const out: TranscriptEntry[] = [];
  for (const e of ordered(events)) {
    if (e.type === "USER_TURN_FINAL") {
      out.push({ speaker: "BORROWER", text: e.payload.text, timestamp: e.created_at, sequence_no: e.sequence_no });
    } else if (e.type === "AGENT_TURN") {
      const playout = e.payload.turn_id ? playouts.get(e.payload.turn_id) : undefined;
      const interrupted = playout?.interrupted ?? e.payload.interrupted ?? false;
      out.push({
        speaker: "AGENT",
        text: playout?.interrupted ? playout.heard_text : e.payload.text,
        timestamp: e.created_at,
        sequence_no: e.sequence_no,
        ...(interrupted ? { interrupted: true } : {}),
      });
    }
  }
  return out;
};

export const buildTimeline = (events: ReadonlyArray<EventRecord>): ReadonlyArray<TimelineEntry> =>
  ordered(events).map((e) => ({
    sequence_no: e.sequence_no,
    type: e.type,
    payload: e.payload,
    created_at: e.created_at,
  }));
