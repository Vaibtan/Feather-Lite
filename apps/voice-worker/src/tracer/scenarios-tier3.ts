/**
 * A scenario is a borrower script and the ledger shape that call must leave, in one object: an
 * expectation that lives elsewhere drifts from what it checks. Turn-taking is a table of seeded
 * events rather than an LLM, because the harness runs in real time against a real SFU.
 */
import { makeRng, type Rng } from "@feather-lite/domain";
import type { BorrowerScript, CallContext } from "./scripted-call.js";

export interface ExpectedLedger {
  readonly finalOutcome: string | null;
  /** Tools that must appear, in order, allowing others between them. */
  readonly tools: ReadonlyArray<string>;
  /** The yes-during-read-back defect is two read-backs, and nothing before this could count them. */
  readonly readBacks?: { readonly atLeast?: number; readonly atMost?: number } | undefined;
  /** Text that must never appear in any agent line. */
  readonly neverSaid?: ReadonlyArray<RegExp> | undefined;
  /**
   * In any order. The ledger says what the control plane decided, so a scenario can require a
   * `wait` rather than inferring it from a silence, which is also what a slow model looks like.
   */
  readonly dispositions?: ReadonlyArray<string> | undefined;
  /**
   * From `AGENT_TURN_PLAYOUT.interrupted`, the only durable record of whether audio finished.
   * Absence of playout rows fails rather than passing for want of evidence.
   */
  readonly noTruncatedAgentLine?: boolean | undefined;
}

export interface Tier3Scenario {
  readonly id: string;
  readonly what: string;
  readonly needs: ReadonlyArray<string>;
  readonly expected: ExpectedLedger;
  /**
   * The middle ground between `needs` (refuse to run) and silence (run and pass): what cannot be
   * checked is named, printed on every run and carried in the report.
   */
  readonly notYetAsserted?: ReadonlyArray<string> | undefined;
  /**
   * The expectation stays as written; the run passes while it fails for the stated reason and fails
   * the moment it starts passing. Neither a relaxed expectation nor a permanently red run.
   */
  readonly expectedToFail?: { readonly reason: string; readonly until: string; readonly matches: RegExp } | undefined;
  readonly script: (rng: Rng) => BorrowerScript;
}

export const verdictFor = (
  failures: ReadonlyArray<string>,
  expectedToFail: { readonly reason: string; readonly until: string; readonly matches: RegExp } | undefined,
): { readonly exitCode: 0 | 1; readonly line: string } => {
  if (expectedToFail === undefined) {
    return failures.length === 0 ? { exitCode: 0, line: "as expected" } : { exitCode: 1, line: `${String(failures.length)} FAILURE(S)` };
  }
  if (failures.length === 0) {
    return { exitCode: 1, line: `passes now, and the scenario still says it should not — ${expectedToFail.until} appears to have landed; drop expectedToFail` };
  }
  /**
   * The mark excuses the failure it names and only that one: without the filter a broken worker
   * failed for an unrelated reason and the run still reported "failed as expected" and exited 0.
   */
  const unexpected = failures.filter((f) => !expectedToFail.matches.test(f));
  if (unexpected.length > 0) {
    return { exitCode: 1, line: `failed, and not only in the expected way — ${String(unexpected.length)} other failure(s): ${unexpected.join("; ")}` };
  }
  return { exitCode: 0, line: `failed as expected — ${expectedToFail.reason}; ${expectedToFail.until} is what changes it` };
};

const firstNameOf = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const READBACK = /say yes to confirm/i;

const upToReadBack = async (ctx: CallContext): Promise<number> => {
  ctx.log("waiting for opening to finish...");
  const cursor = await ctx.waitAgentSaid(new RegExp(`speak with ${firstNameOf(ctx.borrowerName)}`, "i"), 0, 60_000);
  await ctx.sleep(1500);
  await ctx.speak("yes this is the borrower", ctx.lines.yes);
  if (await ctx.waitAgentSpeaking(60_000)) {
    await ctx.sleep(2000);
    await ctx.speak("BARGE-IN: I can pay 550 on Friday", ctx.lines.pay);
  } else {
    await ctx.speak("I can pay 550 on Friday", ctx.lines.pay);
  }
  return Math.max(cursor, ctx.agentSaid.length);
};

const waitReadBack = async (ctx: CallContext, from: number, timeoutMs: number): Promise<number> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !ctx.agentGone) {
    const idx = ctx.agentSaid.findIndex((seg, i) => i >= from && READBACK.test(seg.text));
    if (idx >= 0) return idx;
    await ctx.sleep(100);
  }
  return -1;
};

