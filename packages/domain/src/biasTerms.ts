/**
 * What to bias the recogniser toward, once the borrower is verified (issue #1, D3).
 *
 * A collections call turns on a handful of tokens — the borrower's name, an amount, a date — and
 * those are exactly the tokens a general recogniser is worst at. D3 biases toward them and gates the
 * amounts with `stt.entity_er`.
 *
 * **Nothing is sent before right-party verification.** The borrower's name and balance are protected
 * context, and the same rule that keeps them out of the prompt keeps them out of the bias list: a
 * keyterm list is account data leaving the system just as surely as a sentence is. Before
 * verification the session runs on the defaults.
 *
 * Shapes verified against the installed `@livekit/agents-plugin-deepgram` 1.6.4 `stt.js`, per
 * amendment 9: `keyterm` is `string[]`, `keywords` is `[word, boost][]` joined as `word:boost`
 * (`stt.js:89`), and `numerals` is a boolean (`:91`).
 *
 * **`updateOptions` re-opens the websocket** (`stt.js:284`, `this.#resetWS.resolve()`), so the caller
 * must apply these once and only when they change — which is why the result is a plain value that
 * compares equal for an unchanged account.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The boost Deepgram takes per keyword. Modest on purpose: over-boosting invents the word. */
const BOOST = 2;

export interface BiasAccount {
  readonly borrowerName: string;
  readonly creditorName: string;
  /** The balance, as the ledger holds it ("550.00"). Null when there is none to bias toward. */
  readonly balanceDue: string | null;
  /** ISO date, or null. */
  readonly dueDate: string | null;
}

export interface BiasTerms {
  /** Whole phrases the recogniser should expect. */
  readonly keyterms: ReadonlyArray<string>;
  /** `[word, boost]` pairs; the plugin joins them as `word:boost`. */
  readonly keywords: ReadonlyArray<readonly [string, number]>;
  /** Digits rather than number words, so an amount comes back comparable. */
  readonly numerals: boolean;
}

/** "550.00" -> "550"; a trailing ".00" is formatting the borrower never says. */
const spokenAmount = (raw: string): string => raw.replace(/\.00$/, "").replace(/,/g, "");

export const biasTermsFor = (account: BiasAccount, ctx: { readonly verified: boolean }): BiasTerms => {
  // `numerals` is not account data — it is a formatting preference, and safe on either side of the
  // gate. Everything below it is protected.
  if (!ctx.verified) return { keyterms: [], keywords: [], numerals: true };

  const keyterms: string[] = [];
  for (const part of account.borrowerName.split(/\s+/)) if (part.length > 0) keyterms.push(part);
  if (account.creditorName.trim().length > 0) keyterms.push(account.creditorName.trim());

  const keywords: Array<readonly [string, number]> = [];
  if (account.balanceDue !== null && account.balanceDue.trim().length > 0) {
    keywords.push([spokenAmount(account.balanceDue.trim()), BOOST]);
  }
  if (account.dueDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(account.dueDate)) {
    const month = MONTHS[Number(account.dueDate.slice(5, 7)) - 1];
    if (month !== undefined) keywords.push([month, BOOST]);
  }

  return { keyterms, keywords, numerals: true };
};
