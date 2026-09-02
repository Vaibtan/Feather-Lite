/**
 * Did the transcript keep the numbers that decide the call? (issue #1, D3.)
 *
 * Word error rate treats every word alike, and it should not. A transcript that writes "Friday,"
 * for "Friday" costs exactly what one that writes "515" for "550" costs, and only the second is a
 * **wrong promise**. D3 makes amounts a gate — `--max-amount-errors 0`, because an amount error is
 * not a degraded transcript — and reports dates and names beside them until the accent personas say
 * what their floor should be.
 *
 * Built on `normalizeForWer`, so the two measurements agree about what counts as the same word:
 * "$550", "550 dollars" and "five hundred fifty dollars" are one amount written three ways, and a
 * harness that scored those as errors would be measuring formatting.
 */
import { normalizeForWer } from "./wer.js";

export type EntityKind = "amount" | "date" | "name";

export interface Entity {
  readonly kind: EntityKind;
  /** Normalised, so comparison is formatting-blind. */
  readonly value: string;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface EntityOptions {
  /** Names this line is expected to carry. A name is only an entity when the caller says it is. */
  readonly names?: ReadonlyArray<string> | undefined;
}

/**
 * The entities a line carries, in the order they appear.
 *
 * An **amount** is a number followed by "dollars" — after normalisation "$550" already reads as
 * "550 dollars", so one rule covers every spelling. A bare number is *not* an amount: "September 4"
 * and "one moment" would both become false amounts, and a false amount error would fail a run for a
 * transcript that was correct.
 */
export const entitiesIn = (line: string, options: EntityOptions = {}): ReadonlyArray<Entity> => {
  const words = normalizeForWer(line).split(" ").filter((w) => w.length > 0);
  const wanted = new Set((options.names ?? []).map((n) => normalizeForWer(n).trim()).filter((n) => n.length > 0));
  const out: Entity[] = [];
  for (const [i, word] of words.entries()) {
    if (word === "dollars" && i > 0 && /^\d[\d.]*$/.test(words[i - 1]!)) {
      out.push({ kind: "amount", value: words[i - 1]! });
      continue;
    }
    if (WEEKDAYS.includes(word) || MONTHS.includes(word)) {
      out.push({ kind: "date", value: word });
      // A day number belongs to the month before it: "september 4" is one date in two tokens, and
      // the 4 must not also be read as a bare number somewhere else.
      const next = words[i + 1];
      if (next !== undefined && /^\d{1,2}$/.test(next)) out.push({ kind: "date", value: next });
      continue;
    }
    if (wanted.has(word)) out.push({ kind: "name", value: word });
  }
  return out;
};

export interface EntityErrorResult {
  /** The entities the reference carried that the hypothesis does not. */
  readonly errors: ReadonlyArray<Entity>;
  /**
   * Errors over entities, or **null** when the line carried none.
   *
   * The same rule `wordErrorRate` uses for an empty reference: there is nothing to be wrong about,
   * and calling it 0 would quietly improve every average it was folded into.
   */
  readonly rate: number | null;
  /** Broken out because D3 gates amounts at zero and only reports the rest. */
  readonly amountErrors: number;
  readonly counts: Readonly<Record<EntityKind, number>>;
}

export const entityErrors = (reference: string, hypothesis: string, options: EntityOptions = {}): EntityErrorResult => {
  const expected = entitiesIn(reference, options);
  const heardWords = normalizeForWer(hypothesis).split(" ").filter((w) => w.length > 0);
  const heard = new Set(heardWords);
  const errors = expected.filter((e) => !heard.has(e.value));
  const counts: Record<EntityKind, number> = { amount: 0, date: 0, name: 0 };
  for (const e of expected) counts[e.kind] += 1;
  return {
    errors,
    rate: expected.length === 0 ? null : errors.length / expected.length,
    amountErrors: errors.filter((e) => e.kind === "amount").length,
    counts,
  };
};
