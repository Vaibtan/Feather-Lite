/**
 * Deterministic override rules (PRD §5.2.2 "Hard-Coded Override Rules", SPEC §8.4).
 *
 * These run *before* the LLM on every user turn. A hit forces an immediate,
 * compliance-safe transition regardless of what the model would have said:
 * continuing to collect after an opt-out, dispute, or hardship expression is
 * a UDAAP/FDCPA risk, so the decision is not left to a probabilistic component.
 *
 * Precedence when several classes match in one utterance (SPEC §8.4):
 *   OPT_OUT > DISPUTE > HARDSHIP > WRONG_NUMBER
 *
 * Matching is done on a normalised form of the transcript (lower-case,
 * contractions expanded, punctuation stripped) with word boundaries, so
 * STT variants such as "can't" / "cannot" / "can not" all match.
 */
import { Option } from "effect";
import type { ConversationState, OverrideReason } from "./enums.js";

export interface OverrideMatch {
  readonly reason: OverrideReason;
  readonly targetState: ConversationState;
  /** The rule (phrase or pattern source) that fired — recorded on the event for QA. */
  readonly matched: string;
}

export interface OverrideContext {
  /** Borrower's first name, if known — enables "I am not <name>" style wrong-party rules. */
  readonly borrowerFirstName?: string | undefined;
}

