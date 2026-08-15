/**
 * Phase 1.5 tracer bullet: an in-memory stand-in for the control plane.
 *
 * It speaks the same *frame protocol* the real `/turn` SSE endpoint will use
 * (plan rev.2 R5), so the worker code written against it survives the swap:
 *
 *   turn_start{turn_id}
 *   delta{text}*                     -> streamed into the generated reply (interruptible)
 *   say{text, allow_interruptions}*  -> spoken as separate speech handles, in order
 *   turn_end{new_state, outcome, end_call}
 *
 * The scripted turns walk GREETING -> VERIFYING_IDENTITY -> DISCUSSING_PAYMENT ->
 * CONFIRMING_OUTCOME (read-back is a non-interruptible `say`) -> recorded.
 */
import { promiseReadback, promiseRecordedConfirmation } from "@feather-lite/domain";

export type TurnFrame =
  | { readonly type: "turn_start"; readonly turn_id: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "say"; readonly text: string; readonly allow_interruptions: boolean }
  | {
      readonly type: "turn_end";
      readonly new_state: string;
      readonly outcome: string | null;
      readonly end_call: boolean;
    };

export interface TurnInput {
  readonly turnId: string;
  readonly userText: string;
  /** What the borrower actually heard of the previous agent line, if it was interrupted. */
  readonly heardAgentText: string | null;
  readonly previousInterrupted: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Yield a sentence word-by-word to imitate LLM token streaming. */
async function* streamWords(text: string, delayMs = 25): AsyncGenerator<TurnFrame> {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    yield { type: "delta", text: (i === 0 ? "" : " ") + words[i] };
    await sleep(delayMs);
  }
}

export class FakeControlPlane {
  private state = "GREETING";
  private turnNo = 0;
  readonly log: Array<{ turn: number; state: string; user: string; heard: string | null; interrupted: boolean }> = [];

  async *turn(input: TurnInput): AsyncGenerator<TurnFrame> {
    this.turnNo += 1;
    this.log.push({
      turn: this.turnNo,
      state: this.state,
      user: input.userText,
      heard: input.heardAgentText,
      interrupted: input.previousInterrupted,
    });
    yield { type: "turn_start", turn_id: input.turnId };
    const text = input.userText.toLowerCase();

    // Deterministic override, as the real control plane would do before the LLM.
    if (/\b(stop calling|do not call|don't call)\b/.test(text)) {
      yield { type: "say", text: "Understood. We will stop contacting you. Goodbye.", allow_interruptions: false };
      yield { type: "turn_end", new_state: "COMPLETED", outcome: "OPT_OUT", end_call: true };
      return;
    }

    switch (this.state) {
      case "GREETING":
      case "VERIFYING_IDENTITY": {
        if (/\b(yes|speaking|this is|i am)\b/.test(text)) {
          this.state = "DISCUSSING_PAYMENT";
          yield* streamWords(
            "Thank you for confirming. I'm calling about your account with a balance of five hundred fifty dollars, which was due on the first. Are you able to make a payment now, or would you like to set up a promise to pay?",
          );
          yield { type: "turn_end", new_state: this.state, outcome: null, end_call: false };
          return;
        }
        this.state = "VERIFYING_IDENTITY";
        yield* streamWords("Before I continue, I need to confirm I am speaking with the borrower on the account. Is that you?");
        yield { type: "turn_end", new_state: this.state, outcome: null, end_call: false };
        return;
      }
      case "DISCUSSING_PAYMENT": {
        if (/\b(pay|friday|tomorrow|next week)\b/.test(text)) {
          this.state = "CONFIRMING_OUTCOME";
          // Two-mode turn: no model text; the read-back is a deterministic `say`.
          // Interruptible on purpose: the framework DROPS user turns that complete during
          // non-interruptible speech, so a "yes" over the tail of the read-back would be lost.
          // The real control plane enforces "fully heard" via AGENT_TURN_PLAYOUT instead.
          yield { type: "say", text: promiseReadback({ amount: "550.00", date: "2026-08-21" }), allow_interruptions: true };
          yield { type: "turn_end", new_state: this.state, outcome: null, end_call: false };
          return;
        }
        yield* streamWords("I understand. Would you be able to make a payment by the end of this week, or would you prefer that I call you back another time?");
        yield { type: "turn_end", new_state: this.state, outcome: null, end_call: false };
        return;
      }
      case "CONFIRMING_OUTCOME": {
        if (/\b(yes|correct|confirm|right)\b/.test(text)) {
          this.state = "COMPLETED";
          // "Tool executed + committed" here; then the scripted confirmation.
          await sleep(120);
          yield { type: "say", text: promiseRecordedConfirmation({ amount: "550.00", date: "2026-08-21" }), allow_interruptions: false };
          yield { type: "turn_end", new_state: this.state, outcome: "PROMISE_TO_PAY", end_call: true };
          return;
        }
        this.state = "DISCUSSING_PAYMENT";
        yield* streamWords("No problem. What amount and date would work for you?");
        yield { type: "turn_end", new_state: this.state, outcome: null, end_call: false };
        return;
      }
      default: {
        yield { type: "say", text: "Thank you for your time. Goodbye.", allow_interruptions: false };
        yield { type: "turn_end", new_state: "COMPLETED", outcome: null, end_call: true };
      }
    }
  }
}
