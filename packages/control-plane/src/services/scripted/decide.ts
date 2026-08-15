/**
 * Deterministic stand-in for the LLM. It behaves the way a well-prompted model should
 * given the state-scoped tools: it never confirms outcomes itself (the orchestrator does,
 * from the committed record), it proposes rather than records promises, and it uses
 * `confirm_right_party` instead of guessing.
 *
 * Only reachable via the `scripted` decider (scenarios, CI, offline demo). It is NOT the
 * production conversationalist — see `OpenAITurnDecider`.
 */
import type { ToolCall, TurnDecision } from "@feather-lite/domain";
import type { DeciderInput } from "../types.js";
import { localToUtcIso, parseAmount, parseCallbackTime, parseRelativeDate } from "./parse.js";

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'");
const has = (t: string, ...phrases: string[]) => phrases.some((p) => new RegExp(`\\b${p}\\b`).test(t));

const AFFIRM = ["yes", "yeah", "yep", "yup", "speaking", "that's me", "this is (he|she|him|her)", "i am", "correct", "right", "sure", "go ahead", "of course"];
const NEGATE_IDENTITY = [
  "not (him|her|them|available|here|home|in)",
  "isn't (here|home|available|in)",
  "is not (here|home|available|in)",
  "wrong (person|number|guy)",
  "no (he|she|they)",
  "(his|her|their) (mother|father|wife|husband|son|daughter|brother|sister|roommate|friend|partner)",
  "i'm (his|her|their)",
  "i am (his|her|their)",
  "can i take a message",
  "call back later",
  "not (a good|the right) time",
];
const CALLBACK = ["call( me)? back", "callback", "later", "another time", "not (a good|the right) time", "busy right now"];
const DECLINE = ["no", "nope", "not (right|correct)", "that's wrong", "change", "actually", "wait", "different", "instead"];

const decision = (message: string, toolCall: ToolCall | null, intentSatisfied: boolean, next: TurnDecision["suggestedNextState"]): TurnDecision => ({
  message,
  toolCall,
  intentSatisfied,
  suggestedNextState: next,
});

export const scriptedDecide = (input: DeciderInput): TurnDecision => {
  const t = norm(input.userText);
  const name = norm(input.borrowerFirstName);
  const balance = input.context.protectedContext?.balance_due ?? null;

  switch (input.state) {
    case "GREETING":
    case "VERIFYING_IDENTITY": {
      const saysName = name.length > 0 && new RegExp(`\\b${name}\\b`).test(t);
      const negates = has(t, ...NEGATE_IDENTITY) || (name.length > 0 && new RegExp(`\\bnot ${name}\\b`).test(t));
      if (negates) {
        return decision(
          "",
          { name: "record_wrong_party_contact", args: { outcome_type: "THIRD_PARTY_CONTACT", notes: input.userText.slice(0, 200) } },
          true,
          "THIRD_PARTY_OR_WRONG_PARTY",
        );
      }
      if (has(t, ...AFFIRM) || saysName) {
        return decision("", { name: "confirm_right_party", args: { confirmed: true, reason: "affirmative response" } }, true, "DISCUSSING_PAYMENT");
      }
      if (has(t, "who", "what is this about", "what's this about", "why are you calling")) {
        return decision(
          `This is ${input.context.publicContext.agent_name} from ${input.context.publicContext.company}. I can only discuss the reason for the call with ${input.borrowerFirstName}. Am I speaking with ${input.borrowerFirstName}?`,
          null,
          false,
          "VERIFYING_IDENTITY",
        );
      }
      return decision(`Before I continue, I need to confirm I'm speaking with ${input.borrowerFirstName}. Is that you?`, null, false, "VERIFYING_IDENTITY");
    }

    case "DISCUSSING_PAYMENT": {
      if (has(t, ...CALLBACK) && !has(t, "pay")) {
        const when = parseCallbackTime(t, input.borrowerLocalDate);
        return decision(
          "",
          { name: "schedule_callback", args: { datetime: localToUtcIso(when.isoDate, when.hour, when.minute, input.borrowerTimeZone), reason: "borrower_requested" } },
          true,
          null,
        );
      }
      const date = parseRelativeDate(t, input.borrowerLocalDate);
      const amount = parseAmount(t);
      if (has(t, "pay", "payment", "send", "transfer") || date !== null || amount !== null) {
        if (date === null) {
          return decision("Thank you. What date can you make that payment by?", null, false, "DISCUSSING_PAYMENT");
        }
        const proposedAmount = amount ?? balance;
        if (proposedAmount === null) {
          return decision("Thank you. And what amount will you be paying?", null, false, "DISCUSSING_PAYMENT");
        }
        return decision("", { name: "propose_promise_to_pay", args: { amount: proposedAmount, date } }, true, "CONFIRMING_OUTCOME");
      }
      if (has(t, "how much", "what do i owe", "balance", "what is this about", "why are you calling")) {
        return decision(
          balance
            ? `Your current balance is ${balance} dollars, and it was due on ${input.context.protectedContext?.due_date}. Are you able to make a payment, or would you like a callback?`
            : "Let me pull that up. Are you able to make a payment, or would you like a callback?",
          null,
          false,
          "DISCUSSING_PAYMENT",
        );
      }
      return decision("Can you tell me whether you can make a payment, and by what date, or would you prefer a callback?", null, false, "DISCUSSING_PAYMENT");
    }

    case "CONFIRMING_OUTCOME": {
      if (has(t, ...CALLBACK) && !has(t, "yes")) {
        const when = parseCallbackTime(t, input.borrowerLocalDate);
        return decision(
          "",
          { name: "schedule_callback", args: { datetime: localToUtcIso(when.isoDate, when.hour, when.minute, input.borrowerTimeZone), reason: "borrower_changed_mind" } },
          true,
          null,
        );
      }
      if (has(t, "yes", "yeah", "yep", "correct", "right", "confirm", "that's it", "sounds good", "ok", "okay")) {
        return decision("", { name: "record_promise_to_pay", args: { confirmed: true } }, true, null);
      }
      if (has(t, ...DECLINE) || parseAmount(t) !== null || parseRelativeDate(t, input.borrowerLocalDate) !== null) {
        return decision("No problem. What amount and date would work for you?", null, false, "DISCUSSING_PAYMENT");
      }
      return decision("Please say yes to confirm, or tell me what to change.", null, false, "CONFIRMING_OUTCOME");
    }

    default:
      return decision("Thank you for your time. Goodbye.", null, true, "ENDING");
  }
};