export const TIER3_SCENARIOS: ReadonlyArray<Tier3Scenario> = [
  {
    id: "clean-happy-path",
    what: "the tier-2 conversation, run through the tier-3 runner: the baseline the other four move from",
    needs: [],
    expected: {
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
      readBacks: { atLeast: 1, atMost: 1 },
    },
    script: () => ({
      name: "clean-happy-path",
      run: async (ctx) => {
        const from = await upToReadBack(ctx);
        const rb = await waitReadBack(ctx, from, 60_000);
        if (rb < 0) ctx.log("no read-back seen; confirming anyway (the ledger check will catch it)");
        await ctx.sleep(2500); // the transcript stream closes before audio playout finishes
        await ctx.speak("yes, that's correct", ctx.lines.confirm);
        ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
      },
    }),
  },
  {
    id: "yes-during-read-back",
    what: "the borrower says yes while the read-back is still playing — the defect this tier was built to reproduce",
    needs: [],
    expected: {
      /**
       * One read-back, not two: the read-back is non-interruptible, so a "yes" spoken during it is
       * parked rather than committing a turn the fully-heard guard then refuses.
       */
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
      readBacks: { atMost: 1 },
    },
    script: (rng) => ({
      name: "yes-during-read-back",
      run: async (ctx) => {
        await upToReadBack(ctx);
        // Onset, not transcript: a segment arrives when it closes, so waiting for its text would
        // put the "yes" after the read-back and reproduce nothing.
        const onset = await ctx.waitNextStretchStart(60_000);
        if (onset === null) {
          ctx.log("the agent never started a line to interrupt; this scenario cannot assert its shape");
          return;
        }
        // Into the read-back, not at its first word: a "yes" on the first word races the turn's
        // own commit, which is a different test.
        const offset = rng.int(900, 1500);
        ctx.log(`agent line started; saying yes ${String(offset)}ms into it, while it is still playing`);
        await ctx.sleep(offset);
        await ctx.speak("yes (during the read-back)", ctx.lines.yesEarly);
        // A fixed sleep is not enough — the segment runs about eight seconds, and a confirmation
        // landing inside it is dropped.
        if (!(await ctx.waitAgentQuiet(700, 30_000))) ctx.log("agent never went quiet; confirming anyway");
        await ctx.speak("yes, that's correct", ctx.lines.confirm);
        ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
      },
    }),
  },
  {
    id: "backchannel-mid-line",
    what: "a 'mm-hm' during an agent line: the agent should not stop for it",
    needs: [],
    expected: {
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
      readBacks: { atLeast: 1 },
      /**
       * Expected to fail on the current system, and that is the measurement: VAD stops the agent
       * for "mm-hm". A scenario asserting the broken behaviour would be rewritten the day it is fixed.
       */
      noTruncatedAgentLine: true,
    },
    expectedToFail: {
      reason: "VAD stops the agent for a backchannel, which is the false interruption D4 named",
      until: "D5's `interruption.minDuration` sweep (issue #1, Phase 2)",
      /** Only the truncation is excused; any other failure still fails the run. */
      matches: /agent line\(s\) were cut off|no playout evidence/,
    },
    notYetAsserted: ["a recorded `resume` decision (D4) — `resume` is issue #1's D2 and does not exist yet"],
    script: (rng) => ({
      name: "backchannel-mid-line",
      run: async (ctx) => {
        ctx.log("waiting for opening to finish...");
        await ctx.waitAgentSaid(new RegExp(`speak with ${firstNameOf(ctx.borrowerName)}`, "i"), 0, 60_000);
        await ctx.sleep(1500);
        await ctx.speak("yes this is the borrower", ctx.lines.yes);
        if (await ctx.waitAgentSpeaking(60_000)) {
          await ctx.sleep(rng.int(700, 1400));
          await ctx.speak("mm-hm (backchannel)", ctx.lines.backchannel);
        }
        // Long enough that the backchannel closes as its own utterance: at 1 500 ms the endpointer
        // merged it with the payment offer, and a merged final carries content and is not one.
        await ctx.sleep(3500);
        await ctx.speak("I can pay 550 on Friday", ctx.lines.pay);
        const rb = await waitReadBack(ctx, ctx.agentSaid.length, 60_000);
        if (rb >= 0) await ctx.sleep(2500);
        await ctx.speak("yes, that's correct", ctx.lines.confirm);
        ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
      },
    }),
  },
  {
    id: "hold-request",
    what: "'hold on, let me get my card': the agent should wait rather than fill the silence",
    needs: [],
    expected: {
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
      readBacks: { atLeast: 1 },
      dispositions: ["wait"],
    },
    /**
     * Deliberately not `expectedToFail`: it was, on a single observation, and the next run of the
     * same seed passed and the tripwire refused it. A scenario is only known-red when reliably red.
     */
    notYetAsserted: [
      "a recorded `wait` decision, and no agent speech until the next borrower line (D4) — `wait` is issue #1's D1/D2 and does not exist yet",
    ],
    script: (rng) => ({
      name: "hold-request",
      run: async (ctx) => {
        ctx.log("waiting for opening to finish...");
        await ctx.waitAgentSaid(new RegExp(`speak with ${firstNameOf(ctx.borrowerName)}`, "i"), 0, 60_000);
        await ctx.sleep(1500);
        await ctx.speak("yes this is the borrower", ctx.lines.yes);
        // Spoken back-to-back the endpointer merges the two lines into one final, which carries
        // content and is therefore correctly not a hold; a hold has to arrive as its own turn.
        await ctx.waitAgentSpeaking(60_000);
        await ctx.sleep(2500);
        await ctx.speak("hold on, let me get my card", ctx.lines.hold);
        const quiet = rng.int(3000, 5000);
        ctx.log(`holding for ${String(quiet)}ms; a compliant agent says nothing in it`);
        await ctx.sleep(quiet);
        await ctx.speak("I can pay 550 on Friday", ctx.lines.pay);
        const rb = await waitReadBack(ctx, ctx.agentSaid.length, 60_000);
        if (rb >= 0) await ctx.sleep(2500);
        await ctx.speak("yes, that's correct", ctx.lines.confirm);
        ctx.log((await ctx.waitForHangup(40_000)) ? "agent hung up" : "agent did not hang up within 40s");
      },
    }),
  },
  {
    id: "third-party-pickup",
    what: "someone who is not the borrower answers: the agent must disclose nothing",
    /** Declared before the machinery exists because the expectation is the reviewable part. */
    needs: ["a second participant in the room (Phase 4)"],
    expected: {
      finalOutcome: "THIRD_PARTY_CONTACT",
      tools: ["confirm_right_party"],
      neverSaid: [/\b\d+ dollars\b/i, /balance/i, /past due/i],
    },
    script: () => ({
      name: "third-party-pickup",
      run: async (ctx) => {
        ctx.log("third-party-pickup needs a second participant; not runnable yet");
      },
    }),
  },
  {
    id: "accent-noise-ablation",
    what: "the happy path over a degraded channel, per persona: equivalence must hold and entity error is reported",
    needs: ["audio degradation and the persona set (Phase 4)"],
    expected: {
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
    },
    script: () => ({
      name: "accent-noise-ablation",
      run: async (ctx) => {
        ctx.log("accent-noise-ablation needs the degradation chain; not runnable yet");
      },
    }),
  },
];

