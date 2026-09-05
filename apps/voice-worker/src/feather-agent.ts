import { randomUUID } from "node:crypto";
import { type llm, voice } from "@livekit/agents";
import type { TurnFrame } from "@feather-lite/contracts";
import { safeFallback, SILENCE_WINDOW_MS } from "@feather-lite/domain";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { SegmentLedger, type Closed } from "./segment-ledger.js";

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
  onDelta: () => void,
  onSay: (segmentId: string, text: string, allowInterruptions: boolean) => void,
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
            onDelta();
            controller.enqueue(f.text);
            return;
          case "say":
            onSay(f.segment_id, f.text, f.allow_interruptions);
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
  private endRequested = false;
  private pendingSpeech: Promise<void>[] = [];
  private readonly segments = new SegmentLedger();
  /**
   * The reply speech the framework creates for a turn, seen on `SpeechCreated` before `llmNode` runs
   * (`agent_activity.js:1647` emits it, `:2154` calls `llmNode`). Its item is the turn's implicit
   * segment, and this is the only way to learn its id: `currentSpeech` is not yet set that early.
   */
  private pendingReplySpeechId: string | null = null;

  /**
   * Every speech a turn owns, so `endCall` can let the framework deliver its item before the call is
   * torn down. Speech is played one at a time, so waiting on the last one waits on all of them.
   */
  private trackSpeech(wait: Promise<void>): void {
    const tracked = wait.finally(() => {
      const i = this.pendingSpeech.indexOf(tracked);
      if (i >= 0) this.pendingSpeech.splice(i, 1);
    });
    this.pendingSpeech.push(tracked);
  }
  /** EOU metrics arrive before `llmNode` runs, so before the turn they belong to has an id. */
  private pendingEou: { eouDelayMs?: number | undefined; transcriptionDelayMs?: number | undefined } | null = null;

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

  onResumed(pausedForMs: number | null): void {
    // Null means the agent was never observed to stop speaking, so there is no duration to report
    // and a zero would be a claim rather than a measurement.
    if (pausedForMs !== null) this.resumes.push(pausedForMs);
  }

  private resumes: number[] = [];

  /** The reply speech for the turn about to run; `say` speeches are bound where they are created. */
  noteSpeechCreated(source: string, speech: { readonly id: string; readonly waitForPlayout: () => Promise<void> }): void {
    if (source === "say") return;
    this.pendingReplySpeechId = speech.id;
    this.trackSpeech(speech.waitForPlayout().catch(() => undefined));
  }

  onTtsMetrics(speechId: string | null, m: { ttfbMs?: number | undefined; audioDurationMs?: number | undefined; charactersCount?: number | undefined }): void {
    this.segments.noteTts(speechId, m);
  }

  /** A spoken item was delivered: the segment that produced it is over and is reported now. */
  reportPlayout(speechId: string | null, item: llm.ChatMessage): void {
    void this.publish(this.segments.deliver(speechId, { text: item.textContent ?? "", interrupted: item.interrupted }));
  }

  /**
   * One post per closed segment and one per closed turn. Segments go out first: the fully-heard guard
   * reads the read-back's playout, and the next turn's `held` phase waits for it.
   */
  private async publish(closed: Closed): Promise<void> {
    for (const s of closed.segments) {
      await this.deps.client
        .signal(this.deps.conversationId, { kind: "playout", turn_id: s.turnId, segment_id: s.segmentId, heard_text: s.heardText, interrupted: s.interrupted })
        .catch((e) => this.deps.log("playout signal failed", { error: String(e) }));
    }
    for (const t of closed.turns) {
      if (t.silent) {
        this.deps.log("tts produced no audio for this turn; reported unheard", { turnId: t.turnId });
        // A stall the framework force-closes as "played in full" raises no session Error event, so
        // this is the only place it can be counted.
        void this.deps.client.providerEvents([
          { provider: `tts:${process.env["STT_TTS_PROVIDER"] === "plugins" ? "deepgram" : "livekit-inference"}`, kind: "timeout", stage: "tts", message: `no audio produced for turn ${t.turnId}`, conversation_id: this.deps.conversationId },
        ]);
      }
      const measured = t.eouDelayMs !== undefined || t.transcriptionDelayMs !== undefined || t.ttfbMs !== undefined || t.audioMs > 0 || t.chars > 0;
      const resumes = this.resumes;
      if (!measured && resumes.length === 0) continue;
      this.resumes = [];
      await this.deps.client
        .signal(this.deps.conversationId, {
          kind: "turn_metrics",
          turn_id: t.turnId,
          ...(t.eouDelayMs !== undefined ? { eou_delay_ms: t.eouDelayMs } : {}),
          ...(t.transcriptionDelayMs !== undefined ? { transcription_delay_ms: t.transcriptionDelayMs } : {}),
          ...(t.ttfbMs !== undefined ? { tts_ttfb_ms: t.ttfbMs } : {}),
          ...(t.audioMs > 0 ? { tts_audio_ms: t.audioMs } : {}),
          ...(t.chars > 0 ? { tts_chars: t.chars } : {}),
          ...(resumes.length > 0 ? { resumed_ms: resumes } : {}),
        })
        .catch((e) => this.deps.log("turn_metrics signal failed", { error: String(e) }));
    }
  }

  async endCall(reason: string): Promise<void> {
    if (this.endRequested) return;
    this.endRequested = true;
    this.cancelSilenceClock();
    await Promise.allSettled(this.pendingSpeech);
    // Nothing will speak again, so a segment the framework never delivered an item for is over too.
    await this.publish(this.segments.drain());
    await this.deps.onEndCall(reason);
  }

  get ended(): boolean {
    return this.endRequested;
  }

  override async llmNode(chatCtx: llm.ChatContext, _toolCtx: llm.ToolContext, _settings: voice.ModelSettings): Promise<ReadableStream<string> | null> {
    // Only the last user message is read from the framework's chatCtx; the control plane owns the
    // conversation history.
    const items = chatCtx.items;
    let lastUser: llm.ChatMessage | undefined;
    for (let i = items.length - 1; i >= 0 && !lastUser; i--) {
      const it = items[i];
      if (it?.type === "message" && it.role === "user") lastUser = it;
    }
    const userText = (lastUser?.textContent ?? "").trim();
    const turnId = randomUUID();
    const replySpeechId = this.pendingReplySpeechId;
    this.pendingReplySpeechId = null;
    this.segments.beginTurn(turnId, this.pendingEou);
    this.pendingEou = null;

    this.deps.log("turn", { turnId, userText });
    const frames = this.deps.client.turn(this.deps.conversationId, { turn_id: turnId, user_text: userText, supersede: true });

    return streamFrames(
      frames,
      // The reply built from `delta` frames is the turn's implicit segment, opened on the first one:
      // a turn that streams no text produces no item, and an unopened segment cannot go unreported.
      () => this.segments.open({ segmentId: turnId, turnId, speechId: replySpeechId }),
      (segmentId, text, allowInterruptions) => {
        const handle = this.session.say(text, { allowInterruptions });
        this.segments.open({ segmentId, turnId, speechId: handle.id });
        this.trackSpeech(handle.waitForPlayout());
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
        void this.publish(this.segments.endTurn(turnId));
        if (end.end_call) void this.endCall(end.outcome ?? "completed");
      },
      (err) => {
        this.deps.log("turn error", { turnId, code: err.code, message: err.message });
        if (err.code !== "SUPERSEDED") {
          const handle = this.session.say(safeFallback(), { allowInterruptions: true });
          // Named here rather than by the control plane, which is the party that just failed to answer.
          this.segments.open({ segmentId: `${turnId}:fallback`, turnId, speechId: handle.id });
          this.trackSpeech(handle.waitForPlayout());
        }
        void this.publish(this.segments.endTurn(turnId));
      },
    );
  }
}
