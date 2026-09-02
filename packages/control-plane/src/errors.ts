/**
 * The control plane's typed error channel (plan §5 error registry). Every failure a caller
 * can see has a name here; HTTP mapping lives in the API layer.
 */
import { Data } from "effect";
import type { PreCallFailure } from "@feather-lite/domain";

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: string;
  readonly id: string;
}> {
  override get message(): string {
    return `${this.entity} ${this.id} not found`;
  }
}

export class PreCallRejected extends Data.TaggedError("PreCallRejected")<{
  readonly failures: ReadonlyArray<PreCallFailure>;
}> {
  override get message(): string {
    return `Pre-call validation failed: ${this.failures.join(", ")}`;
  }
}

export class ConversationCompleted extends Data.TaggedError("ConversationCompleted")<{
  readonly conversationId: string;
}> {
  override get message(): string {
    return `Conversation ${this.conversationId} is already completed`;
  }
}

/**
 * The turn id was superseded by a later turn, and is not runnable again (issue #4, C9).
 *
 * Distinct from `TurnInProgress`, which says somebody else holds the line *now*: this one says this
 * particular turn is over, decided against, and re-sending it would append the borrower's line and
 * a fresh reply to a turn the ledger has already closed.
 */
export class TurnSuperseded extends Data.TaggedError("TurnSuperseded")<{
  readonly conversationId: string;
  readonly turnId: string;
}> {
  override get message(): string {
    return `Turn ${this.turnId} on conversation ${this.conversationId} was superseded by a later turn`;
  }
}

export class TurnInProgress extends Data.TaggedError("TurnInProgress")<{
  readonly conversationId: string;
  readonly activeTurnId: string;
}> {
  override get message(): string {
    return `Conversation ${this.conversationId} already has turn ${this.activeTurnId} in progress`;
  }
}

export class TurnDeciderUnavailable extends Data.TaggedError("TurnDeciderUnavailable")<{
  readonly detail: string;
}> {}

export class TurnDeciderInvalidOutput extends Data.TaggedError("TurnDeciderInvalidOutput")<{
  readonly detail: string;
}> {}

/**
 * A non-streaming model call failed. Distinct from `TurnDeciderUnavailable` because nothing about
 * it concerns a turn: the judge runs post-call in the outbox, where the answer to a failure is a
 * retry on the job's own budget, not a degraded reply to a waiting borrower.
 */
export class LlmCallFailed extends Data.TaggedError("LlmCallFailed")<{
  readonly detail: string;
}> {}

export class TelephonyError extends Data.TaggedError("TelephonyError")<{
  readonly detail: string;
}> {}

export class UnknownScenario extends Data.TaggedError("UnknownScenario")<{
  readonly scenarioId: string;
}> {}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}
