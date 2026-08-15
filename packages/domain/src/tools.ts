/**
 * LLM-callable domain tools (SPEC §10) and their state eligibility (SPEC §10.6).
 *
 * The state-scoped tool matrix is enforced identically on every path
 * (simulation, scenario runner, voice): a tool invoked outside its states
 * fails closed and is recorded as a TOOL_REJECTED event.
 *
 * Call-control operations (hangup, voicemail drop, transfer, hold) are *not*
 * here — they are runtime operations, never LLM tools (SPEC §10.3).
 */
import { Data, Either, ParseResult, Schema } from "effect";
import type { ConversationState } from "./enums.js";
import { Outcome } from "./enums.js";
import { ToolCallId } from "./ids.js";
import { IsoDate, IsoDateTime, MoneyAmount } from "./values.js";

export const TOOL_NAMES = [
  "lookup_contact_profile",
  "confirm_right_party",
  "get_account_context",
  "propose_promise_to_pay",
  "record_promise_to_pay",
  "schedule_callback",
  "record_opt_out",
  "record_wrong_party_contact",
] as const;
export const ToolName = Schema.Literal(...TOOL_NAMES);
export type ToolName = typeof ToolName.Type;

/* ------------------------------------------------------------------ */
/* Argument schemas — the LLM's JSON must decode through these          */
/* ------------------------------------------------------------------ */

