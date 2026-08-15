/**
 * Prompt context layers (PRD §5.2.3, SPEC §9).
 *
 * `PublicContext` may be shown to the model in any state. `ProtectedContext`
 * and the cross-call `MemoryBlock` may only be shown after right-party
 * verification *and* only in `PROTECTED_CONTEXT_STATES`. `visibleContext`
 * is the single gate both runtimes call before building a prompt; the leak
 * test asserts on its output for every state.
 */
import { Schema } from "effect";
import type { ConversationState, Outcome } from "./enums.js";
import { PROTECTED_CONTEXT_STATES } from "./stateMachine.js";

export const PublicContext = Schema.Struct({
  agent_name: Schema.String,
  company: Schema.String,
  callback_number: Schema.String,
  workflow_type: Schema.String,
  attempt_no: Schema.Number,
  /** Borrower's local date/time, e.g. "Friday, 21 August 2026, 2:05 PM" — public policy context. */
  local_time_description: Schema.String,
  borrower_first_name: Schema.String,
});
export type PublicContext = typeof PublicContext.Type;

export const ProtectedContext = Schema.Struct({
  borrower_full_name: Schema.String,
  balance_due: Schema.String,
  due_date: Schema.String,
  loan_status: Schema.String,
  delinquency_days: Schema.Number,
  last_promise_date: Schema.NullOr(Schema.String),
});
export type ProtectedContext = typeof ProtectedContext.Type;

/** Compact, machine-readable memory from the last few conversations (PRD §5.2.3). */
export const MemoryBlock = Schema.Struct({
  recent_outcomes: Schema.Array(Schema.String),
  last_promise_to_pay: Schema.NullOr(Schema.Struct({ amount: Schema.String, date: Schema.String })),
  last_callback_requested_at: Schema.NullOr(Schema.String),
  last_right_party_contact_at: Schema.NullOr(Schema.String),
  prior_conversation_count: Schema.Number,
});
export type MemoryBlock = typeof MemoryBlock.Type;

export const EMPTY_MEMORY: MemoryBlock = {
  recent_outcomes: [],
  last_promise_to_pay: null,
  last_callback_requested_at: null,
  last_right_party_contact_at: null,
  prior_conversation_count: 0,
};

export interface ContextBundle {
  readonly publicContext: PublicContext;
  readonly protectedContext: ProtectedContext | null;
  readonly memory: MemoryBlock;
}

export interface VisibleContext {
  readonly publicContext: PublicContext;
  /** `null` unless verified AND in a state where account discussion is permitted. */
  readonly protectedContext: ProtectedContext | null;
  readonly memory: MemoryBlock | null;
}

/**
 * The gate. Protected data is visible only when BOTH conditions hold:
 * right-party verified, and the current state permits account discussion.
 */
export const visibleContext = (
  bundle: ContextBundle,
  state: ConversationState,
  protectedContextUnlocked: boolean,
): VisibleContext => {
  const allowed = protectedContextUnlocked && PROTECTED_CONTEXT_STATES.has(state);
  return {
    publicContext: bundle.publicContext,
    protectedContext: allowed ? bundle.protectedContext : null,
    memory: allowed ? bundle.memory : null,
  };
};

/** Fields whose values must never appear in a prompt before unlock — used by the leak test. */
export const PROTECTED_FIELD_NAMES: ReadonlyArray<keyof ProtectedContext> = [
  "borrower_full_name",
  "balance_due",
  "due_date",
  "loan_status",
  "delinquency_days",
  "last_promise_date",
];

/** Build a memory block from prior conversations, newest first. Pure. */
export const buildMemoryBlock = (
  prior: ReadonlyArray<{
    readonly final_outcome: Outcome | null;
    readonly ended_at: string | null;
    readonly protected_context_unlocked: boolean;
    readonly final_outcome_metadata: Readonly<Record<string, unknown>>;
  }>,
  limit = 5,
): MemoryBlock => {
  const recent = prior.slice(0, limit);
  const lastPtp = recent.find((c) => c.final_outcome === "PROMISE_TO_PAY");
  const lastCallback = recent.find((c) => c.final_outcome === "CALLBACK_SCHEDULED");
  const lastRightParty = recent.find((c) => c.protected_context_unlocked && c.ended_at);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
  const ptpAmount = str(lastPtp?.final_outcome_metadata["promised_amount"]);
  const ptpDate = str(lastPtp?.final_outcome_metadata["promised_date"]);
  return {
    recent_outcomes: recent.map((c) => c.final_outcome ?? "IN_PROGRESS"),
    last_promise_to_pay: ptpAmount && ptpDate ? { amount: ptpAmount, date: ptpDate } : null,
    last_callback_requested_at: str(lastCallback?.final_outcome_metadata["callback_at"]),
    last_right_party_contact_at: lastRightParty?.ended_at ?? null,
    prior_conversation_count: prior.length,
  };
};
