/**
 * Account facts removed from text before it leaves this system for an observability vendor
 * (spec 2026-08-27, D3).
 *
 * `visibleContext` decides what the *model* may see; this decides what the *trace backend* may
 * keep. They are different questions with different blast radii: the model's copy lives for one
 * request, Langfuse's lives in ClickHouse until someone deletes it, and a self-hosted Langfuse
 * today is a hosted one tomorrow. Nothing in the pipeline made that distinction, so every balance
 * and every promise date the agent spoke was being written to a second store with a different
 * retention policy and a different set of people who can read it.
 *
 * **Patterns, not values, and only where a pattern is honest.** Money, dates and long digit runs
 * have shapes; a borrower's name does not, and a regex that tried would either miss most names or
 * eat half the transcript. The name is left alone deliberately: `visibleContext` is the structural
 * control that keeps it out of a prompt before verification, and after verification the agent says
 * it out loud — a trace that masked it while the ledger in Postgres holds the same sentence
 * verbatim would be decoration, not a control. What this removes is the account *facts*: what is
 * owed, when it is due, how far behind, and any identifier long enough to be one.
 *
 * The replacements name what was taken, so a redacted turn still reads as a conversation and an
 * operator can tell a masked amount from a model that never said one.
 */

const AMOUNT = "[amount]";
const DATE = "[date]";
const DIGITS = "[digits]";
const COUNT = "[count]";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

/**
 * The words that make a bare integer an amount (review #13).
 *
 * "I can pay 550 on Friday" is the line the fleet script actually speaks, and none of the rules
 * above see it: no currency symbol, no "dollars", no decimals. The number alone cannot be judged —
 * `550` and `5` are the same shape — so what is matched is the **claim around it**. A collections
 * call has exactly two kinds of number in it, money and counts, and money is the one that gets
 * said after one of these words.
 */
const MONEY_VERBS = "pay|paying|pays|paid|owe|owes|owed|owing|afford|send|sending|sent|charge|charged|deposit|remit|settle|do|manage|cover|clear";
const MONEY_NOUNS = "balance|amount|total|payment|instal?lment|arrears|minimum|payoff|principal";

/**
 * The hedges a borrower puts between the verb and the number — "I could probably do **about** 300".
 * Bounded to three so the rule cannot reach across a clause into an unrelated number.
 */
const HEDGES = "you|them|him|her|it|the|a|of|is|was|are|be|about|around|roughly|maybe|like|approximately|up to|at least|no more than|only|just|another|my|your|their|due|off|back|now";

/**
 * What a bare integer must **not** be followed by. Every one of these turns the number into a count
 * or a duration, and a masked count is a lying instrument — the same defect this file exists to
 * avoid, pointed the other way.
 */
const NOT_MONEY_AFTER = "%|percent|days?|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|secs?|ms|milliseconds?|times?|calls?|attempts?|turns?|tokens?|st|nd|rd|th";

/**
 * Applied in order, and the order is load-bearing: `$1,250.00` must be taken as one amount before
 * the bare-decimal rule sees `1,250.00`, and `2026-08-21` must be taken as a date before anything
 * looks at `2026` as a number.
 */
