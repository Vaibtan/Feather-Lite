/**
 * What the worker knows about the segments it has been told to speak, and nothing else.
 *
 * The control plane names every segment, so attribution is a lookup rather than an inference: a
 * spoken item is resolved to the speech that produced it and from there to the segment the control
 * plane named. A turn that has moved on cannot capture an item that belonged to the last one.
 *
 * Pure and side-effect free: every call returns what should be reported and the caller does the
 * posting, so the whole of this can be tested without a session, a client or a clock.
 */

export interface OpenSegment {
  readonly segmentId: string;
  readonly turnId: string;
  /**
   * The framework's id for the speech that will say it. Null when the seam that reports it is gone,
   * in which case items fall back to the oldest segment still open — the order they are played in.
   */
  readonly speechId: string | null;
}

export interface SegmentPlayout {
  readonly turnId: string;
  readonly segmentId: string;
  readonly heardText: string;
  readonly interrupted: boolean;
}

/** Everything measured for a turn rather than for one of its segments, handed over when it closes. */
export interface TurnMetrics {
  readonly turnId: string;
  readonly eouDelayMs: number | undefined;
  readonly transcriptionDelayMs: number | undefined;
  readonly ttfbMs: number | undefined;
  readonly audioMs: number;
  readonly chars: number;
  /** No audio was synthesised for any segment of this turn. */
  readonly silent: boolean;
}

export interface Closed {
  readonly segments: ReadonlyArray<SegmentPlayout>;
  readonly turns: ReadonlyArray<TurnMetrics>;
}

export interface EouReading {
  readonly eouDelayMs?: number | undefined;
  readonly transcriptionDelayMs?: number | undefined;
}

export interface TtsReading {
  readonly ttfbMs?: number | undefined;
  readonly audioDurationMs?: number | undefined;
  readonly charactersCount?: number | undefined;
}

const NOTHING: Closed = { segments: [], turns: [] };

interface Segment {
  readonly segmentId: string;
  readonly turnId: string;
  readonly speechId: string | null;
  readonly openedAt: number;
  producedAudio: boolean;
}

interface Turn {
  eouDelayMs: number | undefined;
  transcriptionDelayMs: number | undefined;
  ttfbMs: number | undefined;
  audioMs: number;
  chars: number;
  producedAudio: boolean;
  open: number;
  ended: boolean;
}

export class SegmentLedger {
  private readonly segments = new Map<string, Segment>();
  private readonly turns = new Map<string, Turn>();
  private sequence = 0;

  /**
   * The end-of-utterance numbers arrive before the turn they belong to has an id, so they are stamped
   * on when it gets one. A turn that never speaks — a `wait` — still reports them.
   */
  beginTurn(turnId: string, eou: EouReading | null): void {
    const turn = this.turnOf(turnId);
    turn.eouDelayMs = eou?.eouDelayMs;
    turn.transcriptionDelayMs = eou?.transcriptionDelayMs;
  }

  open(segment: OpenSegment): void {
    if (this.segments.has(segment.segmentId)) return;
    this.sequence += 1;
    this.segments.set(segment.segmentId, { ...segment, openedAt: this.sequence, producedAudio: false });
    const turn = this.turnOf(segment.turnId);
    turn.open += 1;
  }

  /**
   * `tts_metrics` fires when a synthesised chunk arrives with `audio.final` — the end of a segment's
   * synthesis — so its absence when the item lands means nothing was ever synthesised for it. Metrics
   * from a speech no segment owns (the opening, a no-input nudge) belong to no turn and are dropped.
   */
  noteTts(speechId: string | null, m: TtsReading): void {
    const segment = this.resolve(speechId);
    if (segment === undefined) return;
    segment.producedAudio = true;
    const turn = this.turnOf(segment.turnId);
    turn.producedAudio = true;
    // First one wins: `ttfbMs` is per segment, and the turn's is its first segment's.
    if (turn.ttfbMs === undefined && m.ttfbMs !== undefined && m.ttfbMs >= 0) turn.ttfbMs = m.ttfbMs;
    turn.audioMs += m.audioDurationMs ?? 0;
    turn.chars += m.charactersCount ?? 0;
  }