export const scenarioById = (id: string): Tier3Scenario | undefined => TIER3_SCENARIOS.find((s) => s.id === id);

/** Returns the failures rather than throwing, so one scenario's miss does not hide the next one's. */
export const checkExpectedLedger = (
  expected: ExpectedLedger,
  actual: {
    readonly finalOutcome: string | null;
    readonly tools: ReadonlyArray<string>;
    readonly agentLines: ReadonlyArray<string>;
    /** The only durable answer to "did that line finish?". */
    readonly playouts?: ReadonlyArray<{ readonly interrupted: boolean }> | undefined;
    readonly dispositions?: ReadonlyArray<string> | undefined;
  },
): ReadonlyArray<string> => {
  const failures: string[] = [];
  if (expected.finalOutcome !== null && actual.finalOutcome !== expected.finalOutcome) {
    failures.push(`outcome ${String(actual.finalOutcome)} != expected ${expected.finalOutcome}`);
  }
  // In order, others allowed between: a clarifying question is a legitimate extra turn.
  let at = 0;
  for (const tool of expected.tools) {
    const i = actual.tools.indexOf(tool, at);
    if (i < 0) {
      failures.push(`tool ${tool} missing (saw ${JSON.stringify(actual.tools)})`);
      break;
    }
    at = i + 1;
  }
  if (expected.readBacks) {
    const n = actual.agentLines.filter((l) => READBACK.test(l)).length;
    if (expected.readBacks.atLeast !== undefined && n < expected.readBacks.atLeast) failures.push(`${String(n)} read-back(s), expected at least ${String(expected.readBacks.atLeast)}`);
    if (expected.readBacks.atMost !== undefined && n > expected.readBacks.atMost) failures.push(`${String(n)} read-back(s), expected at most ${String(expected.readBacks.atMost)}`);
  }
  for (const wanted of expected.dispositions ?? []) {
    if (!(actual.dispositions ?? []).includes(wanted)) {
      failures.push(`no turn recorded disposition ${JSON.stringify(wanted)} (saw ${JSON.stringify(actual.dispositions ?? [])})`);
    }
  }
  if (expected.noTruncatedAgentLine === true) {
    const playouts = actual.playouts ?? [];
    if (playouts.length === 0) {
      failures.push("no playout evidence, so 'no truncated agent line' cannot be confirmed (C1: absence is not a pass)");
    } else {
      const cut = playouts.filter((p) => p.interrupted).length;
      if (cut > 0) failures.push(`${String(cut)} agent line(s) were cut off, expected none`);
    }
  }
  for (const pattern of expected.neverSaid ?? []) {
    const said = actual.agentLines.find((l) => pattern.test(l));
    if (said !== undefined) failures.push(`agent said something matching ${String(pattern)}: ${JSON.stringify(said.slice(0, 80))}`);
  }
  return failures;
};

export const rngFor = (seed: number): Rng => makeRng(seed);
