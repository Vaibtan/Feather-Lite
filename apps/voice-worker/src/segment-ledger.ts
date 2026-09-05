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
  readonly eot: EotPrediction | undefined;
  readonly ttfbMs: number | undefined;
  readonly audioMs: number;
  readonly chars: number;
  /**
   * No audio was synthesised for any segment of this turn. Never true for a turn the borrower talked
   * over: the framework aborts the stream on a barge-in, so that segment's `tts_metrics` arrive after
   * its truncated item and the segment they belong to has already closed. The item's own text is the
   * audio truth there.
   */
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

/** The detector's own end-of-turn decision at the pause this turn was committed on. */
export interface EotPrediction {
  readonly probability: number;
  readonly threshold: number;
  readonly inferenceMs: number;
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
  /** The framework's id for the speech that answers this turn; the EOU reading names it. */
  replySpeechId: string | null;
  eouDelayMs: number | undefined;
  transcriptionDelayMs: number | undefined;
  eot: EotPrediction | undefined;
  ttfbMs: number | undefined;
  audioMs: number;
  chars: number;
  producedAudio: boolean;
  interrupted: boolean;
}

export class SegmentLedger {
  private readonly segments = new Map<string, Segment>();
  private readonly turns = new Map<string, Turn>();
  private sequence = 0;
  private currentTurnId: string | null = null;

  /**
   * The detector's prediction is made at the pause that ends the borrower's turn, so it is already in
   * hand when the turn gets an id; the end-of-utterance numbers are emitted afterwards, against the
   * reply speech, and arrive through `noteEou`. A turn that never speaks — a `wait` — still reports
   * both.
   */
  beginTurn(turnId: string, replySpeechId: string | null, eot: EotPrediction | null): Closed {
    const turn = this.turnOf(turnId);
    turn.replySpeechId = replySpeechId;
    turn.eot = eot ?? undefined;
    this.currentTurnId = turnId;
    // A turn's own numbers are complete once another turn has started, and not before: the
    // end-of-utterance reading arrives after the reply does, and a turn that never spoke — a
    // `wait` — has no segment whose report could stand for the turn being over.
    return { segments: [], turns: [...this.turns.keys()].filter((t) => t !== turnId).flatMap((t) => this.closeTurn(t).turns) };
  }

  /**
   * Measured on the borrower turn that has just been committed and emitted a moment after the reply
   * speech was created, naming that speech. Only one turn is open at a time, so today the speech id
   * and the open turn agree; the id is used because it is the framework's own answer rather than an
   * inference, and it stays right if that ever stops being true.
   */
  noteEou(speechId: string | null, m: EouReading): void {
    const turn = this.turnForReply(speechId);
    if (turn === undefined) return;
    turn.eouDelayMs = m.eouDelayMs;
    turn.transcriptionDelayMs = m.transcriptionDelayMs;
  }

  private turnForReply(speechId: string | null): Turn | undefined {
    if (speechId !== null) {
      for (const turn of this.turns.values()) if (turn.replySpeechId === speechId) return turn;
    }
    return this.currentTurnId === null ? undefined : this.turns.get(this.currentTurnId);
  }

  open(segment: OpenSegment): void {
    if (this.segments.has(segment.segmentId)) return;
    this.sequence += 1;
    this.segments.set(segment.segmentId, { ...segment, openedAt: this.sequence, producedAudio: false });
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
    // A segment can outlive its turn — a queued or interrupted one still reports its own playout —
    // and a turn that has already been reported must not be recreated to hold a late reading. The
    // control plane merges a `turn_metrics` patch key by key, so a second report for the same turn
    // would overwrite that turn's delays with nulls.
    const turn = this.turns.get(segment.turnId);
    if (turn === undefined) return;
    turn.producedAudio = true;
    // First one wins: `ttfbMs` is per segment, and the turn's is its first segment's.
    if (turn.ttfbMs === undefined && m.ttfbMs !== undefined && m.ttfbMs >= 0) turn.ttfbMs = m.ttfbMs;
    turn.audioMs += m.audioDurationMs ?? 0;
    turn.chars += m.charactersCount ?? 0;
  }

  /** The framework delivered a spoken item: that segment is over and is reported on its own. */
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
    return { segments: [this.close(segment, silent ? { text: "", interrupted: true } : item)], turns: [] };
  }

  /**
   * Everything still open is over, whether or not the framework ever delivered its item. An
   * undelivered segment is reported unheard, which is the same fail-closed report a stalled one gets.
   */
  /**
   * Every turn's numbers, without touching its segments. What an abrupt close can honestly report:
   * a segment nobody delivered an item for is unheard because the call ended, not because the
   * synthesis failed, and reporting it as unheard would read as a TTS failure on the rate that
   * exists to catch those.
   */
  drainTurns(): Closed {
    return { segments: [], turns: [...this.turns.keys()].flatMap((t) => this.closeTurn(t).turns) };
  }

  drain(): Closed {
    const stale = [...this.segments.values()].sort((a, b) => a.openedAt - b.openedAt);
    const segments = stale.map((s) => this.close(s, { text: "", interrupted: true }));
    const turns = [...this.turns.keys()].flatMap((t) => this.closeTurn(t).turns);
    this.currentTurnId = null;
    return { segments, turns };
  }

  private turnOf(turnId: string): Turn {
    const existing = this.turns.get(turnId);
    if (existing !== undefined) return existing;
    const fresh: Turn = { replySpeechId: null, eouDelayMs: undefined, transcriptionDelayMs: undefined, eot: undefined, ttfbMs: undefined, audioMs: 0, chars: 0, producedAudio: false, interrupted: false };
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
    const turn = this.turns.get(segment.turnId);
    if (turn !== undefined && heard.interrupted) turn.interrupted = true;
    return { turnId: segment.turnId, segmentId: segment.segmentId, heardText: heard.text, interrupted: heard.interrupted };
  }

  private closeTurn(turnId: string): Closed {
    const turn = this.turns.get(turnId);
    if (turn === undefined) return NOTHING;
    this.turns.delete(turnId);
    return {
      segments: [],
      turns: [{ turnId, eouDelayMs: turn.eouDelayMs, transcriptionDelayMs: turn.transcriptionDelayMs, eot: turn.eot, ttfbMs: turn.ttfbMs, audioMs: turn.audioMs, chars: turn.chars, silent: !turn.producedAudio && !turn.interrupted }],
    };
  }
}