  /** The framework delivered a spoken item: that segment is over. */
  deliver(speechId: string | null, item: { readonly text: string; readonly interrupted: boolean }): Closed {
    const segment = this.resolve(speechId);
    if (segment === undefined) return NOTHING;
    /**
     * A stalled TTS stream produces no frames and the framework force-closes the speech, so the item
     * arrives looking fully played. Reporting it unheard is what makes the fully-heard guard repeat a
     * read-back nobody heard. Only checked when the segment was not interrupted: on a barge-in the
     * framework aborts the stream, so the metrics arrive after the truncated item and that item's own
     * text is already the audio truth.
     */
    const silent = !item.interrupted && !segment.producedAudio;
    const playout = this.close(segment, silent ? { text: "", interrupted: true } : item);
    return { segments: [playout], turns: this.closeTurnIfDone(segment.turnId).turns };
  }

  /** `turn_end` has been seen: this turn will not name any more segments. */
  endTurn(turnId: string): Closed {
    this.turnOf(turnId).ended = true;
    return this.closeTurnIfDone(turnId);
  }

  /**
   * Everything still open is over, whether or not the framework ever delivered its item. An
   * undelivered segment is reported unheard, which is the same fail-closed report a stalled one gets.
   */
  drain(exceptTurnId?: string): Closed {
    const stale = [...this.segments.values()].filter((s) => s.turnId !== exceptTurnId).sort((a, b) => a.openedAt - b.openedAt);
    const segments = stale.map((s) => this.close(s, { text: "", interrupted: true }));
    const turns = [...this.turns.keys()].filter((t) => t !== exceptTurnId).flatMap((t) => this.closeTurn(t).turns);
    return { segments, turns };
  }

  private turnOf(turnId: string): Turn {
    const existing = this.turns.get(turnId);
    if (existing !== undefined) return existing;
    const fresh: Turn = { eouDelayMs: undefined, transcriptionDelayMs: undefined, ttfbMs: undefined, audioMs: 0, chars: 0, producedAudio: false, open: 0, ended: false };
    this.turns.set(turnId, fresh);
    return fresh;
  }

  /**
   * By speech id when the framework told us one, else the oldest segment still open: speech is played
   * one at a time in the order it was created, so that is the segment being spoken.
   */
  private resolve(speechId: string | null): Segment | undefined {
    if (speechId !== null) {
      for (const segment of this.segments.values()) if (segment.speechId === speechId) return segment;
      return undefined;
    }
    let oldest: Segment | undefined;
    for (const segment of this.segments.values()) if (oldest === undefined || segment.openedAt < oldest.openedAt) oldest = segment;
    return oldest;
  }

  private close(segment: Segment, heard: { readonly text: string; readonly interrupted: boolean }): SegmentPlayout {
    this.segments.delete(segment.segmentId);
    const turn = this.turnOf(segment.turnId);
    turn.open = Math.max(0, turn.open - 1);
    return { turnId: segment.turnId, segmentId: segment.segmentId, heardText: heard.text, interrupted: heard.interrupted };
  }

  private closeTurnIfDone(turnId: string): Closed {
    const turn = this.turns.get(turnId);
    if (turn === undefined || !turn.ended || turn.open > 0) return NOTHING;
    return this.closeTurn(turnId);
  }

  private closeTurn(turnId: string): Closed {
    const turn = this.turns.get(turnId);
    if (turn === undefined) return NOTHING;
    this.turns.delete(turnId);
    return {
      segments: [],
      turns: [{ turnId, eouDelayMs: turn.eouDelayMs, transcriptionDelayMs: turn.transcriptionDelayMs, ttfbMs: turn.ttfbMs, audioMs: turn.audioMs, chars: turn.chars, silent: !turn.producedAudio }],
    };
  }
}
