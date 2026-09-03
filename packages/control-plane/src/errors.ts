import { Cause, Chunk, Data } from "effect";
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

export const TURN_START_ERROR_TAGS = ["NotFound", "ConversationCompleted", "TurnInProgress", "TurnSuperseded"] as const;

export type TurnStartError = NotFound | ConversationCompleted | TurnInProgress | TurnSuperseded;

// Compile-time proof that the tag list and the union stay in step.
const _tagsCoverUnion: ReadonlyArray<TurnStartError["_tag"]> = TURN_START_ERROR_TAGS;
void _tagsCoverUnion;

const isTurnStartError = (u: unknown): u is TurnStartError =>
  typeof u === "object" && u !== null && (TURN_START_ERROR_TAGS as ReadonlyArray<string>).includes(String((u as { _tag?: unknown })._tag));

// Walks `Cause.failures` rather than taking `failureOption`: a turn that fails alongside a sibling
// fiber produces a parallel cause, and the refusal can be on either side. A defect is not one of
// these — it is INTERNAL, not a 409.
export const turnStartErrorOf = (cause: Cause.Cause<unknown>): TurnStartError | null => {
  for (const f of Chunk.toReadonlyArray(Cause.failures(cause))) if (isTurnStartError(f)) return f;
  return null;
};

