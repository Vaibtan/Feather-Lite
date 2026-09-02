/**
 * Is this interim transcript the borrower listening rather than interrupting? (issue #1, D1's
 * `resume`.)
 *
 * Same lexicon family as `holdRequest` and the same rule about content, but it runs on the
 * **interim** transcript while the agent's audio is already paused, so it has to be decisive on very
 * little text. Two asymmetric costs shape it:
 *
 *   - A false positive resumes the agent **over a borrower who is genuinely speaking**. That is
 *     worse than the pause it was trying to avoid, so anything that could be the start of a sentence
 *     is not a backchannel.
 *   - A false negative is just today's behaviour: the agent stays paused until the false-interruption
 *     timer. Cheap.
 *
 * So the bar is high: a short utterance drawn entirely from the listening lexicon, nothing else.
 *
 * **"yes" and "no" are deliberately not backchannels.** Both are answers, and "yes" during the
 * promise read-back is the confirmation the whole call exists for — resuming over it would be the
 * defect D1 exists to fix, one layer down.
 *
 * D5.2 is why this exists at all: raising `interruption.minDuration` to 700 ms was measured on the
 * simulator's backchannel scenario and did **not** remove the pauses (4 and 2 lines cut, against 3
 * and 2 at the 500 ms default), so the knob was not the fix.
 */

/** The listening noises themselves, normalised. Data, so the lexicon is the reviewable artefact. */
const TOKENS = new Set([
  "yeah",
  "yea",
  "yep",
  "yup",
  "okay",
  "ok",
  "k",
  "right",
  "mmhm",
  "mhm",
  "mm",
  "mmm",
  "hm",
  "hmm",
  "uhhuh",
  "uhuh",
  "aha",
  "ah",
  "oh",
  "sure",
  "gotcha",
  "got",
  "it",
  "i",
  "see",
  "alright",
  "true",
]);

/**
 * The most words a backchannel may be.
 *
 * "got it" and "right right" are two; past three the borrower is forming a sentence and the interim
 * should cancel the resume rather than complete it. Length alone has to be able to say no, because
 * the interim grows while the classifier is being asked again and again.
 */
const MAX_WORDS = 3;

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const backchannel = (interimText: string): boolean => {
  const normalised = normalise(interimText);
  if (normalised.length === 0) return false;
  const words = normalised.split(" ");
  if (words.length > MAX_WORDS) return false;
  return words.every((w) => TOKENS.has(w));
};
