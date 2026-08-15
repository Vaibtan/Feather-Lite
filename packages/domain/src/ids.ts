/**
 * Branded identifiers. A `ConversationId` cannot be passed where a
 * `BorrowerId` is expected — the compiler catches the class of bug that
 * `UUID` columns invite.
 */
import { Schema } from "effect";

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const BorrowerId = brandedUuid("BorrowerId");
export type BorrowerId = typeof BorrowerId.Type;

export const ContactPointId = brandedUuid("ContactPointId");
export type ContactPointId = typeof ContactPointId.Type;

export const LoanId = brandedUuid("LoanId");
export type LoanId = typeof LoanId.Type;

export const AgentVersionId = brandedUuid("AgentVersionId");
export type AgentVersionId = typeof AgentVersionId.Type;

export const WorkflowExecutionId = brandedUuid("WorkflowExecutionId");
export type WorkflowExecutionId = typeof WorkflowExecutionId.Type;

export const CallAttemptId = brandedUuid("CallAttemptId");
export type CallAttemptId = typeof CallAttemptId.Type;

export const ConversationId = brandedUuid("ConversationId");
export type ConversationId = typeof ConversationId.Type;

export const ScheduledActionId = brandedUuid("ScheduledActionId");
export type ScheduledActionId = typeof ScheduledActionId.Type;

export const OutboxJobId = brandedUuid("OutboxJobId");
export type OutboxJobId = typeof OutboxJobId.Type;

/** Provider-supplied or derived id used to make tool execution idempotent. */
export const ToolCallId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

/** Idempotency key for call-control actions (telephony providers retry). */
export const ActionId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ActionId"));
export type ActionId = typeof ActionId.Type;
