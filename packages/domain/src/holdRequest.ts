/**
 * Is the borrower asking for a moment, and nothing else? (issue #1, D1's `wait`.)
 *
 * A reviewable lexicon, not a model — Q3, and user story 24: the classifiers are pure domain
 * functions with table tests, so their lexicons are reviewable and their misses are reproducible.
 *
 * The judgement this makes is narrow on purpose. A `wait` means the control plane says **nothing**
 * and extends the away timer, so a false positive drops whatever the borrower actually said. The
 * near-miss that decides the design is "hold on, I can pay Friday": it opens with a hold phrase and
 * carries a payment offer, and treating it as a hold would swallow the offer. So a hold is a hold
 * phrase **and nothing after it that carries content**.
 */

/** The phrases themselves. Kept as data so the lexicon is the reviewable artefact. */
const HOLD_PHRASES = [
  "hold on",
  "hold up",
  "one second",
  "one sec",
  "a second",
  "a sec",
  "hang on",
  "let me check",
  "let me look",
  "let me get",
  "let me go get",
  "let me grab",
  "let me find",
  "give me a minute",
  "give me a moment",
  "give me a second",
  "just a minute",
  "just a moment",
  "just a second",
  "wait",
  "bear with me",
] as const;

/**
 * Words that may follow a hold phrase without making it something else.
 *
 * "hold on a second", "wait a moment", "let me go get my card" — the trailing words are about the
 * waiting, not about the account. Anything outside this set is content, and content means respond.
 */
const FILLER = new Set([
  "a",
  "an",
  "the",
  "my",
  "me",
  "i",
  "just",
  "please",
  "ok",
  "okay",
  "um",
  "uh",
  "er",
  "well",
  "so",
  "and",
  "second",
  "seconds",
  "sec",
  "moment",
  "minute",
  "minutes",
  "bit",
  "one",
  "two",
  "here",
  "there",
  "card",
  "wallet",
  "purse",
  "phone",
  "glasses",
  "pen",
  "paper",
  "calendar",
  "it",
  "them",
  "that",
  "for",
  "to",
  "go",
  "get",
  "grab",
  "find",
  "check",
  "look",
  "on",
  "up",
  "let",
]);

/** Lower-case, strip punctuation, collapse whitespace. The same normalisation the tests read. */
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const holdRequest = (text: string): boolean => {
  const normalised = normalise(text);
  if (normalised.length === 0) return false;

  // Leading filler ("um, hold on") is not content and must not stop the phrase from matching.
  const words = normalised.split(" ");
  let start = 0;
  while (start < words.length && FILLER.has(words[start]!) && !HOLD_PHRASES.some((p) => normalised.startsWith(p, offsetOf(words, start)))) start += 1;
  const rest = words.slice(start).join(" ");

  const phrase = HOLD_PHRASES.find((p) => rest === p || rest.startsWith(`${p} `));
  if (phrase === undefined) return false;

  /**
   * Everything after the phrase must be filler. This is the whole guard: "hold on" is a hold,
   * "hold on, I can pay Friday" is an offer that happens to start politely, and the second must
   * reach the decider.
   */
  const tail = rest.slice(phrase.length).trim();
  if (tail.length === 0) return true;
  return tail.split(" ").every((w) => FILLER.has(w));
};

/** Character offset of the `i`th word in the normalised string. */
const offsetOf = (words: ReadonlyArray<string>, i: number): number => words.slice(0, i).reduce((n, w) => n + w.length + 1, 0);