const RULES: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  // ISO, the form the tools and the ledger use.
  [/\b\d{4}-\d{2}-\d{2}\b/g, DATE],
  // 8/21, 8/21/26, 08/21/2026.
  [/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, DATE],
  /**
   * The same, hyphenated: `8-21`, `08-21-2026`. Here so that the digit-group rule below cannot
   * label a date an identifier — both are digits and hyphens, and only the group widths tell them
   * apart. One or two digits per part is a date; three or more is not.
   */
  [/\b\d{1,2}-\d{1,2}(?:-\d{2,4})?\b/g, DATE],
  // "August 21st, 2026" / "Aug 21".
  [new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`, "gi"), DATE],
  // "21 August 2026" / "the 21st of August".
  [new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS})\.?(?:,?\s+\d{4})?\b`, "gi"), DATE],
  // Currency-marked, either side of the number.
  [/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, AMOUNT],
  [/\b\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|usd|bucks)\b/gi, AMOUNT],
  /**
   * A bare two-decimal number. In this domain that is a balance or a promise amount and nothing
   * else — the only other numbers on a collections call are counts and durations, which are whole.
   */
  [/\b\d[\d,]*\.\d{2}\b/g, AMOUNT],
  /**
   * How far behind the account is. Narrow on purpose: `\d+ days` alone would also swallow "call me
   * back in three days", which is the borrower's own scheduling and not an account fact.
   */
  [/\b\d{1,4}(?=\s+days?\s+(?:past\s+due|late|behind|delinquent|overdue))/gi, COUNT],
  /**
   * A bare integer that a payment word claims (review #13). The verb or noun survives — "I can pay
   * [amount] on Friday" still reads as an offer, which is the whole point of masking patterns
   * rather than deleting them — and only the number goes.
   */
  [
    new RegExp(String.raw`\b((?:${MONEY_VERBS}|${MONEY_NOUNS})\b(?:\s+(?:${HEDGES})\b){0,3}\s+)(\d[\d,]*)\b(?!\s*(?:${NOT_MONEY_AFTER})\b)`, "gi"),
    (m: string) => m.replace(/\d[\d,]*$/, AMOUNT),
  ],
  /**
   * Anything long enough to be an account or phone number. Seven is the floor because six digits
   * and under are years, amounts and counts; a run that long is an identifier.
   */
  [/\b\d{7,}\b/g, DIGITS],
  /**
   * The same identifier written the way people write them: `555-123-4567`, `4485-9392-01`
   * (review #13). Counted rather than pattern-matched, because the shapes vary by issuer and the
   * question is only ever "is this long enough to be an identifier" — the same seven-digit floor as
   * the rule above, applied after the hyphens are discounted. Dates were taken above, so what
   * reaches here is not one.
   */
  [/\b\d[\d-]{5,}\d\b/g, (m: string) => (m.replace(/\D/g, "").length >= 7 ? DIGITS : m)],
];

/** Remove the account facts from one string. Idempotent: running it twice changes nothing. */
export const redactAccountData = (text: string): string =>
  RULES.reduce((acc, [re, to]) => (typeof to === "string" ? acc.replace(re, to) : acc.replace(re, to)), text);

/**
 * The keys whose numeric value is an account fact whatever it looks like (review #13).
 *
 * `{"balance_due": 1250}` is the balance, and none of the rules above can see it: a tool result is
 * a structure, not a sentence, so the number arrives with none of the shape — no currency mark, no
 * decimals, no claim around it — that the text rules match on.
 *
 * **An allowlist of keys, not a pattern over keys.** `/amount|balance/` would also catch
 * `amount_of_turns` and any future field that borrows the word, and a redactor that grows by
 * accident is one nobody can predict. Widening this is a decision someone makes on a line of a
 * diff. Matched on the key with separators and case stripped, so `balanceDue`, `balance_due` and
 * `BALANCE-DUE` are one entry rather than three.
 */
const ACCOUNT_FACT_KEYS: ReadonlyMap<string, string> = new Map([
  ["balance", AMOUNT],
  ["balancedue", AMOUNT],
  ["balancecents", AMOUNT],
  ["amountdue", AMOUNT],
  ["amountcents", AMOUNT],
  ["totaldue", AMOUNT],
  ["minimumdue", AMOUNT],
  ["minimumpayment", AMOUNT],
  ["promiseamount", AMOUNT],
  ["paymentamount", AMOUNT],
  ["pastdueamount", AMOUNT],
  ["payoff", AMOUNT],
  ["payoffamount", AMOUNT],
  ["principal", AMOUNT],
  ["interest", AMOUNT],
  ["delinquencydays", COUNT],
  ["dayspastdue", COUNT],
  ["daysdelinquent", COUNT],
  ["accountnumber", DIGITS],
  ["accountid", DIGITS],
  ["loannumber", DIGITS],
  ["cardnumber", DIGITS],
  ["ssn", DIGITS],
]);

const accountFactMarker = (key: string): string | undefined => ACCOUNT_FACT_KEYS.get(key.replace(/[^a-z0-9]/gi, "").toLowerCase());

/**
 * The same over a structure — a prompt's message array, a tool result, a judge's transcript.
 *
 * Strings are redacted, and numbers and booleans are left alone unless their **key** says they are
 * an account fact: a latency in milliseconds is not one, and a redactor that mangled the
 * measurements would be the exact instrument-that-lies problem this work exists to fix. Keys
 * themselves are never touched.
 *
 * A masked number leaves as the marker string rather than as a number. There is no numeric value
 * that means "withheld" — 0 and -1 are both readable as data — and the marker says which kind of
 * fact was taken, which is the same contract the text rules keep.
 */
export const redactAccountDataDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redactAccountData(value);
  if (Array.isArray(value)) return value.map(redactAccountDataDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const marker = accountFactMarker(k);
      out[k] = marker !== undefined && (typeof v === "number" || typeof v === "string") ? marker : redactAccountDataDeep(v);
    }
    return out;
  }
  return value;
};
