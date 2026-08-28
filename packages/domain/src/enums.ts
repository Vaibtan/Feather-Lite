/**
 * Closed vocabularies of the collections domain.
 *
 * Every enum is a `Schema.Literal` union so it can be decoded at boundaries
 * (HTTP, DB, LLM output) and narrowed exhaustively inside the domain.
 * The string values are byte-compatible with the SPEC §7 tables (and with the
 * Python v1 implementation they were carried over from, removed in Phase 8).
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

/**
 * `FAILED` is distinct from `CANCELED`: cancelled means a policy decided not to do this (a TCPA
 * window exhausted its retries, a borrower went on the do-not-call list), failed means the system
 * tried and could not (O4 — a voice re-dial on a deployment with no media plane configured).
 * A human reading the queue needs to tell "we chose not to" from "we could not".
 */
export const ScheduledActionStatus = Schema.Literal("PENDING", "CLAIMED", "DONE", "CANCELED", "FAILED");
export type ScheduledActionStatus = typeof ScheduledActionStatus.Type;

/**
 * `JUDGE` is its own job rather than more of `EVALUATION` (spec 2026-08-26, D3): it costs money, it
 * calls a model that can be down, and it is switched off entirely in CI and load runs. Sharing a
 * job with the deterministic evaluator would mean a judge outage retrying — and eventually
 * failing — the compliance checks that had already succeeded.
 */
export const OutboxJobType = Schema.Literal("SUMMARY", "EVALUATION", "VECTOR_INDEX", "JUDGE");
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

/**
 * The hangup reason that marks a call finalized by the orphaned-call sweeper rather than by
 * anyone hanging up (spec 2026-08-26, D6).
 *
 * It lives in the domain because two independent places must agree on it and neither may own it:
 * the sweeper writes it, and the orchestrator reads it to decide the outcome. An orphan is FAILED,
 * not NO_ANSWER — nobody ended the call, the worker died mid-conversation, and recording that as
 * "no answer" would schedule a polite retry for what is a system failure.
 */
export const ORPHANED_REASON = "ORPHANED";

/**
 * A conversation no worker ever claimed, as opposed to one that lost the worker it had (O4).
 *
 * Both end FAILED and both are swept, but they are different failures and only one of them is a
 * *detection latency*. Measured: a scheduled voice re-dial created a conversation and dispatched no
 * agent, so nothing ever claimed it; the sweeper booked it as an orphan detected after 5 minutes
 * 9 seconds and the fleet's `orphan_detect_ms` p95 went from 38 902 ms to 308 860 ms. The number
 * described how long the *unconfirmed window* is, not how fast a dead worker is noticed.
 *
 * So a never-served call is finalized, counted, and **not timed**: there was no moment at which it
 * was healthy, and a time-to-detect measured from one that never existed is not a measurement.
 */
export const NEVER_SERVED_REASON = "NEVER_SERVED";

/** Deterministic override classes, in precedence order (SPEC §8.4). */
export const OverrideReason = Schema.Literal("OPT_OUT", "DISPUTE", "HARDSHIP", "WRONG_NUMBER");
export type OverrideReason = typeof OverrideReason.Type;
