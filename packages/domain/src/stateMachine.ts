/**
 * The collections state machine (PRD §5.2.2, SPEC §8).
 *
 * The state machine is the *enforcer*: it decides which transitions are legal,
 * which states are terminal, and which transitions may only be taken by
 * deterministic override rules. The LLM never sees this module; it only ever
 * *suggests* a next state, and `transition` decides.
 */
import { Data, Either } from "effect";
import type { ConversationState, TransitionTrigger } from "./enums.js";

/** Normal (LLM-suggestible) edges. SPEC §8.1 verbatim. */
export const ADJACENCY: Readonly<Record<ConversationState, ReadonlySet<ConversationState>>> = {
  GREETING: new Set(["VOICEMAIL", "VERIFYING_IDENTITY"]),
  VERIFYING_IDENTITY: new Set(["THIRD_PARTY_OR_WRONG_PARTY", "DISCUSSING_PAYMENT"]),
  DISCUSSING_PAYMENT: new Set([
    "CONFIRMING_OUTCOME",
    "WARM_TRANSFER_PENDING",
    "WRONG_NUMBER",
    "OPT_OUT",
  ]),
  // Borrower may decline the read-back and renegotiate (plan rev.2 R17).
  CONFIRMING_OUTCOME: new Set(["ENDING", "DISCUSSING_PAYMENT"]),
  VOICEMAIL: new Set(["ENDING"]),
  THIRD_PARTY_OR_WRONG_PARTY: new Set(["ENDING"]),
  WARM_TRANSFER_PENDING: new Set(["ENDING"]),
  OPT_OUT: new Set(["ENDING"]),
  WRONG_NUMBER: new Set(["ENDING"]),
  ESCALATED: new Set(["ENDING"]),
  ENDING: new Set(["COMPLETED"]),
  COMPLETED: new Set(),
};

/**
 * States reachable from *any* non-terminal state, but only through a
 * deterministic override rule — never through an LLM suggestion.
 */
export const OVERRIDE_TARGETS: ReadonlySet<ConversationState> = new Set([
  "OPT_OUT",
  "WRONG_NUMBER",
  "ESCALATED",
]);

/**
 * Runtime-forced transitions (plan rev.2 R17): taken by the runtime itself —
 * never suggested by the LLM — and legal from any non-terminal state.
 *   * -> ENDING     no-input close, hangup, provider failure
 *   * -> VOICEMAIL  answering-machine detected
 */
export const FORCED_TARGETS: ReadonlySet<ConversationState> = new Set(["ENDING", "VOICEMAIL"]);

/** States in which the conversation cannot receive further user turns. */
export const TERMINAL_STATES: ReadonlySet<ConversationState> = new Set(["COMPLETED"]);

/** States that mean "the call is wrapping up"; no protected context should be spoken here. */
export const CLOSING_STATES: ReadonlySet<ConversationState> = new Set([
  "VOICEMAIL",
  "THIRD_PARTY_OR_WRONG_PARTY",
  "WARM_TRANSFER_PENDING",
  "OPT_OUT",
  "WRONG_NUMBER",
  "ESCALATED",
  "ENDING",
  "COMPLETED",
]);

/** The only states in which protected borrower/account context may be injected (SPEC §9). */
export const PROTECTED_CONTEXT_STATES: ReadonlySet<ConversationState> = new Set([
  "DISCUSSING_PAYMENT",
  "CONFIRMING_OUTCOME",
]);

export const isTerminal = (state: ConversationState): boolean => TERMINAL_STATES.has(state);

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly from: ConversationState;
  readonly to: ConversationState;
  readonly reason: "NOT_ADJACENT" | "OVERRIDE_ONLY" | "TERMINAL";
}> {
  override get message(): string {
    return `Invalid transition ${this.from} -> ${this.to} (${this.reason})`;
  }
}

/**
 * Validate a transition suggested by the conversationalist (LLM or scripted).
 *
 * - `to === undefined` or `to === from` means "stay" and is always legal.
 * - Terminal states admit nothing.
 * - Override targets are rejected here (`OVERRIDE_ONLY`) — use `overrideTransition`.
 */
export const transition = (
  from: ConversationState,
  to: ConversationState | null | undefined,
): Either.Either<ConversationState, InvalidTransition> => {
  if (to === undefined || to === null || to === from) return Either.right(from);
  if (isTerminal(from)) return Either.left(new InvalidTransition({ from, to, reason: "TERMINAL" }));
  if (ADJACENCY[from].has(to)) return Either.right(to);
  if (OVERRIDE_TARGETS.has(to)) {
    return Either.left(new InvalidTransition({ from, to, reason: "OVERRIDE_ONLY" }));
  }
  return Either.left(new InvalidTransition({ from, to, reason: "NOT_ADJACENT" }));
};

/**
 * Transition taken by a deterministic override rule. Legal from every
 * non-terminal state, only into `OVERRIDE_TARGETS`.
 */
export const overrideTransition = (
  from: ConversationState,
  to: ConversationState,
): Either.Either<ConversationState, InvalidTransition> => {
  if (isTerminal(from)) return Either.left(new InvalidTransition({ from, to, reason: "TERMINAL" }));
  if (!OVERRIDE_TARGETS.has(to)) {
    return Either.left(new InvalidTransition({ from, to, reason: "NOT_ADJACENT" }));
  }
  return Either.right(to);
};

/**
 * Transition forced by the runtime (AMD, no-input close, hangup). Legal from
 * every non-terminal state into `FORCED_TARGETS`.
 */
export const forcedTransition = (
  from: ConversationState,
  to: ConversationState,
): Either.Either<ConversationState, InvalidTransition> => {
  if (isTerminal(from)) return Either.left(new InvalidTransition({ from, to, reason: "TERMINAL" }));
  if (!FORCED_TARGETS.has(to)) {
    return Either.left(new InvalidTransition({ from, to, reason: "NOT_ADJACENT" }));
  }
  return Either.right(to);
};

/**
 * The trigger recorded on a STATE_TRANSITION event for a given move.
 * Kept here so both runtimes stamp identical events (SPEC §10.5).
 */
export const triggerFor = (
  from: ConversationState,
  to: ConversationState,
  via: "llm" | "override" | "amd" | "system",
): TransitionTrigger => {
  if (via === "override") return "OVERRIDE_RULE";
  if (via === "amd") return "AMD";
  if (via === "system") return "SYSTEM_START";
  if (from === "VERIFYING_IDENTITY" && to === "DISCUSSING_PAYMENT") return "RIGHT_PARTY_CONFIRMED";
  if (from === "DISCUSSING_PAYMENT" && to === "CONFIRMING_OUTCOME") return "PROPOSAL";
  if (from === "CONFIRMING_OUTCOME" && to === "DISCUSSING_PAYMENT") return "USER_DECLINED";
  return "LLM_INTENT";
};

/**
 * The closing path every finalized conversation walks: `current -> ENDING -> COMPLETED`.
 * Returns the list of (from, to) edges to record; empty `from === ENDING` first hop is skipped.
 */
export const closingPath = (
  current: ConversationState,
): ReadonlyArray<readonly [ConversationState, ConversationState]> => {
  if (current === "COMPLETED") return [];
  if (current === "ENDING") return [["ENDING", "COMPLETED"]];
  return [
    [current, "ENDING"],
    ["ENDING", "COMPLETED"],
  ];
};
