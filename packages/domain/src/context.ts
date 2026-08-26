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

/** One prior call rendered as a single prompt line (research 2026-08-22 §3.3). */
export const PriorCallNote = Schema.Struct({
  outcome: Schema.String,
  /** ISO instant of the call's end, or null while a row is (unexpectedly) open. */
  ended_at: Schema.NullOr(Schema.String),
  /** Deterministic, ledger-derived one-liner: what actually happened on that call. */
  note: Schema.String,
});
export type PriorCallNote = typeof PriorCallNote.Type;

/** Compact, machine-readable memory from the last few conversations (PRD §5.2.3). */
export const MemoryBlock = Schema.Struct({
  recent_outcomes: Schema.Array(Schema.String),
  last_promise_to_pay: Schema.NullOr(Schema.Struct({ amount: Schema.String, date: Schema.String })),
  last_callback_requested_at: Schema.NullOr(Schema.String),
  last_right_party_contact_at: Schema.NullOr(Schema.String),
  prior_conversation_count: Schema.Number,
  /** Newest first, at most the memory window. Empty for a first-contact borrower. */
  prior_calls: Schema.Array(PriorCallNote),
});
export type MemoryBlock = typeof MemoryBlock.Type;

export const EMPTY_MEMORY: MemoryBlock = {
  recent_outcomes: [],
  last_promise_to_pay: null,
  last_callback_requested_at: null,
  last_right_party_contact_at: null,
  prior_conversation_count: 0,
  prior_calls: [],
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

/**
 * What each protected field sounds like when it is spoken out loud, for the post-call evaluator's
 * "no account detail before right-party confirmation" check.
 *
 * Keyed by the protected field it protects, and typed as a total `Record<keyof ProtectedContext,
 * ...>`, so the two halves of "protected" cannot drift: adding a field to `ProtectedContext` fails
 * to compile until someone says how that field sounds, and renaming one moves its pattern with it.
 * Co-locating a loose word list here would have looked the same and guaranteed nothing.
 *
 * `null` means the field has no general spoken form to match. A borrower's name is the case: it is
 * a per-borrower value, not a vocabulary, and it is already withheld structurally by
 * `visibleContext` — which is the real control. Everything here is a post-hoc audit over free text,
 * deliberately narrow, because a check that fires on a compliant call teaches operators to ignore it.
 */
export const PROTECTED_DISCLOSURE_PATTERNS: Readonly<Record<keyof ProtectedContext, RegExp | null>> = {
  borrower_full_name: null,
  balance_due: /\b(balance|amount (?:due|owed)|(?:you )?ow(?:e|es|ed|ing))\b/i,
  due_date: /\b(due date|due on|past due)\b/i,
  loan_status: /\b(delinquen\w*|in default|charged off)\b/i,
  delinquency_days: /\b(days? (?:late|past due|behind))\b/i,
  last_promise_date: /\b(previously promised|last promised)\b/i,
};

/** True when a spoken line discloses any protected field's subject matter. */
export const disclosesProtectedDetail = (text: string): boolean =>
  Object.values(PROTECTED_DISCLOSURE_PATTERNS).some((re) => re !== null && re.test(text));

const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));

const quote = (v: string | null, max: number): string | null => (v && v.trim().length > 0 ? `"${v.trim().slice(0, max)}"` : null);

/**
 * One deterministic line about a prior call, from its outcome + metadata (which carries the
 * override excerpts written at escalation time and the `wrap_up` the SUMMARY outbox job persists).
 * What a collector needs on attempt #3 is what the borrower said and committed to last time —
 * research 2026-08-22 §3.3; the outcome enum alone was the "thin" version.
 */
export const priorCallNote = (final_outcome: Outcome | null, meta: Readonly<Record<string, unknown>>): string => {
  const wrap = (typeof meta["wrap_up"] === "object" && meta["wrap_up"] !== null ? meta["wrap_up"] : {}) as Readonly<Record<string, unknown>>;
  const lastWords = quote(str(wrap["borrower_last"]), 140);
  const excerpt = quote(str(meta["transcript_excerpt"]), 140);
  const parts: string[] = [];
  switch (final_outcome) {
    case "PROMISE_TO_PAY":
      parts.push(`promised ${str(meta["promised_amount"]) ?? "?"} by ${str(meta["promised_date"]) ?? "?"}`);
      break;
    case "CALLBACK_SCHEDULED":
      parts.push(`asked to be called back at ${str(meta["callback_at"]) ?? "?"}`);
      break;
    case "DISPUTED":
      parts.push(`disputed the debt${excerpt ? `, saying ${excerpt}` : ""}`);
      break;
    case "ESCALATED":
      parts.push(str(meta["reason"]) === "hardship_or_distress" ? `expressed hardship${excerpt ? `, saying ${excerpt}` : ""}` : `escalated to a human${str(meta["reason"]) ? ` (${str(meta["reason"])})` : ""}`);
      break;
    case "OPT_OUT":
      parts.push("asked for no further calls");
      break;
    case "WRONG_NUMBER":
    case "THIRD_PARTY_CONTACT":
      parts.push("did not reach the borrower");
      break;
    default:
      parts.push(final_outcome === "NO_ANSWER" ? "no answer" : (final_outcome ?? "IN_PROGRESS").toLowerCase().replace(/_/g, " "));
  }
  if (lastWords && final_outcome !== "DISPUTED" && final_outcome !== "ESCALATED") parts.push(`their last words: ${lastWords}`);
  return parts.join("; ");
};

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
  const ptpAmount = str(lastPtp?.final_outcome_metadata["promised_amount"]);
  const ptpDate = str(lastPtp?.final_outcome_metadata["promised_date"]);
  return {
    recent_outcomes: recent.map((c) => c.final_outcome ?? "IN_PROGRESS"),
    last_promise_to_pay: ptpAmount && ptpDate ? { amount: ptpAmount, date: ptpDate } : null,
    last_callback_requested_at: str(lastCallback?.final_outcome_metadata["callback_at"]),
    last_right_party_contact_at: lastRightParty?.ended_at ?? null,
    prior_conversation_count: prior.length,
    prior_calls: recent.map((c) => ({
      outcome: c.final_outcome ?? "IN_PROGRESS",
      ended_at: c.ended_at,
      note: priorCallNote(c.final_outcome, c.final_outcome_metadata),
    })),
  };
};
