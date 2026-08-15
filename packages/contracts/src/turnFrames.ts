/**
 * The turn stream protocol (plan rev.2 R5). One `POST /api/conversations/:id/turn` produces:
 *
 *   turn_start                    once, immediately
 *   delta*                        model text, streamed (chat mode only)
 *   say*                          deterministic segments (read-backs, confirmations, closes)
 *   turn_end                      once, AFTER all durable writes committed
 *   error                         instead of turn_end if the turn failed
 *
 * The voice worker forwards `delta` into the generated reply and turns `say` into
 * separate speech handles; the console renders both.
 */
import { Schema } from "effect";
import { CallControlAction, ConversationState, Outcome, ToolName } from "@feather-lite/domain";

export const TurnStartFrame = Schema.Struct({
  type: Schema.Literal("turn_start"),
  turn_id: Schema.String,
  state: ConversationState,
});

export const DeltaFrame = Schema.Struct({
  type: Schema.Literal("delta"),
  text: Schema.String,
});

export const SayFrame = Schema.Struct({
  type: Schema.Literal("say"),
  text: Schema.String,
  allow_interruptions: Schema.Boolean,
});

export const ToolCalledSummary = Schema.Struct({
  name: ToolName,
  args: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export const CallControlSummary = Schema.Struct({
  action: CallControlAction,
  action_id: Schema.String,
});

export const TurnEndFrame = Schema.Struct({
  type: Schema.Literal("turn_end"),
  turn_id: Schema.String,
  new_state: ConversationState,
  /** Full agent text of this turn (deltas + says), for transcripts and the SPEC §12.2 alias. */
  agent_text: Schema.String,
  tool_called: Schema.NullOr(ToolCalledSummary),
  call_control_action: Schema.NullOr(CallControlSummary),
  outcome: Schema.NullOr(Outcome),
  end_call: Schema.Boolean,
  /** True when the decider failed and a scripted fallback was spoken. */
  degraded: Schema.Boolean,
  /** Milliseconds from turn start to first emitted text (decision TTFT). */
  ttft_ms: Schema.NullOr(Schema.Number),
});

export const ErrorFrame = Schema.Struct({
  type: Schema.Literal("error"),
  turn_id: Schema.String,
  code: Schema.String,
  message: Schema.String,
});

export const TurnFrame = Schema.Union(TurnStartFrame, DeltaFrame, SayFrame, TurnEndFrame, ErrorFrame);
export type TurnFrame = typeof TurnFrame.Type;
export type TurnEndFrame = typeof TurnEndFrame.Type;

export const encodeFrame = Schema.encodeSync(TurnFrame);
export const decodeFrame = Schema.decodeUnknownEither(TurnFrame);