export const LookupContactProfileArgs = Schema.Struct({});
export const ConfirmRightPartyArgs = Schema.Struct({
  confirmed: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export const GetAccountContextArgs = Schema.Struct({});
/**
 * Step 1 of the promise-to-pay handshake: the model proposes what it heard.
 * The orchestrator stores it as the *pending proposal* and reads it back
 * verbatim to the borrower (non-interruptible).
 */
export const ProposePromiseToPayArgs = Schema.Struct({
  date: IsoDate,
  amount: MoneyAmount,
  notes: Schema.optional(Schema.String),
});
/**
 * Step 2: after the borrower confirms the read-back, the model calls this with
 * `confirmed: true`. Amount and date are taken ONLY from the pending proposal
 * (PRD §5.2.8 "verbal confirmation before outcome recording", plan rev.2 R18).
 */
export const RecordPromiseToPayArgs = Schema.Struct({
  confirmed: Schema.Literal(true),
});
export const ScheduleCallbackArgs = Schema.Struct({
  datetime: IsoDateTime,
  reason: Schema.optional(Schema.String),
});
export const RecordOptOutArgs = Schema.Struct({
  scope: Schema.Literal("borrower", "contact_point"),
  reason: Schema.optional(Schema.String),
});
export const RecordWrongPartyContactArgs = Schema.Struct({
  outcome_type: Schema.Literal("WRONG_NUMBER", "THIRD_PARTY_CONTACT"),
  notes: Schema.optional(Schema.String),
});

export const TOOL_ARG_SCHEMAS = {
  lookup_contact_profile: LookupContactProfileArgs,
  confirm_right_party: ConfirmRightPartyArgs,
  get_account_context: GetAccountContextArgs,
  propose_promise_to_pay: ProposePromiseToPayArgs,
  record_promise_to_pay: RecordPromiseToPayArgs,
  schedule_callback: ScheduleCallbackArgs,
  record_opt_out: RecordOptOutArgs,
  record_wrong_party_contact: RecordWrongPartyContactArgs,
} as const satisfies Record<ToolName, Schema.Schema.Any>;

export type ToolArgs = { readonly [K in ToolName]: Schema.Schema.Type<(typeof TOOL_ARG_SCHEMAS)[K]> };

/** Human-readable descriptions handed to the LLM as tool definitions. */
export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  lookup_contact_profile: "Look up the phone number's validity and consent status.",
  confirm_right_party:
    "Record whether the person on the line has confirmed they are the borrower on the account. Call with confirmed=true only after an explicit affirmative from the person; confirmed=false if they say they are someone else.",
  get_account_context: "Fetch balance due, due date, loan status and delinquency for the verified borrower.",
  propose_promise_to_pay:
    "Propose a promise-to-pay you heard from the borrower (amount and ISO date). The system will read it back to the borrower for confirmation; do not claim anything is recorded.",
  record_promise_to_pay:
    "Call with confirmed=true ONLY when the borrower has said yes to the read-back of the pending proposal. The system records the pending amount/date and confirms to the borrower. If they decline, do not call this; move back to discussing payment.",
  schedule_callback: "Schedule a callback at the borrower's requested date/time (ISO-8601 with timezone).",
  record_opt_out: "Record a request to stop contact. scope=borrower stops all contact; scope=contact_point stops this number only.",
  record_wrong_party_contact:
    "Record that the number reached the wrong party. outcome_type=WRONG_NUMBER invalidates the number; THIRD_PARTY_CONTACT keeps it (borrower may answer next time).",
};

/* ------------------------------------------------------------------ */
/* State eligibility (SPEC §10.6 + confirm_right_party)                 */
/* ------------------------------------------------------------------ */

export const TOOL_STATE_MATRIX: Readonly<Record<ToolName, ReadonlySet<ConversationState>>> = {
  lookup_contact_profile: new Set(["GREETING", "VERIFYING_IDENTITY"]),
  confirm_right_party: new Set(["GREETING", "VERIFYING_IDENTITY"]),
  get_account_context: new Set(["DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME"]),
  propose_promise_to_pay: new Set(["DISCUSSING_PAYMENT"]),
  record_promise_to_pay: new Set(["CONFIRMING_OUTCOME"]),
  schedule_callback: new Set(["DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME"]),
  record_opt_out: new Set(["OPT_OUT"]),
  record_wrong_party_contact: new Set(["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "WRONG_NUMBER"]),
};

export const toolAllowed = (tool: ToolName, state: ConversationState): boolean =>
  TOOL_STATE_MATRIX[tool].has(state);

/** Tools the LLM may see in a given state — the allowlist handed to the prompt builder. */
export const toolsForState = (state: ConversationState): ReadonlyArray<ToolName> =>
  TOOL_NAMES.filter((tool) => TOOL_STATE_MATRIX[tool].has(state));

/** Tools whose successful execution commits a final outcome. */
export const OUTCOME_TOOLS: Readonly<Partial<Record<ToolName, Outcome | "BY_ARGS">>> = {
  record_promise_to_pay: "PROMISE_TO_PAY",
  schedule_callback: "CALLBACK_SCHEDULED",
  record_opt_out: "OPT_OUT",
  record_wrong_party_contact: "BY_ARGS", // WRONG_NUMBER | THIRD_PARTY_CONTACT
};

/* ------------------------------------------------------------------ */
/* Tool call value + validation                                         */
/* ------------------------------------------------------------------ */

/** A tool invocation as proposed by the conversationalist. Args are still raw JSON. */
export const ToolCall = Schema.Struct({
  name: ToolName,
  toolCallId: Schema.optional(ToolCallId),
  args: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type ToolCall = typeof ToolCall.Type;

export class ToolNotAllowed extends Data.TaggedError("ToolNotAllowed")<{
  readonly tool: ToolName;
  readonly state: ConversationState;
}> {
  override get message(): string {
    return `Tool ${this.tool} is not allowed in state ${this.state}`;
  }
}

export class ToolArgsInvalid extends Data.TaggedError("ToolArgsInvalid")<{
  readonly tool: ToolName;
  readonly detail: string;
}> {
  override get message(): string {
    return `Invalid arguments for ${this.tool}: ${this.detail}`;
  }
}

/**
 * Validate a proposed tool call against the state matrix and the tool's
 * argument schema. Returns typed args on success. Pure.
 */
export const validateToolCall = <N extends ToolName>(
  call: ToolCall & { readonly name: N },
  state: ConversationState,
): Either.Either<ToolArgs[N], ToolNotAllowed | ToolArgsInvalid> => {
  if (!toolAllowed(call.name, state)) {
    return Either.left(new ToolNotAllowed({ tool: call.name, state }));
  }
  // The mapped lookup is exact at runtime; TS cannot unify the struct union with the mapped type.
  const schema = TOOL_ARG_SCHEMAS[call.name] as unknown as Schema.Schema<ToolArgs[N], unknown>;
  return Schema.decodeUnknownEither(schema)(call.args).pipe(
    Either.mapLeft(
      (error) => new ToolArgsInvalid({ tool: call.name, detail: ParseResult.TreeFormatter.formatErrorSync(error) }),
    ),
  );
};
