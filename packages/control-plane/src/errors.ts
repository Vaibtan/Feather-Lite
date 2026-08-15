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

export class TelephonyError extends Data.TaggedError("TelephonyError")<{
  readonly detail: string;
}> {}

export class UnknownScenario extends Data.TaggedError("UnknownScenario")<{
  readonly scenarioId: string;
}> {}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}
