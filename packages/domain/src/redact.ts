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
 * Applied in order, and the order is load-bearing: `$1,250.00` must be taken as one amount before
 * the bare-decimal rule sees `1,250.00`, and `2026-08-21` must be taken as a date before anything
 * looks at `2026` as a number.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // ISO, the form the tools and the ledger use.
  [/\b\d{4}-\d{2}-\d{2}\b/g, DATE],
  // 8/21, 8/21/26, 08/21/2026.
  [/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, DATE],
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
   * Anything long enough to be an account or phone number. Seven is the floor because six digits
   * and under are years, amounts and counts; a run that long is an identifier.
   */
  [/\b\d{7,}\b/g, DIGITS],
];

/** Remove the account facts from one string. Idempotent: running it twice changes nothing. */
export const redactAccountData = (text: string): string => RULES.reduce((acc, [re, to]) => acc.replace(re, to), text);

/**
 * The same over a structure — a prompt's message array, a tool result, a judge's transcript.
 *
 * Strings are redacted, numbers and booleans are left alone (a latency in milliseconds is not an
 * account fact, and a redactor that mangled the measurements would be the exact instrument-that-
 * lies problem this spec exists to fix), and keys are never touched.
 */
export const redactAccountDataDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redactAccountData(value);
  if (Array.isArray(value)) return value.map(redactAccountDataDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactAccountDataDeep(v);
    return out;
  }
  return value;
};