const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcan'?t\b/g, "cannot"],
  [/\bcan not\b/g, "cannot"],
  [/\bwon'?t\b/g, "will not"],
  [/\bdon'?t\b/g, "do not"],
  [/\bdoesn'?t\b/g, "does not"],
  [/\bdidn'?t\b/g, "did not"],
  [/\bisn'?t\b/g, "is not"],
  [/\baren'?t\b/g, "are not"],
  [/\bwasn'?t\b/g, "was not"],
  [/\bweren'?t\b/g, "were not"],
  [/\bhaven'?t\b/g, "have not"],
  [/\bhasn'?t\b/g, "has not"],
  [/\bcouldn'?t\b/g, "could not"],
  [/\bwouldn'?t\b/g, "would not"],
  [/\bshouldn'?t\b/g, "should not"],
  [/\bain'?t\b/g, "is not"],
  [/\bi'?m\b/g, "i am"],
  [/\bi'?ve\b/g, "i have"],
  [/\byou'?ve\b/g, "you have"],
  [/\bthat'?s\b/g, "that is"],
  [/\bit'?s\b/g, "it is"],
  [/\bhe'?s\b/g, "he is"],
  [/\bshe'?s\b/g, "she is"],
  [/\bthere'?s\b/g, "there is"],
  [/\bwho'?s\b/g, "who is"],
];

/** Lower-case, unify apostrophes, expand contractions, strip punctuation, collapse spaces. */
export const normalizeUtterance = (text: string): string => {
  let t = text.toLowerCase().replace(/[‘’ʼ`´]/g, "'");
  for (const [pattern, replacement] of CONTRACTIONS) t = t.replace(pattern, replacement);
  t = t.replace(/[^a-z0-9' ]+/g, " ").replace(/'/g, "");
  return t.replace(/\s+/g, " ").trim();
};

/* ------------------------------------------------------------------ */
/* Rule tables                                                          */
/* ------------------------------------------------------------------ */

type Rule = readonly [reason: OverrideReason, target: ConversationState, phrases: ReadonlyArray<string | RegExp>];

const RULES: ReadonlyArray<Rule> = [
  [
    "OPT_OUT",
    "OPT_OUT",
    [
      "stop calling",
      "stop contacting",
      "do not call",
      "do not contact",
      "never call",
      "quit calling",
      "no more calls",
      "remove my number",
      "remove me from",
      "take me off",
      "cease contact",
      "cease and desist",
      "leave me alone",
      "unsubscribe",
      "opt out",
      "harassment",
      "harassing me",
      /\bstop (?:calling|phoning|texting|contacting|bothering)\b/,
      /\bcall(?:ing)? me (?:again|anymore|any more)\b/, // "don't call me again/anymore" after expansion
    ],
  ],
  [
    "DISPUTE",
    "ESCALATED",
    [
      "dispute",
      "not my debt",
      "not my loan",
      "not my account",
      "do not owe",
      "did not owe",
      "never owed",
      "owe nothing",
      "owe you nothing",
      "prove i owe",
      "prove that i owe",
      "prove it",
      "already paid",
      "paid this off",
      "paid in full",
      "paid it off",
      "my lawyer",
      "my attorney",
      "talk to my lawyer",
      "identity theft",
      "fraud",
      "validate the debt",
      "verify the debt",
      "in writing",
    ],
  ],
  [
    "HARDSHIP",
    "ESCALATED",
    [
      "lost my job",
      "laid off",
      "unemployed",
      "out of work",
      "cannot afford",
      "no money",
      "no income",
      "cannot pay anything",
      "bankruptcy",
      "bankrupt",
      "chapter 7",
      "chapter 13",
      "hospital",
      "medical",
      "surgery",
      "disability",
      "disabled",
      "passed away",
      "died",
      "deceased",
      "funeral",
      "eviction",
      "evicted",
      "homeless",
      "hardship",
      "struggling",
      "kill myself",
      "end my life",
      "hurt myself",
      /\bsuicid/,
    ],
  ],
  [
    "WRONG_NUMBER",
    "WRONG_NUMBER",
    [
      "wrong number",
      "wrong person",
      "wrong guy",
      "wrong girl",
      "no one by that name",
      "nobody by that name",
      "no one here by that",
      "nobody here by that",
      "never heard of",
      "you have the wrong",
      "you got the wrong",
      "got the wrong",
      "this is not his number",
      "this is not her number",
      "this is not their number",
      "not his number",
      "not her number",
      "new number",
      "this number belongs to",
      "does not live here",
      "moved out",
      "moved away",
      "no longer at this number",
      "not at this number",
    ],
  ],
];

const wordBoundary = (phrase: string): RegExp =>
  new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);

const compiled: ReadonlyArray<readonly [OverrideReason, ConversationState, ReadonlyArray<readonly [RegExp, string]>]> =
  RULES.map(([reason, target, phrases]) => [
    reason,
    target,
    phrases.map((p) =>
      typeof p === "string" ? ([wordBoundary(normalizeUtterance(p)), p] as const) : ([p, p.source] as const),
    ),
  ]);

const nameRules = (firstName: string): ReadonlyArray<readonly [RegExp, string]> => {
  const n = normalizeUtterance(firstName);
  if (n.length === 0) return [];
  return [
    [wordBoundary(`i am not ${n}`), `i am not <name>`],
    [wordBoundary(`this is not ${n}`), `this is not <name>`],
    [wordBoundary(`not ${n}`), `not <name>`],
    [wordBoundary(`${n} does not live here`), `<name> does not live here`],
    [wordBoundary(`${n} moved`), `<name> moved`],
    [wordBoundary(`no ${n} here`), `no <name> here`],
    [wordBoundary(`there is no ${n}`), `there is no <name>`],
  ];
};

/**
 * Evaluate the override rules against a user utterance.
 * Returns the highest-precedence match, or `None`.
 */
export const matchOverride = (
  utterance: string,
  context: OverrideContext = {},
): Option.Option<OverrideMatch> => {
  const text = normalizeUtterance(utterance);
  if (text.length === 0) return Option.none();

  for (const [reason, targetState, patterns] of compiled) {
    for (const [pattern, matched] of patterns) {
      if (pattern.test(text)) return Option.some({ reason, targetState, matched });
    }
    if (reason === "WRONG_NUMBER" && context.borrowerFirstName) {
      for (const [pattern, matched] of nameRules(context.borrowerFirstName)) {
        if (pattern.test(text)) return Option.some({ reason, targetState, matched });
      }
    }
  }
  return Option.none();
};

/** Precedence order, exported for tests and documentation. */
export const OVERRIDE_PRECEDENCE: ReadonlyArray<OverrideReason> = RULES.map(([reason]) => reason);
