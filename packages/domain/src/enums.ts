/**
 * Closed vocabularies of the collections domain.
 *
 * Every enum is a `Schema.Literal` union so it can be decoded at boundaries
 * (HTTP, DB, LLM output) and narrowed exhaustively inside the domain.
 * The string values are byte-compatible with the Python reference
 * implementation (`backend/app/core/enums.py`) and the SPEC §7 tables.
 */
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Conversation states (SPEC §7.1)                                      */
/* ------------------------------------------------------------------ */

export const CONVERSATION_STATES = [
  "GREETING",
  "VERIFYING_IDENTITY",
  "DISCUSSING_PAYMENT",
  "CONFIRMING_OUTCOME",
  "VOICEMAIL",
  "THIRD_PARTY_OR_WRONG_PARTY",
  "WARM_TRANSFER_PENDING",
  "OPT_OUT",
  "WRONG_NUMBER",
  "ESCALATED",
  "ENDING",
  "COMPLETED",
] as const;
export const ConversationState = Schema.Literal(...CONVERSATION_STATES);
export type ConversationState = typeof ConversationState.Type;

/* ------------------------------------------------------------------ */
/* Outcomes (SPEC §7.2)                                                 */
/* ------------------------------------------------------------------ */

export const OUTCOMES = [
  "PROMISE_TO_PAY",
  "CALLBACK_SCHEDULED",
  "WRONG_NUMBER",
  "OPT_OUT",
  "ESCALATED",
  "DISPUTED",
  "VOICEMAIL_LEFT",
  "THIRD_PARTY_CONTACT",
  "NO_ANSWER",
  "FAILED",
] as const;
export const Outcome = Schema.Literal(...OUTCOMES);
export type Outcome = typeof Outcome.Type;

/* ------------------------------------------------------------------ */
/* Event types (SPEC §7.5 + v2 additions)                               */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = [
  "CALL_STARTED",
  "CALL_CONTROL",
  "AMD_RESULT",
  "NO_INPUT",
  "USER_TURN",
  "USER_TURN_FINAL",
  "AGENT_TURN",
  "TOOL_CALLED",
  "TOOL_RESULT",
  "TOOL_REJECTED", // v2: fail-closed tool use (SPEC §10.6 acceptance criteria)
  "TURN_DECISION_REJECTED", // v2: LLM output rejected by the state machine / validator
  "TURN_SUPERSEDED", // v2: an in-flight turn was interrupted by a newer user turn (barge-in)
  "AGENT_TURN_PLAYOUT", // v2: what the borrower actually heard (barge-in truncation)
  "STATE_TRANSITION",
  "TRANSFER_REQUESTED",
  "TRANSFER_COMPLETED",
  "CALL_ENDED",
  "OUTBOX_ENQUEUED",
  "OUTBOX_PROCESSED",
] as const;
export const EventType = Schema.Literal(...EVENT_TYPES);
export type EventType = typeof EventType.Type;

/* ------------------------------------------------------------------ */
/* Workflow / attempt / entity statuses                                 */
/* ------------------------------------------------------------------ */

export const WorkflowType = Schema.Literal(
  "PAYMENT_REMINDER",
  "CALLBACK_FOLLOWUP",
  "ESCALATION_FOLLOWUP",
);
export type WorkflowType = typeof WorkflowType.Type;

export const WorkflowExecutionStatus = Schema.Literal("PENDING", "RUNNING", "COMPLETED", "FAILED");
export type WorkflowExecutionStatus = typeof WorkflowExecutionStatus.Type;

export const CallDirection = Schema.Literal("OUTBOUND", "INBOUND");
export type CallDirection = typeof CallDirection.Type;

export const CallAttemptStatus = Schema.Literal(
  "INITIATED",
  "ANSWERED",
  "NO_ANSWER",
  "VOICEMAIL",
  "COMPLETED",
  "FAILED",
);
export type CallAttemptStatus = typeof CallAttemptStatus.Type;

export const BorrowerStatus = Schema.Literal("ACTIVE", "OPT_OUT", "DECEASED");
export type BorrowerStatus = typeof BorrowerStatus.Type;

export const ContactPointType = Schema.Literal("PHONE");
export type ContactPointType = typeof ContactPointType.Type;

export const ConsentStatus = Schema.Literal("ALLOWED", "OPTED_OUT", "UNKNOWN");
export type ConsentStatus = typeof ConsentStatus.Type;

export const ContactRelationship = Schema.Literal("PRIMARY", "CO_BORROWER", "OTHER");
export type ContactRelationship = typeof ContactRelationship.Type;

export const LoanStatus = Schema.Literal("CURRENT", "DELINQUENT");
export type LoanStatus = typeof LoanStatus.Type;

export const AgentVersionStatus = Schema.Literal("DRAFT", "ACTIVE", "RETIRED");
export type AgentVersionStatus = typeof AgentVersionStatus.Type;

export const ScheduledActionType = Schema.Literal("CALLBACK", "RETRY_CALL", "HUMAN_FOLLOWUP");
export type ScheduledActionType = typeof ScheduledActionType.Type;

export const ScheduledActionStatus = Schema.Literal("PENDING", "CLAIMED", "DONE", "CANCELED");
export type ScheduledActionStatus = typeof ScheduledActionStatus.Type;

export const OutboxJobType = Schema.Literal("SUMMARY", "EVALUATION", "VECTOR_INDEX");
export type OutboxJobType = typeof OutboxJobType.Type;

export const OutboxJobStatus = Schema.Literal("PENDING", "CLAIMED", "DONE", "FAILED");
export type OutboxJobStatus = typeof OutboxJobStatus.Type;

export const Channel = Schema.Literal("simulated", "voice");
export type Channel = typeof Channel.Type;

/* ------------------------------------------------------------------ */
/* Call-control actions and transition triggers                         */
/* ------------------------------------------------------------------ */

/** Runtime/telephony operations. Never exposed to the LLM as tools (SPEC §10.3). */
export const CallControlAction = Schema.Literal(
  "HANGUP",
  "VOICEMAIL_DROP",
  "HOLD",
  "WARM_TRANSFER",
  "NO_ANSWER",
  "NO_INPUT_CLOSE",
  "BARGE_IN_DETECTED",
);
export type CallControlAction = typeof CallControlAction.Type;

/** Why a STATE_TRANSITION happened. Replay and QA key off this. */
export const TransitionTrigger = Schema.Literal(
  "SYSTEM_START",
  "LLM_INTENT",
  "RIGHT_PARTY_CONFIRMED",
  "PROPOSAL", // DISCUSSING_PAYMENT -> CONFIRMING_OUTCOME via propose_promise_to_pay
  "USER_DECLINED", // CONFIRMING_OUTCOME -> DISCUSSING_PAYMENT (borrower changed their mind)
  "OVERRIDE_RULE",
  "AMD",
  "OUTCOME_COMMITTED",
  "CALL_ENDED",
  "NO_INPUT",
  "HANGUP",
);
export type TransitionTrigger = typeof TransitionTrigger.Type;

/** Deterministic override classes, in precedence order (SPEC §8.4). */
export const OverrideReason = Schema.Literal("OPT_OUT", "DISPUTE", "HARDSHIP", "WRONG_NUMBER");
export type OverrideReason = typeof OverrideReason.Type;
