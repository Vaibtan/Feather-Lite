/**
 * Prompt construction for the LLM decider. Pure: (DeciderInput) -> messages + tools.
 * The gate is applied upstream (`visibleContext`); this module renders ONLY what it is given,
 * and the leak test asserts on the rendered request. Copy is tuned for TTS: short sentences,
 * one question at a time, no markup.
 */
import { JSONSchema, type Schema } from "effect";
import type { ConversationState, ToolName } from "@feather-lite/domain";
import { TOOL_ARG_SCHEMAS, TOOL_DESCRIPTIONS } from "@feather-lite/domain";
import type { DeciderInput } from "../services/types.js";
import type { ChatMessage, ToolSpec } from "./LlmClient.js";

/** Pseudo-tools that only suggest a state change; the orchestrator validates them like any suggestion. */
export const PSEUDO_TOOLS = {
  end_call: { description: "End the call politely when nothing else can be done (borrower must go, refuses to continue, or the conversation is complete). Do not use to record outcomes.", nextState: "ENDING" as ConversationState },
  request_human: { description: "The borrower asks for a human agent or supervisor, or the situation needs a person. Transfers the call.", nextState: "WARM_TRANSFER_PENDING" as ConversationState },
  renegotiate: { description: "The borrower declines or changes the read-back proposal; go back to discussing amount and date.", nextState: "DISCUSSING_PAYMENT" as ConversationState },
} as const;
export type PseudoToolName = keyof typeof PSEUDO_TOOLS;

const PSEUDO_BY_STATE: Readonly<Record<ConversationState, ReadonlyArray<PseudoToolName>>> = {
  GREETING: ["end_call"],
  VERIFYING_IDENTITY: ["end_call"],
  DISCUSSING_PAYMENT: ["end_call", "request_human"],
  CONFIRMING_OUTCOME: ["renegotiate", "end_call", "request_human"],
  VOICEMAIL: ["end_call"],
  THIRD_PARTY_OR_WRONG_PARTY: ["end_call"],
  WARM_TRANSFER_PENDING: ["end_call"],
  OPT_OUT: ["end_call"],
  WRONG_NUMBER: ["end_call"],
  ESCALATED: ["end_call"],
  ENDING: ["end_call"],
  COMPLETED: [],
};

const toolSpec = (name: ToolName): ToolSpec => {
  const schema = JSONSchema.make(TOOL_ARG_SCHEMAS[name] as unknown as Schema.Schema<unknown>) as unknown as Record<string, unknown>;
  // Strip Effect's envelope; empty structs become an explicit empty object schema.
  const { $schema: _s, $id: _i, ...rest } = schema;
  const parameters = "properties" in rest ? rest : { type: "object", properties: {}, additionalProperties: false };
  return { name, description: TOOL_DESCRIPTIONS[name], parameters };
};

export const toolSpecsFor = (state: ConversationState, allowed: ReadonlyArray<ToolName>): ReadonlyArray<ToolSpec> => [
  ...allowed.map(toolSpec),
  ...PSEUDO_BY_STATE[state].map((p) => ({
    name: p,
    description: PSEUDO_TOOLS[p].description,
    parameters: { type: "object", properties: { reason: { type: "string", description: "one short sentence" } }, additionalProperties: false },
  })),
];

const weekdayOf = (isoDate: string): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
};

