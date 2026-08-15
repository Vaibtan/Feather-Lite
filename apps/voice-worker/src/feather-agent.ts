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

  /** Report what the borrower actually heard of the last generated reply (barge-in truth). */
  async reportPlayout(item: llm.ChatMessage): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId || turnId === this.lastReportedTurnId) return;
    this.lastReportedTurnId = turnId;
    await this.deps.client
      .signal(this.deps.conversationId, { kind: "playout", turn_id: turnId, heard_text: item.textContent ?? "", interrupted: item.interrupted })
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
        ? { turn_id: previousTurnId, heard_text: lastAssistant.textContent ?? "", interrupted: true }
        : undefined;
    if (playout) this.lastReportedTurnId = previousTurnId;

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
