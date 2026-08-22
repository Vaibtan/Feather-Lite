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

export interface TranscriptOptions {
  /**
   * Drop the borrower line of any turn a barge-in superseded.
   *
   * The orchestrator appends USER_TURN_FINAL in T1, before supersession is detected in T2, and a
   * superseded turn never gets a matching AGENT_TURN. Every superseded turn therefore leaves an
   * orphan borrower line with no reply after it, and under a burst of barge-in the transcript shows
   * several borrower lines in a row -- misleading input for the decider exactly when the call is
   * most chaotic.
   *
   * Off by default: the console's transcript and the outbox summary are a ledger of what was
   * actually said, and the borrower did say those words. Only the prompt-assembly path turns it on.
   */
  readonly excludeSuperseded?: boolean;
}

const ordered = (events: ReadonlyArray<EventRecord>): ReadonlyArray<EventRecord> =>
  [...events].sort((a, b) => a.sequence_no - b.sequence_no);

export const buildTranscript = (events: ReadonlyArray<EventRecord>, options?: TranscriptOptions): ReadonlyArray<TranscriptEntry> => {
  const playouts = new Map<string, { heard_text: string; interrupted: boolean }>();
  const superseded = new Set<string>();
  for (const e of events) {
    if (e.type === "AGENT_TURN_PLAYOUT") playouts.set(e.payload.turn_id, e.payload);
    else if (e.type === "TURN_SUPERSEDED") superseded.add(e.payload.turn_id);
  }
  const out: TranscriptEntry[] = [];
  for (const e of ordered(events)) {
    if (e.type === "USER_TURN_FINAL") {
      if (options?.excludeSuperseded && e.payload.turn_id !== undefined && superseded.has(e.payload.turn_id)) continue;
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