const stateGuidance = (input: DeciderInput): string => {
  const n = input.borrowerFirstName;
  switch (input.state) {
    case "GREETING":
    case "VERIFYING_IDENTITY":
      return [
        `You have asked to speak with ${n}. Your only job now is to establish who is on the line.`,
        `- If the person clearly confirms they are ${n} (e.g. "yes", "speaking", "this is ${n}"): call confirm_right_party with confirmed=true. Say nothing else.`,
        `- If someone else answers, ${n} is unavailable, or they offer to take a message: call record_wrong_party_contact with outcome_type=THIRD_PARTY_CONTACT.`,
        `- If they say it is the wrong number or ${n} does not live there: call record_wrong_party_contact with outcome_type=WRONG_NUMBER.`,
        `- If they ask who is calling or what it is about: say you are calling from the company for ${n} and can only discuss it with ${n}; then ask again if you are speaking with ${n}.`,
        `- Do NOT mention any account, balance, loan, payment or debt details before confirmation.`,
      ].join("\n");
    case "DISCUSSING_PAYMENT":
      return [
        `${n} is verified. The account statement (balance and due date) has ALREADY been read to them; only repeat it if asked.`,
        `Goal: obtain a concrete promise to pay (amount AND date) or schedule a callback.`,
        `- When they name an amount and a date: call propose_promise_to_pay with amount and an ISO date. Convert relative dates yourself.`,
        `- When they offer to pay by a date without naming an amount ("I can pay on Friday"): treat it as the full balance and call propose_promise_to_pay; the read-back confirmation protects them. Only ask what amount if they hinted at a partial payment.`,
        `- If they name an amount but no date, ask by what date. Never invent an amount they neither said nor implied.`,
        `- If they ask to be called back: call schedule_callback with an ISO-8601 datetime WITH timezone offset in the borrower's timezone.`,
        `- If they ask for a human or supervisor: call request_human.`,
        `- Answer brief questions about the balance/due date from the account context. Never invent fees, interest, or consequences.`,
      ].join("\n");
    case "CONFIRMING_OUTCOME": {
      const p = input.pendingProposal;
      const desc = p ? `${p.amount} on ${p.date}` : "the proposal";
      return [
        `The system has just read back the proposal: pay ${desc}. Wait for the borrower's answer.`,
        `- If they confirm (yes / correct / that's right): call record_promise_to_pay with confirmed=true. Say nothing else.`,
        `- If they decline or want to change the amount or date: call renegotiate.`,
        `- If they ask for a callback instead: call schedule_callback.`,
      ].join("\n");
    }
    default:
      return "The call is wrapping up. Be brief and polite; call end_call.";
  }
};

const joinLines = (lines: ReadonlyArray<string>): string => lines.filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");

/**
 * Message layout, and why it is in this order:
 *
 *   [0] system   persona + phone manner + RULES  -- identical on every turn
 *   [1..n]       the transcript so far           -- append-only as the call proceeds
 *   [n+1] system state, guidance, time, account  -- rewritten every turn
 *   [n+2] user   what the borrower just said
 *
 * OpenAI caches on exact prefix matches and instructs callers to "place static content like
 * instructions and examples at the beginning of your prompt, and put variable content, such as
 * user-specific information, at the end"
 * (<https://developers.openai.com/api/docs/guides/prompt-caching>). The volatile block used to be
 * message #0: it carries CURRENT STATE and a local time rendered down to the minute, so the
 * cacheable prefix collapsed to nothing every time the minute rolled over. Moving it behind the
 * history makes everything before it append-only, which is exactly the shape a prefix cache wants.
 *
 * Two things not to fight: caching needs >=1,024 tokens of prefix (same page), so short calls will
 * not cache at all; and `tools` are part of the prefix and change per state via `toolSpecsFor`, so
 * the cache re-warms at each state transition. Both are expected -- measure `cached_tokens` rather
 * than assuming a hit.
 */
