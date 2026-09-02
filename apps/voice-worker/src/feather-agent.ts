/**
 * The production `voice.Agent`: its `llmNode` IS the control plane (plan D2). Everything the
 * borrower hears comes from `/turn` frames — model deltas into the generated reply, deterministic
 * `say` segments as separate speech handles — and every runtime fact (barge-in truncation,
 * no-input, hangup, AMD) is reported back as a signal so the ledger stays truthful.
 */
import { randomUUID } from "node:crypto";
import { type llm, voice } from "@livekit/agents";
import type { TurnFrame } from "@feather-lite/contracts";
import { safeFallback } from "@feather-lite/domain";
import type { ControlPlaneClient } from "./control-plane-client.js";

export interface FeatherAgentDeps {
  readonly client: ControlPlaneClient;
  readonly conversationId: string;
  readonly openingText: string;
  /** Called when the control plane says the call is over (after final playout). */
  readonly onEndCall: (reason: string) => Promise<void>;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

const streamFrames = (
  frames: AsyncGenerator<TurnFrame>,
  onSay: (text: string, allowInterruptions: boolean) => void,
  onEnd: (frame: Extract<TurnFrame, { type: "turn_end" }>) => void,
  onError: (frame: Extract<TurnFrame, { type: "error" }>) => void,
): ReadableStream<string> =>
  new ReadableStream<string>({
    async pull(controller) {
      // WHATWG: keep pulling until we enqueue or finish (Phase 1.5 finding #3).
      for (;;) {
        let next: IteratorResult<TurnFrame>;
        try {
          next = await frames.next();
        } catch (err) {
          controller.error(err);
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        const f = next.value;
        switch (f.type) {
          case "delta":
            controller.enqueue(f.text);
            return;
          case "say":
            onSay(f.text, f.allow_interruptions);
            continue;
          case "turn_end":
            onEnd(f);
            continue;
          case "error":
            onError(f);
            continue;
          case "turn_start":
            continue;
        }
      }
    },
    cancel() {
      void frames.return(undefined);
    },
  });

export class FeatherAgent extends voice.Agent {
  /** The turn whose generated reply / says are currently being spoken; used for playout reporting. */
  private currentTurnId: string | null = null;
  private lastReportedTurnId: string | null = null;
  private endRequested = false;
  /**
   * Playout waits still outstanding (W9).
   *
   * It only ever grew: every `say` pushed a promise and nothing removed it, so a long call carried
   * one settled promise per line it had ever spoken, for the life of the call. Each entry removes
   * itself when it settles now, so what the array holds is what is actually still playing — which
   * is what `endCall` waits on and all it ever needed.
   */
  private pendingSays: Promise<void>[] = [];

  /**
   * Bind every item a speech handle produces to the turn that asked for it (W3).
   *
   * `_addItemAddedCallback` is underscore-prefixed and therefore an internal of the pinned 1.6.4
   * (`voice/speech_handle.d.ts`). It is used deliberately, like the two getters
   * `patches/@livekit__agents@1.6.4.patch` adds, and for the same reason: the framework resolves
   * something the worker needs and does not expose it. If a future version drops it the map simply
   * stays empty and attribution falls back to `currentTurnId` — the behaviour this replaces, not a
   * crash.
   */
  private stampItemsOf(handle: { _addItemAddedCallback?: (cb: (item: { id: string }) => void) => void }, turnId: string): void {
    handle._addItemAddedCallback?.((item) => {
      this.itemTurn.set(item.id, turnId);
    });
  }

  /** Track one playout wait, and forget it once it is over. */
  private trackSay(wait: Promise<void>): void {
    const tracked = wait.finally(() => {
      const i = this.pendingSays.indexOf(tracked);
      if (i >= 0) this.pendingSays.splice(i, 1);
    });
    this.pendingSays.push(tracked);
  }
  /**
   * EOU metrics arrive before `llmNode` runs, so before the turn they belong to has an id. Held
   * here until the turn is created, then reported together with that turn's TTS time-to-first-byte.
   */
  private pendingEou: { eouDelayMs?: number | undefined; transcriptionDelayMs?: number | undefined } | null = null;
  /**
   * Turns for which TTS actually produced audio (any `tts_metrics` arrived). A TTS stream can stall
   * and produce ZERO frames (seen: Deepgram websocket connect hang); the framework's 10s watchdog
   * then force-closes the speech and the chat item arrives looking fully played. Reporting that as
   * heard would poison the fully-heard guard — the ledger would believe the borrower heard a
   * read-back that was never spoken.
   *
   * **What `tts_metrics` actually fires on** (W8), read from the installed 1.6.4 rather than
   * assumed: `tts/tts.js` calls its `emit()` when a synthesised chunk arrives with `audio.final`,
   * i.e. at the **end of a segment's synthesis** — not on the first byte, as this comment used to
   * say. `ttfbMs` *inside* the event is measured to the first byte; the event itself is late.
   *
   * The guard still holds, and for a reason worth writing down rather than inheriting: a segment is
   * synthesised before it has finished *playing*, and `reportPlayout` runs on the item-added event
   * that follows playback. So the metrics still precede the report, and their absence at report time
   * still means nothing was synthesised at all. The conclusion was right; the stated mechanism was
   * not, and a guard defended by a wrong reason is one nobody can safely change.
   */
  private ttsProducedAudio = new Set<string>();

  constructor(private readonly deps: FeatherAgentDeps) {
    super({ instructions: "Feather-Lite voice runtime. Spoken text is supplied by the control plane; the model is never called here." });
  }

  /** Non-interruptible opening (Mini-Miranda + recording notice + right-party question). */
  async speakOpening(): Promise<void> {
    const handle = this.session.say(this.deps.openingText, { allowInterruptions: false });
    await handle.waitForPlayout();
    await this.deps.client.signal(this.deps.conversationId, { kind: "opening_played", text: this.deps.openingText }).catch((e) => this.deps.log("opening_played signal failed", { error: String(e) }));
  }

  /** Called by the runtime on `user_state_changed -> away` (silence). Two strikes close the call. */
  async onSilence(): Promise<void> {
    if (this.endRequested) return;
    try {
      const r = await this.deps.client.noInput(this.deps.conversationId);
      const handle = this.session.say(r.agent_text, { allowInterruptions: !r.end_call });
      if (r.end_call) {
        await handle.waitForPlayout();
        await this.endCall("no_input");
      }
    } catch (e) {
      this.deps.log("no_input failed", { error: String(e) });
    }
  }

  /** `eou_metrics` from the session: measured before this turn exists, so it waits for one. */
  onEouMetrics(m: { eouDelayMs?: number | undefined; transcriptionDelayMs?: number | undefined }): void {
    this.pendingEou = m;
  }

  /**
   * A paused line was resumed because the borrower was only listening (issue #1, D1's `resume`).
   *
   * Reported so the ledger knows the agent's line was **not** cut — which is the difference between
   * a false interruption the system recovered from and a real one it did not. Carries how long the
   * pause lasted, because "resume p50 < 300 ms" is the gate D1 is measured against, and the
   * two-second `falseInterruptionTimeout` is what it has to beat.
   */
  onResumed(pausedForMs: number): void {
    this.resumes.push(pausedForMs);
  }

  /** Pause durations of every resume on this call, drained onto the next `turn_metrics`. */
  private resumes: number[] = [];

  /** What to report and forget. Empty on almost every turn. */
  protected drainResumes(): ReadonlyArray<number> {
    const out = this.resumes;
    this.resumes = [];
    return out;
  }

  /**
   * `tts_metrics` from the session, **accumulated per turn rather than posted per segment** (W2).
   *
   * Read from the installed 1.6.4 rather than assumed: `tts/tts.js` calls its `emit()` when a chunk
   * arrives with `audio.final` — the end of one segment's synthesis — and then resets `ttfb`,
   * `audioDurationMs` and `#startedHrTime` for the next. A turn the framework splits into three
   * sentences therefore raises three events, each describing one sentence.
   *
   * This posted a `turn_metrics` signal per event, and the control plane merges each into the same
   * turn row, so **the last segment's numbers won**. `tts_ttfb_ms` in the ledger was the time to the
   * last sentence's first byte, not the turn's; `tts_audio_ms` and `tts_chars` were that sentence's
   * alone, which made the chars-per-second heuristic a measure of sentence length. The 385 ms p50 in
   * the N=10 table is a last-segment number.
   *
   * So: the **first** segment's TTFB, because time-to-first-byte for a turn is when the borrower
   * first hears anything; summed audio and characters, because those are quantities of a turn's
   * whole speech; and one signal, flushed when the turn's playout is reported, which is the moment
   * the turn has finished speaking.
   */
  private ttsAccum = new Map<string, { ttfbMs?: number; audioMs: number; chars: number }>();

  onTtsMetrics(m: { ttfbMs?: number | undefined; audioDurationMs?: number | undefined; charactersCount?: number | undefined }): void {
    const turnId = this.currentTurnId;
    if (!turnId) return; // the opening and other say()s are not control-plane turns
    this.ttsProducedAudio.add(turnId);
    const acc = this.ttsAccum.get(turnId) ?? { audioMs: 0, chars: 0 };
    // First one wins: `ttfbMs` is per segment, and the turn's is the first segment's.
    if (acc.ttfbMs === undefined && m.ttfbMs !== undefined && m.ttfbMs >= 0) acc.ttfbMs = m.ttfbMs;
    acc.audioMs += m.audioDurationMs ?? 0;
    acc.chars += m.charactersCount ?? 0;
    this.ttsAccum.set(turnId, acc);
  }

  /**
   * Post one turn's worker-side waterfall: the EOU numbers measured before the turn existed, and the
   * TTS numbers accumulated across its segments (W2).
   *
   * Called when the turn's playout is reported, which is after its speech is over — so the sum is
   * complete. A turn that produced no TTS at all still posts its EOU numbers, because a turn whose
   * synthesis failed is exactly the one whose latency an operator wants to see.
   */
  private async flushTurnMetrics(turnId: string): Promise<void> {
    const acc = this.ttsAccum.get(turnId);
    this.ttsAccum.delete(turnId);
    const eou = this.pendingEou;
    this.pendingEou = null;
    /** D1's `resume`: pauses this turn recovered from without cutting the agent's line. */
    const resumes = this.drainResumes();
    if (!acc && !eou && resumes.length === 0) return;
    await this.deps.client
      .signal(this.deps.conversationId, {
        kind: "turn_metrics",
        turn_id: turnId,
        ...(eou?.eouDelayMs !== undefined ? { eou_delay_ms: eou.eouDelayMs } : {}),
        ...(eou?.transcriptionDelayMs !== undefined ? { transcription_delay_ms: eou.transcriptionDelayMs } : {}),
        ...(acc?.ttfbMs !== undefined ? { tts_ttfb_ms: acc.ttfbMs } : {}),
        // D5: how much audio was produced for how many characters, over the whole turn now. Together
        // they give a chars-per-second reading, which is a *heuristic* for "did the voice sound
        // broken" — a wildly slow or fast turn shows up as an outlier — and deliberately not a
        // quality claim. Per segment it was measuring sentence length instead.
        ...(acc && acc.audioMs > 0 ? { tts_audio_ms: acc.audioMs } : {}),
        ...(acc && acc.chars > 0 ? { tts_chars: acc.chars } : {}),
        // Absent on almost every turn. Present means the borrower said "mm-hm", the agent's audio
        // paused, and it was resumed early rather than after the two-second false-interruption
        // timeout — so the line was not cut and the pause is measurable against D1's 300 ms gate.
        ...(resumes.length > 0 ? { resumed_ms: resumes } : {}),
      })
      .catch((e) => this.deps.log("turn_metrics signal failed", { error: String(e) }));
  }

  /**
   * Record what the borrower heard of one agent item, against the turn that *started* it (W3, W4).
   *
   * Two things were wrong here and they compound.
   *
   * **W3 — attribution.** The turn was read from `currentTurnId` at the moment the item landed, and
   * that field moves at the next `llmNode`. An item delivered after the next turn began was booked
   * to the wrong turn. ADR 0008 recorded this as a residual on eight clean runs and named the fix:
   * a per-item mapping. `say` handles carry one — `SpeechHandle._addItemAddedCallback` in the
   * installed 1.6.4 — so every line this worker speaks is now stamped with the turn that asked for
   * it, at the moment it asked, and `currentTurnId` is only the fallback for the framework's own
   * generated reply.
   *
   * **W4 — completeness.** One turn can produce several assistant items: the reply the framework
   * builds from `delta` frames, plus one per `say`. This reported the **first** and dropped the
   * rest, because `lastReportedTurnId` suppressed them — so a turn that spoke a reply and then a
   * tool line reported only the reply, and the fully-heard guard judged a promise read-back against
   * a partial record of what was said.
   *
   * So items accumulate into the turn that owns them, and the turn reports **once**, when it is
   * over. `interrupted` is true if any part of the turn was cut off, and the heard text is the
   * whole of what was spoken.
   */
  private recordItem(item: llm.ChatMessage): void {
    const turnId = this.itemTurn.get(item.id) ?? this.currentTurnId;
    if (!turnId) return; // the opening and other say()s are not control-plane turns
    this.itemTurn.delete(item.id);
    const rec = this.spoken.get(turnId) ?? { parts: [], interrupted: false };
    rec.parts.push(item.textContent ?? "");
    rec.interrupted = rec.interrupted || item.interrupted;
    this.spoken.set(turnId, rec);
  }

  /** What each turn has spoken so far, until it is reported. Keyed by turn, not by item. */
  private spoken = new Map<string, { parts: string[]; interrupted: boolean }>();
  /** Which turn asked for a given item, stamped when the speech was created rather than delivered. */
  private itemTurn = new Map<string, string>();

  /** The session's item-added hook. Accumulates; the report happens when the turn ends. */
  reportPlayout(item: llm.ChatMessage): void {
    this.recordItem(item);
  }

  /**
   * Report one finished turn's playout: everything it spoke, and whether any of it was cut off.
   *
   * Called when the **next** turn begins and at `endCall`, which is what "the turn is over" means
   * for a turn that can speak several times. Before the next turn's `/turn` request goes out, so the
   * ledger holds this turn's playout before the guard that reads it runs — which is the ordering the
   * fully-heard guard depends on and which used to be a race (issue #4, C1's residual).
   */
  private async reportTurnPlayout(turnId: string): Promise<void> {
    if (turnId === this.lastReportedTurnId) return;
    const rec = this.spoken.get(turnId);
    this.spoken.delete(turnId);
    if (!rec) return;
    this.lastReportedTurnId = turnId;

    // TTS produced no audio at all: the borrower heard silence, whatever the chat items claim.
    // `interrupted: true` + empty heard_text makes the orchestrator's fully-heard guard treat the
    // segment as unheard, so a proposal read-back gets repeated instead of silently "confirmed".
    // The check applies only to UN-interrupted turns (a stall force-closes as played-in-full,
    // `interrupted: false`): for a barge-in the framework aborts the TTS stream, so `tts_metrics`
    // fires after the truncated item is reported — measured, not assumed — and the item's own
    // playback-truncated text is already the audio truth.
    const silent = !rec.interrupted && !this.ttsProducedAudio.has(turnId);
    this.ttsProducedAudio.delete(turnId);
    if (silent) {
      this.deps.log("tts produced no audio for this turn; reporting empty playout", { turnId });
      // A stall that the framework force-closes as "played in full" raises no session Error event,
      // so this is the only place it can be counted. It is the ADR 0008 failure mode; watching it
      // is the point of the counter.
      void this.deps.client.providerEvents([
        { provider: `tts:${process.env["STT_TTS_PROVIDER"] === "plugins" ? "deepgram" : "livekit-inference"}`, kind: "timeout", stage: "tts", message: `no audio produced for turn ${turnId}`, conversation_id: this.deps.conversationId },
      ]);
    }
    // The turn is over, so its TTS segments are all in.
    await this.flushTurnMetrics(turnId);
    await this.deps.client
      .signal(this.deps.conversationId, {
        kind: "playout",
        turn_id: turnId,
        heard_text: silent ? "" : rec.parts.filter((p) => p.length > 0).join(" "),
        interrupted: silent ? true : rec.interrupted,
      })
      .catch((e) => this.deps.log("playout signal failed", { error: String(e) }));
  }

  async endCall(reason: string): Promise<void> {
    if (this.endRequested) return;
    this.endRequested = true;
    await Promise.allSettled(this.pendingSays);
    // The last turn of the call has no next turn to report it, so it is reported here (W4).
    if (this.currentTurnId) await this.reportTurnPlayout(this.currentTurnId);
    await this.deps.onEndCall(reason);
  }

  get ended(): boolean {
    return this.endRequested;
  }

  override async llmNode(chatCtx: llm.ChatContext, _toolCtx: llm.ToolContext, _settings: voice.ModelSettings): Promise<ReadableStream<string> | null> {
    // Only the last user message and the previous assistant message (interrupted?) are read from the
    // framework's chatCtx; the control plane owns the conversation history (plan rev.2 R12).
    const items = chatCtx.items;
    let lastUser: llm.ChatMessage | undefined;
    let lastAssistant: llm.ChatMessage | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.type !== "message") continue;
      if (!lastUser && it.role === "user") lastUser = it;
      else if (!lastAssistant && it.role === "assistant") lastAssistant = it;
      if (lastUser && lastAssistant) break;
    }
    const userText = (lastUser?.textContent ?? "").trim();
    const turnId = randomUUID();
    const previousTurnId = this.currentTurnId;

    /**
     * The previous turn is over, so report everything it spoke — before this turn's request goes
     * out, and **before `currentTurnId` moves** (W4).
     *
     * The order of those two is not cosmetic. `onTtsMetrics` has no item to be stamped with and
     * still keys on `currentTurnId`, so switching first sent the previous turn's trailing TTS
     * metrics to *this* turn — and the previous turn, having no audio recorded against it, was then
     * reported silent. That is a read-back the guard refuses and repeats, on a call where the
     * borrower heard it perfectly well. It cost one call of the first containerised N=5:
     * `1/15 silent playouts` and `call00 MISMATCH outcome FAILED != PROMISE_TO_PAY`, at 150 s
     * against a 134 s median. The host arm never showed it, because the race needs the extra
     * latency to open.
     *
     * The ordering is the point rather than a convenience. The fully-heard guard reads the
     * read-back's playout during *this* turn's T1/T2, so posting it here puts it in the ledger
     * before the guard looks, where reporting on item-added raced it (C1's residual, the one that
     * 122 of 122 recorded calls happened to win).
     */
    if (previousTurnId) await this.reportTurnPlayout(previousTurnId);
    this.currentTurnId = turnId;

    const playout =
      previousTurnId && lastAssistant && lastAssistant.interrupted && previousTurnId !== this.lastReportedTurnId
        ? {
            turn_id: previousTurnId,
            // Same zero-audio truth as reportPlayout: if TTS never made a frame, nothing was heard.
            heard_text: this.ttsProducedAudio.has(previousTurnId) ? (lastAssistant.textContent ?? "") : "",
            interrupted: true,
          }
        : undefined;
    if (playout && previousTurnId) {
      this.lastReportedTurnId = previousTurnId;
      this.ttsProducedAudio.delete(previousTurnId);
    }

    this.deps.log("turn", { turnId, userText, interruptedPrevious: Boolean(playout) });
    const frames = this.deps.client.turn(this.deps.conversationId, { turn_id: turnId, user_text: userText, ...(playout ? { playout } : {}), supersede: true });

    return streamFrames(
      frames,
      (text, allowInterruptions) => {
        const handle = this.session.say(text, { allowInterruptions });
        // Stamped when the speech is *created*, not when its item is delivered (W3): `currentTurnId`
        // has moved on by then if the next turn has begun.
        this.stampItemsOf(handle, turnId);
        this.trackSay(handle.waitForPlayout());
      },
      (end) => {
        this.deps.log("turn_end", { turnId, state: end.new_state, tool: end.tool_called?.name ?? null, outcome: end.outcome, endCall: end.end_call, ttftMs: end.ttft_ms });
        if (end.end_call) void this.endCall(end.outcome ?? "completed");
      },
      (err) => {
        this.deps.log("turn error", { turnId, code: err.code, message: err.message });
        if (err.code !== "SUPERSEDED") {
          const handle = this.session.say(safeFallback(), { allowInterruptions: true });
          this.stampItemsOf(handle, turnId);
          this.trackSay(handle.waitForPlayout());
        }
      },
    );
  }
}
