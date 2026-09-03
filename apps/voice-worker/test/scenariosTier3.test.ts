import { describe, expect, it } from "vitest";
import { checkExpectedLedger, scenarioById, TIER3_SCENARIOS, verdictFor } from "../src/tracer/scenarios-tier3.js";

describe("the tier-3 scenario table", () => {
  it("declares the spec's five, plus the baseline they move from", () => {
    expect(TIER3_SCENARIOS.map((s) => s.id)).toEqual([
      "clean-happy-path",
      "yes-during-read-back",
      "backchannel-mid-line",
      "hold-request",
      "third-party-pickup",
      "accent-noise-ablation",
    ]);
  });

  it("says what each scenario it cannot run yet is waiting for", () => {
    const blocked = TIER3_SCENARIOS.filter((s) => s.needs.length > 0).map((s) => s.id);
    expect(blocked).toEqual(["third-party-pickup", "accent-noise-ablation"]);
    for (const id of blocked) expect(scenarioById(id)?.needs.join(" ")).toMatch(/Phase 4/);
  });

  it("expects exactly one read-back on yes-during-read-back, as a bound rather than a relaxed one-or-two", () => {
    expect(scenarioById("yes-during-read-back")?.expected.readBacks).toEqual({ atMost: 1 });
  });

  it("expects the third-party call to disclose nothing", () => {
    const never = scenarioById("third-party-pickup")?.expected.neverSaid ?? [];
    expect(never.some((p) => p.test("your balance of 550 dollars"))).toBe(true);
    expect(never.some((p) => p.test("Thank you, goodbye."))).toBe(false);
  });
});