export const buildMessages = (input: DeciderInput): ReadonlyArray<ChatMessage> => {
  const pc = input.context.publicContext;
  const prot = input.context.protectedContext;
  const mem = input.context.memory;

  // Everything in this block is state-independent on purpose: together with `tools` it forms the
  // prompt prefix OpenAI's cache matches on, and it is sized to put that prefix past the ~1,024
  // token floor below which `cached_tokens` stays 0 for an entire short call (measured: a 4-turn
  // call peaked at 979 prompt tokens and never cached). The content is real guidance, not padding.
  const persona = joinLines([
    `You are ${pc.agent_name}, a voice agent for ${pc.company}, on a live phone call. This is a debt-collection call in the United States; you must be respectful, calm and truthful (FDCPA/UDAAP).`,
    `Speak for a phone: one or two short sentences, one question at a time, no lists, no markdown, no emojis, no phone-tree tone. Never invent numbers, dates, fees or policies.`,
    ``,
    `RULES:`,
    `- Tools are the only way to change what the system does. Call at most one tool per turn; when you call a tool, do not also write a message.`,
    `- Never say that anything has been recorded, scheduled, confirmed or updated. The system says that itself after it is saved.`,
    `- If the borrower expresses hardship, disputes the debt, or asks you to stop calling, do not argue or push; the system handles those.`,
    `- If unsure what they meant, ask a short clarifying question.`,
    ``,
    `COMPLIANCE (always in force, whatever the state):`,
    `- Identify yourself and the company honestly. Never claim to be an attorney, a government body, or a credit bureau, and never imply legal action, arrest, wage garnishment, credit damage, or any other consequence. You state facts about the account; you never predict outcomes.`,
    `- Discuss the debt only with the verified borrower. Until identity is confirmed, reveal nothing: not the balance, not the creditor, not even that this call concerns a debt.`,
    `- If they say it is an inconvenient time, offer to call back rather than pressing on.`,
    `- Never mock, scold, rush, or talk down to the borrower, whatever they say. If they are angry, stay level and factual. If they use profanity, do not mirror it.`,
    `- Do not give financial, legal, or tax advice. Payment arrangements exist only through the tools.`,
    `- If they mention bankruptcy or an attorney representing them on this debt, stop collecting and let the system handle it.`,
    ``,
    `SPEAKING STYLE (your text is spoken aloud by TTS):`,
    `- Say amounts naturally: "one hundred twenty dollars", not "$120.00". Say dates fully: "Friday, August twenty-eighth", never "08/28".`,
    `- No abbreviations, no acronyms the ear cannot parse, no URLs, no spelled-out punctuation.`,
    `- Use the borrower's first name occasionally; do not begin every sentence with it.`,
    `- One idea per sentence. A question, if any, comes last, and there is only one.`,
    `- Silence beats filler: never say "just a moment", "let me check", or "bear with me".`,
    ``,
    `TOOL DISCIPLINE:`,
    `- Use only the tools offered in this request; never invent a tool or an argument value the borrower did not give or clearly imply.`,
    `- Amounts are decimal strings ("120.00"); dates are ISO ("2026-03-14"); resolve relative dates like "Friday" or "next week" yourself from the borrower's local date in the context block.`,
    `- If no tool fits what just happened, reply with one short sentence instead; never force a tool call.`,
    `- A rejected or failed tool call is not something to explain to the borrower; continue naturally from what the system says next.`,
  ]);

  const current = joinLines([
    `CURRENT STATE: ${input.state}`,
    stateGuidance(input),
    ``,
    `CALL CONTEXT: workflow ${pc.workflow_type}, attempt ${pc.attempt_no}. Borrower first name: ${pc.borrower_first_name}. Borrower local time: ${pc.local_time_description}. Today for the borrower is ${input.borrowerLocalDate} (${weekdayOf(input.borrowerLocalDate)}), timezone ${input.borrowerTimeZone}. Callback number to give if asked: ${pc.callback_number}.`,
    prot
      ? `ACCOUNT (verified borrower only): name ${prot.borrower_full_name}; balance due ${prot.balance_due}; due date ${prot.due_date}; status ${prot.loan_status}; ${prot.delinquency_days} days delinquent${prot.last_promise_date ? `; last promise date ${prot.last_promise_date}` : ""}.`
      : `ACCOUNT: not available in this state. Do not discuss balances, due dates, loans or payments.`,
    mem
      ? joinLines([
          `HISTORY: ${mem.prior_conversation_count} prior call(s)${mem.last_promise_to_pay ? `; last promise ${mem.last_promise_to_pay.amount} by ${mem.last_promise_to_pay.date}` : ""}${mem.last_callback_requested_at ? `; last callback requested for ${mem.last_callback_requested_at}` : ""}.`,
          // One deterministic line per prior call (newest first), from the ledger wrap-up — what
          // they said and committed to, not just the outcome enum (research 2026-08-22 §3.3).
          ...mem.prior_calls.map((c) => `- ${c.ended_at ? c.ended_at.slice(0, 10) : "(unknown date)"}: ${c.note}`),
        ])
      : ``,
    input.heardAgentText !== null ? `NOTE: the borrower interrupted your previous sentence; they heard only: "${input.heardAgentText}".` : ``,
  ]);

  const history: ChatMessage[] = input.recentTranscript.map((t) => ({ role: t.speaker === "AGENT" ? "assistant" : "user", content: t.text }));
  // The current turn's borrower line is already the last transcript entry; it is spoken once, at the
  // very end, after the volatile block -- so it must not also sit inside the append-only history.
  const last = history.at(-1);
  if (last && last.role === "user" && last.content === input.userText) history.pop();

  return [
    { role: "system", content: persona },
    ...history,
    { role: "system", content: current },
    { role: "user", content: input.userText },
  ];
};
