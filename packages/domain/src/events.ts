/**
 * The durable event contract (SPEC §11).
 *
 * `conversation_events` is the source of truth for a call: state, tools,
 * call-control actions and the transcript are all *derived* from it (see
 * `replay.ts`, `transcript.ts`). Payload keys are snake_case on purpose — they
 * are the JSONB wire/storage format and stay byte-compatible with the Python
 * reference implementation so timelines look identical on both runtimes.
 */
import { Schema } from "effect";
import {
  CallControlAction,
  ConversationState,
  EventType,
  Outcome,
  OutboxJobType,
  TransitionTrigger,
} from "./enums.js";
import { ToolName } from "./tools.js";

const Json = Schema.Unknown;
const JsonRecord = Schema.Record({ key: Schema.String, value: Json });

/* --------------------------- payloads --------------------------- */

export const CallStartedPayload = Schema.Struct({
  workflow_execution_id: Schema.String,
  call_attempt_id: Schema.String,
  contact_point_id: Schema.String,
  channel: Schema.String,
  attempt_no: Schema.Number,
});

export const CallControlPayload = Schema.Struct({
  action: CallControlAction,
  action_id: Schema.String,
  target: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Number),
  count: Schema.optional(Schema.Number),
  partial_agent_text: Schema.optional(Schema.NullOr(Schema.String)),
  resume_allowed: Schema.optional(Schema.Boolean),
});

export const AmdResultPayload = Schema.Struct({
  result: Schema.Literal("HUMAN", "MACHINE", "NO_ANSWER", "UNCERTAIN"),
  classification: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Number),
});

export const NoInputPayload = Schema.Struct({
  state: ConversationState,
  count: Schema.Number,
});

export const UserTurnPayload = Schema.Struct({
  text: Schema.String,
  turn_id: Schema.optional(Schema.String),
  /** What the agent had said before the borrower interrupted (barge-in truncation), if any. */
  heard_agent_text: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Number),
});

export const SpeakMode = Schema.Literal("interruptible", "non_interruptible");
export type SpeakMode = typeof SpeakMode.Type;

export const AgentTurnPayload = Schema.Struct({
  text: Schema.String,
  state: ConversationState,
  /** Correlates AGENT_TURN with AGENT_TURN_PLAYOUT and the client's turn_id. */
  turn_id: Schema.optional(Schema.String),
  speak_mode: Schema.optional(SpeakMode),
  /** Set by the voice runtime when playback was cut short by barge-in. */
  interrupted: Schema.optional(Schema.Boolean),
  /** True when this text is a scripted fallback because the decider failed. */
  degraded: Schema.optional(Schema.Boolean),
});

export const ToolCalledPayload = Schema.Struct({
  name: ToolName,
  tool_call_id: Schema.String,
  args: JsonRecord,
});

export const ToolResultPayload = Schema.Struct({
  name: ToolName,
  tool_call_id: Schema.String,
  result: Json,
});

export const ToolRejectedPayload = Schema.Struct({
  name: Schema.String, // may be an unknown tool name from the LLM
  tool_call_id: Schema.optional(Schema.String),
  state: ConversationState,
  reason: Schema.Literal("NOT_ALLOWED", "INVALID_ARGS", "UNKNOWN_TOOL"),
  detail: Schema.String,
});

export const TurnDecisionRejectedPayload = Schema.Struct({
  state: ConversationState,
  reason: Schema.Literal("INVALID_TRANSITION", "DECIDER_UNAVAILABLE", "INVALID_OUTPUT"),
  detail: Schema.String,
  suggested_next_state: Schema.optional(Schema.String),
});

export const TurnSupersededPayload = Schema.Struct({
  turn_id: Schema.String,
  superseded_by: Schema.String,
});

/** What the borrower actually heard, reported by the voice runtime after playout. */
export const AgentTurnPlayoutPayload = Schema.Struct({
  turn_id: Schema.String,
  heard_text: Schema.String,
  interrupted: Schema.Boolean,
});

export const StateTransitionPayload = Schema.Struct({
  from: Schema.NullOr(ConversationState),
  to: ConversationState,
  triggered_by: TransitionTrigger,
  /** The override rule that fired, when triggered_by === OVERRIDE_RULE. */
  matched: Schema.optional(Schema.String),
});

export const TransferRequestedPayload = Schema.Struct({
  target: Schema.String,
  reason: Schema.String,
  action_id: Schema.String,
});

export const TransferCompletedPayload = Schema.Struct({
  target: Schema.String,
  reason: Schema.String,
  action_id: Schema.String,
  status: Schema.String,
});

export const CallEndedPayload = Schema.Struct({
  final_outcome: Outcome,
});

export const OutboxEnqueuedPayload = Schema.Struct({
  job_types: Schema.Array(OutboxJobType),
});

export const OutboxProcessedPayload = Schema.Struct({
  job_type: OutboxJobType,
  result: Json,
});

/* --------------------------- tagged union --------------------------- */

const ev = <T extends EventType, P extends Schema.Schema.Any>(type: T, payload: P) =>
  Schema.Struct({ type: Schema.Literal(type), payload });

export const ConversationEvent = Schema.Union(
  ev("CALL_STARTED", CallStartedPayload),
  ev("CALL_CONTROL", CallControlPayload),
  ev("AMD_RESULT", AmdResultPayload),
  ev("NO_INPUT", NoInputPayload),
  ev("USER_TURN", UserTurnPayload),
  ev("USER_TURN_FINAL", UserTurnPayload),
  ev("AGENT_TURN", AgentTurnPayload),
  ev("TOOL_CALLED", ToolCalledPayload),
  ev("TOOL_RESULT", ToolResultPayload),
  ev("TOOL_REJECTED", ToolRejectedPayload),
  ev("TURN_DECISION_REJECTED", TurnDecisionRejectedPayload),
  ev("TURN_SUPERSEDED", TurnSupersededPayload),
  ev("AGENT_TURN_PLAYOUT", AgentTurnPlayoutPayload),
  ev("STATE_TRANSITION", StateTransitionPayload),
  ev("TRANSFER_REQUESTED", TransferRequestedPayload),
  ev("TRANSFER_COMPLETED", TransferCompletedPayload),
  ev("CALL_ENDED", CallEndedPayload),
  ev("OUTBOX_ENQUEUED", OutboxEnqueuedPayload),
  ev("OUTBOX_PROCESSED", OutboxProcessedPayload),
);
export type ConversationEvent = typeof ConversationEvent.Type;
export type EventOf<T extends EventType> = Extract<ConversationEvent, { readonly type: T }>;
export type PayloadOf<T extends EventType> = EventOf<T>["payload"];

/** A stored event: the union plus its position and timestamp. */
export const EventRecord = Schema.extend(
  Schema.Struct({
    sequence_no: Schema.Number,
    created_at: Schema.String, // ISO-8601 UTC
  }),
  ConversationEvent,
);
export type EventRecord = typeof EventRecord.Type;

/** Decode a raw `{type, payload}` row (e.g. from JSONB) into the typed union. */
export const decodeEvent = Schema.decodeUnknownEither(ConversationEvent);
export const decodeEventRecord = Schema.decodeUnknownEither(EventRecord);
