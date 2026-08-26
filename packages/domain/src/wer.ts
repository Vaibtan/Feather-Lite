/**
 * Word error rate for the voice harness (spec 2026-08-26, D4).
 *
 * Only the harness can measure this: WER needs the exact words that were spoken, and it is the
 * harness that speaks them. A production call has no ground truth to compare a transcript against,
 * which is why this number is a regression gate on the fleet run and never a claim about live calls.
 *
 * The normaliser matters more than the arithmetic. WER over raw strings measures punctuation,
 * casing and whether the STT wrote "550" or "five hundred fifty" — none of which anyone is grading
 * the provider on. Normalising is what makes the number a transcription measurement instead of a
 * formatting one, so each rule is written down here and pinned by a table test.
 */

const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bshan't\b/g, "shall not"],
  [/\bn't\b/g, " not"],
  [/\b(i)'m\b/g, "$1 am"],
  [/\b(\w+)'re\b/g, "$1 are"],
  [/\b(\w+)'ve\b/g, "$1 have"],
  [/\b(\w+)'ll\b/g, "$1 will"],
  [/\b(it|that|this|there|what|who|he|she|here)'s\b/g, "$1 is"],
  [/\b(\w+)'d\b/g, "$1 would"],
];

const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { hundred: 100, thousand: 1000 };

const isNumberWord = (w: string): boolean => w in UNITS || w in TENS || w in SCALES;

/**
 * Fold runs of number words into digits, one direction only.
 *
 * One direction because the mapping is not a bijection: 21 is "twenty one" or "twenty-one", 105 is
 * "one hundred five" or "one hundred and five". Collapsing every spelling onto the digits gives one
 * canonical form; going the other way would have to pick a spelling and would then disagree with
 * whichever one the provider chose.
 */
const foldNumberWords = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (!isNumberWord(w)) {
      out.push(w);
      i += 1;
      continue;
    }
    // A run of bare single digits is a spoken sequence, not arithmetic: "five five zero" is how an
    // STT may render 550, and "one two one two" is part of a phone number. Adding them up would
    // turn the first into 10 and the second into 6. Only runs containing a tens or scale word
    // ("five hundred fifty", "twenty one") are actually arithmetic.
    let runEnd = i;
    while (runEnd < words.length && isNumberWord(words[runEnd]!)) runEnd += 1;
    const run = words.slice(i, runEnd);
    if (run.length >= 2 && run.every((t) => t in UNITS && UNITS[t]! <= 9)) {
      out.push(run.map((t) => String(UNITS[t]!)).join(""));
      i = runEnd;
      continue;
    }

    let total = 0;
    let current = 0;
    let consumed = 0;
    while (i + consumed < words.length) {
      const token = words[i + consumed]!;
      // "and" only joins a number when a number follows it: "one hundred and five" is 105, but
      // "five hundred dollars and Friday" must not swallow the rest of the sentence.
      if (token === "and" && current + total > 0 && i + consumed + 1 < words.length && isNumberWord(words[i + consumed + 1]!)) {
        consumed += 1;
        continue;
      }
      if (token in UNITS) {
        current += UNITS[token]!;
      } else if (token in TENS) {
        current += TENS[token]!;
      } else if (token === "hundred") {
        current = (current === 0 ? 1 : current) * 100;
      } else if (token === "thousand") {
        total += (current === 0 ? 1 : current) * 1000;
        current = 0;
      } else {
        break;
      }
      consumed += 1;
    }
    out.push(String(total + current));
    i += consumed;
  }
  return out;
};

/**
 * The canonical form both sides of a comparison are reduced to: lowercase, contractions expanded,
 * punctuation dropped, number words folded to digits, whitespace collapsed.
 */
export const normalizeForWer = (text: string): string => {
  let s = text.toLowerCase();
  for (const [pattern, replacement] of CONTRACTIONS) s = s.replace(pattern, replacement);
  // A provider that writes "$550" and one that writes "550 dollars" heard the same words. Measured
  // on the first live run: Deepgram returned "$550" against a reference of "550 dollars", which
  // scored as a deleted word and inflated that line's WER by a third for no transcription error at
  // all. Same class of rule as folding number words to digits — a formatting choice, not a mistake.
  s = s.replace(/\$\s*(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars");
  // Thousands separators are formatting too: "1,200" and "1200" are one word either way.
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  // Hyphens and slashes become spaces rather than vanishing, so "twenty-one" is two number words
  // to fold and not the single token "twentyone".
  s = s.replace(/[-/]/g, " ");
  // Keep digits, letters and the decimal point inside a number; drop everything else.
  s = s.replace(/[^a-z0-9.\s]/g, " ").replace(/\.(?!\d)/g, " ");
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  return foldNumberWords(words).join(" ");
};

export interface WerResult {
  /**
   * (S + I + D) / N, the canonical definition. Can exceed 1 when the transcript invents words, and
   * is null when the reference is empty — there is nothing to be wrong about, and calling that 0
   * would quietly improve every average it was folded into.
   */
  readonly wer: number | null;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly referenceWords: number;
}

/**
 * Levenshtein over words, with the three edit kinds counted separately.
 *
 * Deliberately not the npm `word-error-rate` package: it divides by max(reference, hypothesis)
 * length, which caps the rate at 1 and so understates exactly the failure worth catching — an STT
 * that hallucinates a long transcript from a short utterance.
 */
export const wordErrorRate = (reference: string, hypothesis: string): WerResult => {
  const ref = normalizeForWer(reference).split(" ").filter((w) => w.length > 0);
  const hyp = normalizeForWer(hypothesis).split(" ").filter((w) => w.length > 0);

  if (ref.length === 0) return { wer: null, substitutions: 0, insertions: hyp.length, deletions: 0, referenceWords: 0 };

  interface Cell {
    readonly cost: number;
    readonly s: number;
    readonly i: number;
    readonly d: number;
  }
  const start: Cell = { cost: 0, s: 0, i: 0, d: 0 };
  let previous: Cell[] = [start];
  for (let j = 1; j <= hyp.length; j += 1) previous.push({ cost: j, s: 0, i: j, d: 0 });

  for (let i = 1; i <= ref.length; i += 1) {
    const row: Cell[] = [{ cost: i, s: 0, i: 0, d: i }];
    for (let j = 1; j <= hyp.length; j += 1) {
      const match = ref[i - 1] === hyp[j - 1];
      const diagonal = previous[j - 1]!;
      const substitute: Cell = match ? { ...diagonal, cost: diagonal.cost } : { cost: diagonal.cost + 1, s: diagonal.s + 1, i: diagonal.i, d: diagonal.d };
      const above = previous[j]!;
      const deletion: Cell = { cost: above.cost + 1, s: above.s, i: above.i, d: above.d + 1 };
      const left = row[j - 1]!;
      const insertion: Cell = { cost: left.cost + 1, s: left.s, i: left.i + 1, d: left.d };
      // Ties prefer a substitution, then a deletion: an aligned edit is a better explanation of a
      // wrong word than an insert-plus-delete pair, and the counts are what an operator reads.
      let best = substitute;
      if (deletion.cost < best.cost) best = deletion;
      if (insertion.cost < best.cost) best = insertion;
      row.push(best);
    }
    previous = row;
  }

  const final = previous[hyp.length]!;
  return {
    wer: Math.round(((final.s + final.i + final.d) / ref.length) * 10000) / 10000,
    substitutions: final.s,
    insertions: final.i,
    deletions: final.d,
    referenceWords: ref.length,
  };
};
