/**
 * What to bias the recogniser toward, once the borrower is verified (issue #1, D3).
 *
 * Pure, so the policy is reviewable without a session: which terms, and — the part that matters —
 * which terms are **protected** and must never be sent before right-party verification.
 */
import { describe, expect, it } from "vitest";
import { biasTermsFor } from "../src/biasTerms.js";

const account = {
  borrowerName: "Jordan Avery",
  creditorName: "Feather-Lite Collections",
  balanceDue: "550.00",
  dueDate: "2026-09-04",
};

describe("biasTermsFor", () => {
  it("biases the borrower's name, which is what verification turns on", () => {
    const t = biasTermsFor(account, { verified: true });
    expect(t.keyterms).toContain("Jordan");
    expect(t.keyterms).toContain("Avery");
  });

  it("biases the creditor name, so the mini-Miranda is heard back correctly", () => {
    expect(biasTermsFor(account, { verified: true }).keyterms).toContain("Feather-Lite Collections");
  });

  it("turns numerals on, so amounts come back as digits", () => {
    expect(biasTermsFor(account, { verified: true }).numerals).toBe(true);
  });

  it("weights the account's own amounts and the month names", () => {
    const t = biasTermsFor(account, { verified: true });
    const words = t.keywords.map(([w]) => w);
    expect(words).toContain("550");
    expect(words).toContain("september");
    // Every keyword carries a boost, because the plugin sends them as `word:boost`.
    expect(t.keywords.every(([, boost]) => typeof boost === "number" && boost > 0)).toBe(true);
  });

  it("**sends nothing before right-party verification**", () => {
    /**
     * The gate that matters, and the reason this is a pure function with a flag rather than a
     * lookup. The borrower's name and balance are protected context: the same rule that keeps them
     * out of the prompt before verification keeps them out of the recogniser's bias list, because a
     * keyterm list is account data leaving the system just as surely as a sentence is.
     */
    const t = biasTermsFor(account, { verified: false });
    expect(t.keyterms).toEqual([]);
    expect(t.keywords).toEqual([]);
    // `numerals` is not account data — it is a formatting preference and is safe either way.
    expect(t.numerals).toBe(true);
  });

  it("is stable, so an unchanged account does not churn the socket", () => {
    // `updateOptions` re-opens the Deepgram websocket (verified in the installed stt.js), so the
    // caller must be able to tell "same terms" cheaply and skip the update.
    expect(biasTermsFor(account, { verified: true })).toEqual(biasTermsFor(account, { verified: true }));
  });

  it("survives an account with nothing to bias", () => {
    const t = biasTermsFor({ borrowerName: "", creditorName: "", balanceDue: null, dueDate: null }, { verified: true });
    expect(t.keyterms).toEqual([]);
    expect(t.keywords).toEqual([]);
  });
});