describe("checkExpectedLedger", () => {
  const happy = { finalOutcome: "PROMISE_TO_PAY", tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"], readBacks: { atLeast: 1, atMost: 1 } };

  it("passes the call the scenario describes", () => {
    expect(
      checkExpectedLedger(happy, {
        finalOutcome: "PROMISE_TO_PAY",
        tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
        agentLines: ["To confirm: you will pay 550 dollars. Please say yes to confirm."],
      }),
    ).toEqual([]);
  });

  it("allows extra tools between the expected ones, in order", () => {
    expect(
      checkExpectedLedger(happy, {
        finalOutcome: "PROMISE_TO_PAY",
        tools: ["confirm_right_party", "get_account_context", "propose_promise_to_pay", "record_promise_to_pay"],
        agentLines: ["Please say yes to confirm."],
      }),
    ).toEqual([]);
  });

  it("names a missing tool, a wrong outcome and a miscounted read-back separately", () => {
    const failures = checkExpectedLedger(happy, {
      finalOutcome: "FAILED",
      tools: ["confirm_right_party"],
      agentLines: ["Please say yes to confirm.", "Let me repeat that. Please say yes to confirm."],
    });
    expect(failures.some((f) => f.includes("outcome FAILED"))).toBe(true);
    expect(failures.some((f) => f.includes("propose_promise_to_pay missing"))).toBe(true);
    expect(failures.some((f) => f.includes("2 read-back(s), expected at most 1"))).toBe(true);
  });

  it("catches a disclosure to someone who is not the borrower", () => {
    const failures = checkExpectedLedger(
      { finalOutcome: null, tools: [], neverSaid: [/balance/i] },
      { finalOutcome: "THIRD_PARTY_CONTACT", tools: [], agentLines: ["Your balance is 550 dollars."] },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("agent said something matching");
  });
});

describe("checkExpectedLedger — truncation", () => {
  const base = { finalOutcome: null, tools: [], agentLines: [], playouts: [] };

  it("fails when an agent line was cut off and the scenario said none should be", () => {
    const out = checkExpectedLedger(
      { finalOutcome: null, tools: [], noTruncatedAgentLine: true },
      { ...base, playouts: [{ interrupted: false }, { interrupted: true }, { interrupted: false }] },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("1 agent line(s) were cut off");
  });

  it("passes when nothing was cut off", () => {
    const out = checkExpectedLedger(
      { finalOutcome: null, tools: [], noTruncatedAgentLine: true },
      { ...base, playouts: [{ interrupted: false }, { interrupted: false }] },
    );
    expect(out).toEqual([]);
  });

  it("fails on no playout evidence at all rather than passing vacuously", () => {
    const out = checkExpectedLedger({ finalOutcome: null, tools: [], noTruncatedAgentLine: true }, base);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("no playout evidence");
  });

  it("is silent when the scenario does not ask about truncation", () => {
    expect(checkExpectedLedger({ finalOutcome: null, tools: [] }, base)).toEqual([]);
  });
});

describe("every scenario says what it is not yet checking", () => {
  it("declares notYetAsserted for the halves that need machinery, and nothing else", () => {
    for (const s of TIER3_SCENARIOS) {
      expect(Array.isArray(s.notYetAsserted ?? [])).toBe(true);
    }
    expect(scenarioById("backchannel-mid-line")?.notYetAsserted ?? []).not.toHaveLength(0);
    expect(scenarioById("hold-request")?.notYetAsserted ?? []).not.toHaveLength(0);
    expect(scenarioById("clean-happy-path")?.notYetAsserted ?? []).toHaveLength(0);
  });
});

describe("verdictFor — a known-red scenario is a tripwire, not a permanent failure", () => {
  const red = { reason: "VAD stops for a backchannel", until: "D5's minDuration sweep", matches: /agent line\(s\) were cut off/ };

  it("passes the run when the only failures are the ones the scenario says to expect", () => {
    const v = verdictFor(["1 agent line(s) were cut off, expected none"], red);
    expect(v.exitCode).toBe(0);
    expect(v.line).toContain("failed as expected");
  });

  it("FAILS the run when a known-red scenario starts passing, because that is the signal", () => {
    const v = verdictFor([], red);
    expect(v.exitCode).toBe(1);
    expect(v.line).toContain("passes now");
  });

  it("FAILS when the scenario failed for some other reason as well, since the mark excuses only the failure it names", () => {
    const v = verdictFor(["1 agent line(s) were cut off, expected none", "outcome NO_ANSWER != expected PROMISE_TO_PAY"], red);
    expect(v.exitCode).toBe(1);
    expect(v.line).toContain("not only in the expected way");
  });

  it("fails when the only failure is a different one", () => {
    const v = verdictFor(["outcome NO_ANSWER != expected PROMISE_TO_PAY"], red);
    expect(v.exitCode).toBe(1);
  });

  it("fails normally when the scenario is not known-red", () => {
    expect(verdictFor(["outcome null != expected PROMISE_TO_PAY"], undefined).exitCode).toBe(1);
    expect(verdictFor([], undefined).exitCode).toBe(0);
  });
});

describe("checkExpectedLedger — dispositions", () => {
  const base = { finalOutcome: null, tools: [], agentLines: [], playouts: [] };

  it("FAILS when the wait never happened, which is the whole point of asserting it", () => {
    const out = checkExpectedLedger({ finalOutcome: null, tools: [], dispositions: ["wait"] }, { ...base, dispositions: ["respond", "respond", "respond"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('no turn recorded disposition "wait"');
  });

  it("passes when one turn recorded it", () => {
    expect(checkExpectedLedger({ finalOutcome: null, tools: [], dispositions: ["wait"] }, { ...base, dispositions: ["respond", "wait", "respond"] })).toEqual([]);
  });

  it("fails when the ledger returned no dispositions at all, rather than passing vacuously", () => {
    const out = checkExpectedLedger({ finalOutcome: null, tools: [], dispositions: ["wait"] }, base);
    expect(out).toHaveLength(1);
  });

  it("says nothing when the scenario does not ask about dispositions", () => {
    expect(checkExpectedLedger({ finalOutcome: null, tools: [] }, { ...base, dispositions: ["respond"] })).toEqual([]);
  });

  it("the hold scenario is the one that asks for a wait", () => {
    expect(scenarioById("hold-request")?.expected.dispositions).toEqual(["wait"]);
  });
});

