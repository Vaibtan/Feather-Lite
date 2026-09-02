/**
 * Row schemas as they come back from `@effect/sql-pg` with camelCased column names.
 * `numeric` arrives as string, `timestamptz` as `Date`, `date` is selected `::text`.
 */
import { Schema } from "effect";
import {
  AgentVersionStatus,
  BorrowerStatus,
  CallAttemptStatus,
  CallDirection,
  ConsentStatus,
  ContactRelationship,
  ConversationState,
  EventType,
  LoanStatus,
  Outcome,
  OutboxJobStatus,
  OutboxJobType,
  ScheduledActionStatus,
  ScheduledActionType,
  ScoreDataType,
  ScoreName,
  ScoreSource,
  WorkflowExecutionStatus,
  WorkflowType,
} from "@feather-lite/domain";

const Json = Schema.Unknown;
const JsonRecord = Schema.Record({ key: Schema.String, value: Json });
const Ts = Schema.DateFromSelf;

export const BorrowerRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  preferredLanguage: Schema.String,
  timezone: Schema.String,
  status: BorrowerStatus,
  createdAt: Ts,
  updatedAt: Ts,
});
export type BorrowerRow = typeof BorrowerRow.Type;

export const ContactPointRow = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  value: Schema.String,
  isValid: Schema.Boolean,
  consentStatus: ConsentStatus,
  timezoneOverride: Schema.NullOr(Schema.String),
});
export type ContactPointRow = typeof ContactPointRow.Type;

export const BorrowerContactLinkRow = Schema.Struct({
  borrowerId: Schema.String,
  contactPointId: Schema.String,
  priority: Schema.Number,
  relationship: ContactRelationship,
});

export const LoanRow = Schema.Struct({
  id: Schema.String,
  borrowerId: Schema.String,
  principal: Schema.String,
  balanceDue: Schema.String,
  dueDate: Schema.String, // selected ::text
  status: LoanStatus,
  delinquencyDays: Schema.Number,
  lastPromiseDate: Schema.NullOr(Schema.String), // selected ::text
});
export type LoanRow = typeof LoanRow.Type;

/**
 * Everything the prompt context needs about a conversation, in one row (D5).
 *
 * `ContextBuilder` used to assemble this from six sequential selects — borrower, attempt, workflow,
 * contact point, loan, prior conversations — inside T1, holding the conversation row lock for all
 * six round trips. Five of them are one join; the sixth returns many rows and stays its own query.
 *
 * The loan half is nullable throughout because `primaryLoanForBorrower` was an `Option`: a borrower
 * with no loan has a public context and no protected one, which is a state the gate already knows.
 */
export const ConversationContextRow = Schema.Struct({
  borrowerName: Schema.String,
  borrowerTimezone: Schema.String,
  workflowExecutionId: Schema.String,
  contactPointId: Schema.String,
  workflowType: Schema.String,
  currentAttemptNo: Schema.Number,
  /** Null when the contact point has no override, and when there is no contact point row at all. */
  timezoneOverride: Schema.NullOr(Schema.String),
  loanId: Schema.NullOr(Schema.String),
  balanceDue: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  loanStatus: Schema.NullOr(LoanStatus),
  delinquencyDays: Schema.NullOr(Schema.Number),
  lastPromiseDate: Schema.NullOr(Schema.String),
});
export type ConversationContextRow = typeof ConversationContextRow.Type;

export const AgentVersionRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  promptHash: Schema.String,
  status: AgentVersionStatus,
});

export const WorkflowExecutionRow = Schema.Struct({
  id: Schema.String,
  borrowerId: Schema.String,
  loanId: Schema.String,
  workflowType: WorkflowType,
  status: WorkflowExecutionStatus,
  currentAttemptNo: Schema.Number,
  scheduledFor: Schema.NullOr(Ts),
});
export type WorkflowExecutionRow = typeof WorkflowExecutionRow.Type;

export const CallAttemptRow = Schema.Struct({
  id: Schema.String,
  workflowExecutionId: Schema.String,
  contactPointId: Schema.String,
  direction: CallDirection,
  providerCallId: Schema.NullOr(Schema.String),
  attemptStatus: CallAttemptStatus,
  startedAt: Ts,
  endedAt: Schema.NullOr(Ts),
});
export type CallAttemptRow = typeof CallAttemptRow.Type;

export const PendingProposalJson = Schema.Struct({
  kind: Schema.Literal("PROMISE_TO_PAY"),
  amount: Schema.String,
  date: Schema.String,
  proposed_at_seq: Schema.Number,
  read_back_turn_id: Schema.NullOr(Schema.String),
});
export type PendingProposalJson = typeof PendingProposalJson.Type;

export const ConversationRow = Schema.Struct({
  id: Schema.String,
  callAttemptId: Schema.String,
  borrowerId: Schema.String,
  agentVersionId: Schema.String,
  startedAt: Ts,
  endedAt: Schema.NullOr(Ts),
  finalOutcome: Schema.NullOr(Outcome),
  finalOutcomeMetadata: JsonRecord,
  channel: Schema.String,
  /** How the voice leg was established: "browser", "sip", or "simulated". Null before 0008. */
  origin: Schema.NullOr(Schema.String),
  transferTarget: Schema.NullOr(Schema.String),
  protectedContextUnlocked: Schema.Boolean,
  currentState: ConversationState,
  activeTurnId: Schema.NullOr(Schema.String),
  pendingProposal: Schema.NullOr(PendingProposalJson),
  noInputCount: Schema.Number,
});
export type ConversationRow = typeof ConversationRow.Type;

export const EventRow = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  sequenceNo: Schema.Number, // selected ::int
  type: EventType,
  payload: JsonRecord,
  createdAt: Ts,
});
export type EventRow = typeof EventRow.Type;

export const TurnRow = Schema.Struct({
  conversationId: Schema.String,
  turnId: Schema.String,
  status: Schema.Literal("RUNNING", "DONE", "SUPERSEDED", "FAILED"),
  userText: Schema.String,
  startedAt: Ts,
  finishedAt: Schema.NullOr(Ts),
  result: Schema.NullOr(JsonRecord),
});
export type TurnRow = typeof TurnRow.Type;

export const ScheduledActionRow = Schema.Struct({
  id: Schema.String,
  workflowExecutionId: Schema.String,
  actionType: ScheduledActionType,
  dueAt: Ts,
  status: ScheduledActionStatus,
  payload: JsonRecord,
});
export type ScheduledActionRow = typeof ScheduledActionRow.Type;

export const OutboxJobRow = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  jobType: OutboxJobType,
  status: OutboxJobStatus,
  payload: JsonRecord,
  result: JsonRecord,
  error: Schema.NullOr(Schema.String),
  availableAt: Ts,
  claimedAt: Schema.NullOr(Ts),
  processedAt: Schema.NullOr(Ts),
});
export type OutboxJobRow = typeof OutboxJobRow.Type;

export const HeartbeatRow = Schema.Struct({
  agentName: Schema.String,
  lastSeenAt: Ts,
  meta: JsonRecord,
});

export const ScoreRow = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  name: ScoreName,
  value: Schema.Number,
  dataType: ScoreDataType,
  stringValue: Schema.NullOr(Schema.String),
  source: ScoreSource,
  comment: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(JsonRecord),
  createdAt: Ts,
});
export type ScoreRow = typeof ScoreRow.Type;
