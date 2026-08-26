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
  private pendingSays: Promise<void>[] = [];
  private noInputStrikes = 0;
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
   * read-back that was never spoken. `tts_metrics` fires on first synthesis byte, well before the
   * item-added event that triggers `reportPlayout`, so its absence at report time means silence.
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
    this.noInputStrikes += 1;
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
   * `tts_metrics` from the session: the last piece of the turn's waterfall. Reporting here means one
   * signal per turn carrying all three worker-side numbers, rather than a channel per metric.
   */
  async onTtsMetrics(m: { ttfbMs?: number | undefined; audioDurationMs?: number | undefined; charactersCount?: number | undefined }): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) return; // the opening and other say()s are not control-plane turns
    this.ttsProducedAudio.add(turnId);
    const eou = this.pendingEou;
    this.pendingEou = null;
    await this.deps.client
      .signal(this.deps.conversationId, {
        kind: "turn_metrics",
        turn_id: turnId,
        ...(eou?.eouDelayMs !== undefined ? { eou_delay_ms: eou.eouDelayMs } : {}),
        ...(eou?.transcriptionDelayMs !== undefined ? { transcription_delay_ms: eou.transcriptionDelayMs } : {}),
        ...(m.ttfbMs !== undefined ? { tts_ttfb_ms: m.ttfbMs } : {}),
        // D5: how much audio was produced for how many characters. Together these give a
        // chars-per-second reading, which is a *heuristic* for "did the voice sound broken" — a
        // wildly slow or fast turn shows up as an outlier — and deliberately not a quality claim.
        ...(m.audioDurationMs !== undefined ? { tts_audio_ms: m.audioDurationMs } : {}),
        ...(m.charactersCount !== undefined ? { tts_chars: m.charactersCount } : {}),
      })
      .catch((e) => this.deps.log("turn_metrics signal failed", { error: String(e) }));
  }

  /** Report what the borrower actually heard of the last generated reply (barge-in truth). */
  async reportPlayout(item: llm.ChatMessage): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId || turnId === this.lastReportedTurnId) return;
    this.lastReportedTurnId = turnId;
    // TTS produced no audio at all: the borrower heard silence, whatever the chat item claims.
    // `interrupted: true` + empty heard_text makes the orchestrator's fully-heard guard treat the
    // segment as unheard, so a proposal read-back gets repeated instead of silently "confirmed".
    // The check applies only to UN-interrupted items (a stall force-closes as played-in-full,
    // `interrupted: false`): for a barge-in the framework aborts the TTS stream, so `tts_metrics`
    // fires after the truncated item is reported — measured, not assumed — and the item's own
    // playback-truncated text is already the audio truth.
    const silent = !item.interrupted && !this.ttsProducedAudio.has(turnId);
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
    await this.deps.client
      .signal(this.deps.conversationId, {
        kind: "playout",
        turn_id: turnId,
        heard_text: silent ? "" : (item.textContent ?? ""),
        interrupted: silent ? true : item.interrupted,
      })
      .catch((e) => this.deps.log("playout signal failed", { error: String(e) }));
  }

  async endCall(reason: string): Promise<void> {
    if (this.endRequested) return;
    this.endRequested = true;
    await Promise.allSettled(this.pendingSays);
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
    this.currentTurnId = turnId;
    this.noInputStrikes = 0;

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
        this.pendingSays.push(handle.waitForPlayout());
      },
      (end) => {
        this.deps.log("turn_end", { turnId, state: end.new_state, tool: end.tool_called?.name ?? null, outcome: end.outcome, endCall: end.end_call, ttftMs: end.ttft_ms });
        if (end.end_call) void this.endCall(end.outcome ?? "completed");
      },
      (err) => {
        this.deps.log("turn error", { turnId, code: err.code, message: err.message });
        if (err.code !== "SUPERSEDED") {
          const handle = this.session.say(safeFallback(), { allowInterruptions: true });
          this.pendingSays.push(handle.waitForPlayout());
        }
      },
    );
  }
}
