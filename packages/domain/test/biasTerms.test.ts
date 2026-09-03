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
    expect(t.keywords.every(([, boost]) => typeof boost === "number" && boost > 0)).toBe(true);
  });

  it("**sends nothing before right-party verification**", () => {
    /** A keyterm list is account data leaving the system just as surely as a spoken sentence is. */
    const t = biasTermsFor(account, { verified: false });
    expect(t.keyterms).toEqual([]);
    expect(t.keywords).toEqual([]);
    expect(t.numerals).toBe(true);
  });

  it("is stable, so an unchanged account does not churn the socket", () => {
    /** `updateOptions` re-opens the Deepgram websocket, so the caller must be able to skip an identical update. */
    expect(biasTermsFor(account, { verified: true })).toEqual(biasTermsFor(account, { verified: true }));
  });

  it("survives an account with nothing to bias", () => {
    const t = biasTermsFor({ borrowerName: "", creditorName: "", balanceDue: null, dueDate: null }, { verified: true });
    expect(t.keyterms).toEqual([]);
    expect(t.keywords).toEqual([]);
  });
});
