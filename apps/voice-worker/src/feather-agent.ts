import { randomUUID } from "node:crypto";
import { type llm, voice } from "@livekit/agents";
import type { TurnFrame } from "@feather-lite/contracts";
import { safeFallback, SILENCE_WINDOW_MS } from "@feather-lite/domain";
import type { ControlPlaneClient } from "./control-plane-client.js";

export interface FeatherAgentDeps {
  readonly client: ControlPlaneClient;
  readonly conversationId: string;
  readonly openingText: string;
  readonly onEndCall: (reason: string) => Promise<void>;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** A callback, not the STT, so the caller owns the timing: `updateOptions` re-opens the socket. */
  readonly biasRecogniser?: ((terms: { keyterms: ReadonlyArray<string>; keywords: ReadonlyArray<string>; numerals: boolean }) => void) | undefined;
}

const streamFrames = (
  frames: AsyncGenerator<TurnFrame>,
  onSay: (text: string, allowInterruptions: boolean) => void,
  onEnd: (frame: Extract<TurnFrame, { type: "turn_end" }>) => void,
  onError: (frame: Extract<TurnFrame, { type: "error" }>) => void,
): ReadableStream<string> =>
  new ReadableStream<string>({
    async pull(controller) {
      // WHATWG requires `pull` to keep going until it enqueues or closes.
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
  private currentTurnId: string | null = null;
  private lastReportedTurnId: string | null = null;
  private endRequested = false;
  private pendingSays: Promise<void>[] = [];

  /**
   * `_addItemAddedCallback` is an internal of the pinned 1.6.4, used deliberately because the
   * framework resolves the item-to-turn binding and does not expose it. If a future version drops
   * it, the map stays empty and attribution falls back to `currentTurnId` rather than crashing.
   */
  private stampItemsOf(handle: { _addItemAddedCallback?: (cb: (item: { id: string }) => void) => void }, turnId: string): void {
    handle._addItemAddedCallback?.((item) => {
      this.itemTurn.set(item.id, turnId);
    });
  }

  private trackSay(wait: Promise<void>): void {
    const tracked = wait.finally(() => {
      const i = this.pendingSays.indexOf(tracked);
      if (i >= 0) this.pendingSays.splice(i, 1);
    });
    this.pendingSays.push(tracked);
  }
  /**
   * EOU metrics arrive before `llmNode` runs, so before the turn they belong to has an id. Held
   * here until the turn is created.
   */
  private pendingEou: { eouDelayMs?: number | undefined; transcriptionDelayMs?: number | undefined } | null = null;
  /**
   * Turns for which TTS actually produced audio. A stalled TTS stream produces zero frames and the
   * framework's watchdog force-closes the speech, so the chat item arrives looking fully played.
   *
   * `tts_metrics` fires when a synthesised chunk arrives with `audio.final` — the end of a
   * segment's synthesis, not its first byte — which is still before that segment has finished
   * playing, so its absence at report time means nothing was synthesised at all.
   */
  private ttsProducedAudio = new Set<string>();

  constructor(private readonly deps: FeatherAgentDeps) {
    super({ instructions: "Feather-Lite voice runtime. Spoken text is supplied by the control plane; the model is never called here." });
  }

  async speakOpening(): Promise<void> {
    const handle = this.session.say(this.deps.openingText, { allowInterruptions: false });
    await handle.waitForPlayout();
    await this.deps.client.signal(this.deps.conversationId, { kind: "opening_played", text: this.deps.openingText }).catch((e) => this.deps.log("opening_played signal failed", { error: String(e) }));
  }

  /**
   * The call's only silence clock. The SDK's `userAwayTimeout` is disabled, because it fires once
   * and then wedges — `_updateUserState` returns early on an unchanged state and only a final
   * transcript leaves `away` — so the strike that closes a dead call would never arrive. Two clocks
   * cannot share the job either: each firing increments a strike, and the second strike hangs up.
   *
   * The window is whatever the control plane last sent, so a borrower who asked for a moment gets
   * the moment they asked for and nobody else waits any longer for it.
   */
  private silenceTimer: NodeJS.Timeout | null = null;
  private silenceWindowMs: number = SILENCE_WINDOW_MS;
  private agentListening = false;
  private userListening = true;

  setSilenceWindow(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.silenceWindowMs = ms;
    this.refreshSilenceClock();
  }

  noteAgentListening(listening: boolean): void {
    this.agentListening = listening;
    this.refreshSilenceClock();
  }

  noteUserListening(listening: boolean): void {
    this.userListening = listening;
    this.refreshSilenceClock();
  }

  /** Restarts the clock, which is what every one of its callers means. */
  private refreshSilenceClock(): void {
    this.cancelSilenceClock();
    if (this.endRequested || !this.agentListening || !this.userListening) return;
    const windowMs = this.silenceWindowMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.deps.log("silence clock fired", { windowMs });
      void this.onSilence();
    }, windowMs);
  }

  private cancelSilenceClock(): void {
    if (this.silenceTimer === null) return;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  async onSilence(): Promise<void> {
    if (this.endRequested) return;
    try {
      const r = await this.deps.client.noInput(this.deps.conversationId);
      if (r.extend_away_ms !== undefined) this.silenceWindowMs = r.extend_away_ms;
      const handle = this.session.say(r.agent_text, { allowInterruptions: !r.end_call });
      if (r.end_call) {
        await handle.waitForPlayout();
        await this.endCall("no_input");
      }
    } catch (e) {
      this.deps.log("no_input failed", { error: String(e) });
      // Re-armed, or one failed probe would leave the call with no silence deadline at all.
      this.refreshSilenceClock();
    }
  }

  onEouMetrics(m: { eouDelayMs?: number | undefined; transcriptionDelayMs?: number | undefined }): void {
    this.pendingEou = m;
  }

  onResumed(pausedForMs: number): void {
    // -1 means the agent was never observed to stop speaking, so there is no duration to report and
    // a zero would be a claim rather than a measurement.
    if (pausedForMs >= 0) this.resumes.push(pausedForMs);
  }

  private resumes: number[] = [];

  protected drainResumes(): ReadonlyArray<number> {
    const out = this.resumes;
    this.resumes = [];
    return out;
  }

  /**
   * Accumulated per turn, not posted per segment: `tts_metrics` fires once per synthesised segment
   * and the control plane merges each signal into the same turn row, so a per-event post left the
   * last sentence's numbers standing for the whole turn.
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
   * Called when the turn's playout is reported, which is after its speech is over, so the sums are
   * complete. A turn that produced no TTS at all still posts its EOU numbers.
   */
  private async flushTurnMetrics(turnId: string): Promise<void> {
    const acc = this.ttsAccum.get(turnId);
    this.ttsAccum.delete(turnId);
    const eou = this.pendingEou;
    this.pendingEou = null;
    const resumes = this.drainResumes();
    if (!acc && !eou && resumes.length === 0) return;
    await this.deps.client
      .signal(this.deps.conversationId, {
        kind: "turn_metrics",
        turn_id: turnId,
        ...(eou?.eouDelayMs !== undefined ? { eou_delay_ms: eou.eouDelayMs } : {}),
        ...(eou?.transcriptionDelayMs !== undefined ? { transcription_delay_ms: eou.transcriptionDelayMs } : {}),
        ...(acc?.ttfbMs !== undefined ? { tts_ttfb_ms: acc.ttfbMs } : {}),
        ...(acc && acc.audioMs > 0 ? { tts_audio_ms: acc.audioMs } : {}),
        ...(acc && acc.chars > 0 ? { tts_chars: acc.chars } : {}),
        ...(resumes.length > 0 ? { resumed_ms: resumes } : {}),
      })
      .catch((e) => this.deps.log("turn_metrics signal failed", { error: String(e) }));
  }

  /**
   * One turn can produce several assistant items — the reply built from `delta` frames plus one per
   * `say` — so items accumulate into the turn that owns them and the turn reports once, when it is
   * over. The owning turn comes from the stamp, because `currentTurnId` has moved on by the time a
   * late item is delivered.
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

  private spoken = new Map<string, { parts: string[]; interrupted: boolean }>();
  /** Which turn asked for a given item, stamped when the speech was created rather than delivered. */
  private itemTurn = new Map<string, string>();

  reportPlayout(item: llm.ChatMessage): void {
    this.recordItem(item);
  }

  /**
   * Called when the next turn begins and at `endCall`, which is what "the turn is over" means for a
   * turn that can speak several times. It must run before the next turn's `/turn` request goes out,
   * so the ledger holds this playout before the fully-heard guard reads it.
   */
  private async reportTurnPlayout(turnId: string): Promise<void> {
    if (turnId === this.lastReportedTurnId) return;
    const rec = this.spoken.get(turnId);
    this.spoken.delete(turnId);
    if (!rec) return;
    this.lastReportedTurnId = turnId;

    // `interrupted: true` with empty heard_text makes the fully-heard guard treat the segment as
    // unheard, so a read-back is repeated rather than silently confirmed. Only un-interrupted turns
    // are checked: on a barge-in the framework aborts the TTS stream, so `tts_metrics` arrives after
    // the truncated item, and that item's own text is already the audio truth.
    const silent = !rec.interrupted && !this.ttsProducedAudio.has(turnId);
    this.ttsProducedAudio.delete(turnId);
    if (silent) {
      this.deps.log("tts produced no audio for this turn; reporting empty playout", { turnId });
      // A stall the framework force-closes as "played in full" raises no session Error event, so
      // this is the only place it can be counted.
      void this.deps.client.providerEvents([
        { provider: `tts:${process.env["STT_TTS_PROVIDER"] === "plugins" ? "deepgram" : "livekit-inference"}`, kind: "timeout", stage: "tts", message: `no audio produced for turn ${turnId}`, conversation_id: this.deps.conversationId },
      ]);
    }
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
    this.cancelSilenceClock();
    await Promise.allSettled(this.pendingSays);
    // The last turn of the call has no next turn to report it.
    if (this.currentTurnId) await this.reportTurnPlayout(this.currentTurnId);
    await this.deps.onEndCall(reason);
  }

  get ended(): boolean {
    return this.endRequested;
  }

  override async llmNode(chatCtx: llm.ChatContext, _toolCtx: llm.ToolContext, _settings: voice.ModelSettings): Promise<ReadableStream<string> | null> {
    // Only the last user message and the previous assistant message are read from the framework's
    // chatCtx; the control plane owns the conversation history.
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
     * This must run before `currentTurnId` moves: `onTtsMetrics` has no item to be stamped with and
     * keys on `currentTurnId`, so switching first sends the previous turn's trailing TTS metrics to
     * this turn and reports the previous one silent.
     */
    if (previousTurnId) await this.reportTurnPlayout(previousTurnId);
    this.currentTurnId = turnId;

    const playout =
      previousTurnId && lastAssistant && lastAssistant.interrupted && previousTurnId !== this.lastReportedTurnId
        ? {
            turn_id: previousTurnId,
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
        // Stamped when the speech is created, not when its item is delivered: `currentTurnId` has
        // moved on by then if the next turn has begun.
        this.stampItemsOf(handle, turnId);
        this.trackSay(handle.waitForPlayout());
      },
      (end) => {
        this.deps.log("turn_end", { turnId, state: end.new_state, tool: end.tool_called?.name ?? null, outcome: end.outcome, endCall: end.end_call, ttftMs: end.ttft_ms, extendAwayMs: end.extend_away_ms ?? null });
        if (end.bias_terms !== undefined) {
          // Sent once, on the turn that verified the borrower: the control plane will not repeat it,
          // because applying it re-opens the STT socket.
          this.deps.log("biasing recogniser", { keyterms: end.bias_terms.keyterms.length, keywords: end.bias_terms.keywords.length });
          this.deps.biasRecogniser?.(end.bias_terms);
        }
        if (end.extend_away_ms !== undefined) this.setSilenceWindow(end.extend_away_ms);
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
