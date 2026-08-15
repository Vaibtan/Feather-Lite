/**
 * The normalized turn contract between the conversationalist (LLM or scripted)
 * and the orchestrator (SPEC §9.4). Provider-independent by construction.
 */
import { Schema } from "effect";
import { ConversationState } from "./enums.js";
import { ToolCall } from "./tools.js";

export const TurnDecision = Schema.Struct({
  /** Spoken text. May be empty for tool-only turns. */
  message: Schema.String,
  /** At most one tool call per turn in v2. */
  toolCall: Schema.NullOr(ToolCall),
  intentSatisfied: Schema.Boolean,
  /** Validated against the adjacency map before being applied. `null` = stay. */
  suggestedNextState: Schema.NullOr(ConversationState),
});
export type TurnDecision = typeof TurnDecision.Type;

/** How the decider streams a decision: text deltas, then exactly one final decision. */
export type TurnChunk =
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "Decision"; readonly decision: TurnDecision };

export const textDelta = (text: string): TurnChunk => ({ _tag: "TextDelta", text });
export const decision = (d: TurnDecision): TurnChunk => ({ _tag: "Decision", decision: d });

/**
 * Split streamed text at sentence boundaries so TTS can start on the first
 * sentence while the model is still generating (PRD §6.1 "FlushSentinel").
 * Returns `[completeSentences, remainder]`.
 */
export const splitSentences = (buffer: string): readonly [ReadonlyArray<string>, string] => {
  const out: string[] = [];
  let rest = buffer;
  // Boundary: terminal punctuation followed by whitespace, but not inside a decimal (e.g. 550.00).
  const re = /([.!?])(\s+)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const end = m.index + 1;
    const before = rest.slice(lastIndex, end);
    // Skip "550.00 " style boundaries: digit before and digit after the period.
    const nextChar = rest[end + (m[2]?.length ?? 0)] ?? "";
    if (m[1] === "." && /\d$/.test(before) && /\d/.test(nextChar)) continue;
    out.push(before.trim());
    lastIndex = end + (m[2]?.length ?? 0);
  }
  rest = rest.slice(lastIndex);
  return [out.filter((s) => s.length > 0), rest];
};
