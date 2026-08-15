/**
 * The tracer `voice.Agent`: llmNode streams frames from a control plane (fake for now).
 * Shared by the worker entrypoint (`agent.ts`) and the text-mode runner (`text-run.ts`).
 */
import { type llm, voice } from "@livekit/agents";
import { openingScript } from "@feather-lite/domain";
import { FakeControlPlane, type TurnFrame } from "./fake-control-plane.js";

export const PUBLIC_CTX = {
  agent_name: "Ava",
  company: "Feather-Lite Collections",
  callback_number: "+1 800 555 0100",
  workflow_type: "PAYMENT_REMINDER",
  attempt_no: 1,
  local_time_description: "now",
  borrower_first_name: "Jordan",
};

/**
 * Turn a frame generator into a text ReadableStream plus side-effects (`say`, end-of-call).
 *
 * WHATWG subtlety: a `pull()` that resolves without enqueuing is NOT re-invoked
 * automatically (no read pending, no enqueue -> no `pullAgain`). So `pull` must
 * loop until it either enqueues a delta or the frames are exhausted; otherwise a
 * turn made only of `say`/`turn_end` frames stalls the reply in "thinking".
 */
const streamTurn = (
  frames: AsyncGenerator<TurnFrame>,
  onSay: (text: string, allowInterruptions: boolean) => void,
  onEnd: (endCall: boolean, newState: string) => void,
): ReadableStream<string> =>
  new ReadableStream<string>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await frames.next();
        if (done) {
          controller.close();
          return;
        }
        switch (value.type) {
          case "delta":
            controller.enqueue(value.text);
            return; // progress made; the consumer will pull again
          case "say":
            onSay(value.text, value.allow_interruptions);
            continue;
          case "turn_end":
            onEnd(value.end_call, value.new_state);
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

export class TracerAgent extends voice.Agent {
  private readonly plane = new FakeControlPlane();
  private turnCounter = 0;
  private endRequested = false;
  private pendingSays: Promise<void>[] = [];

  constructor() {
    super({
      instructions: "You are the Feather-Lite voice runtime. Spoken text is supplied by the control plane.",
    });
  }

  override async onEnter(): Promise<void> {
    // Mandatory disclosures + right-party question, non-interruptible (PRD §5.2.8).
    const handle = this.session.say(openingScript(PUBLIC_CTX), { allowInterruptions: false });
    await handle.waitForPlayout();
    console.log("[tracer] opening played out; listening");
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    _toolCtx: llm.ToolContext,
    _settings: voice.ModelSettings,
  ): Promise<ReadableStream<string> | null> {
    // The framework's chatCtx is used ONLY to read the last user message and whether the
    // previous assistant message was interrupted (and what was heard). The control plane
    // owns the history (plan rev.2 R12).
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
    const userText = lastUser?.textContent ?? "";
    const turnId = `t${++this.turnCounter}`;
    const previousInterrupted = lastAssistant?.interrupted ?? false;
    console.log(
      `[tracer] llmNode turn=${turnId} user=${JSON.stringify(userText)} prevInterrupted=${previousInterrupted} heard=${JSON.stringify(previousInterrupted ? lastAssistant?.textContent : null)}`,
    );

    const frames = this.plane.turn({
      turnId,
      userText,
      heardAgentText: previousInterrupted ? (lastAssistant?.textContent ?? null) : null,
      previousInterrupted,
    });

    return streamTurn(
      frames,
      (text, allowInterruptions) => {
        // Queued after the generated reply; non-interruptible for read-backs/confirmations.
        const handle = this.session.say(text, { allowInterruptions });
        this.pendingSays.push(handle.waitForPlayout());
        console.log(`[tracer] say(allowInterruptions=${allowInterruptions}) queued: ${text.slice(0, 60)}...`);
      },
      (endCall, newState) => {
        console.log(`[tracer] turn_end state=${newState} end_call=${endCall}`);
        if (endCall && !this.endRequested) {
          this.endRequested = true;
          void (async () => {
            await Promise.allSettled(this.pendingSays);
            console.log("[tracer] final playout done; shutting down session");
            console.log("[tracer] control-plane log:", JSON.stringify(this.plane.log, null, 2));
            this.session.shutdown({ reason: "call complete" });
          })();
        }
      },
    );
  }
}

