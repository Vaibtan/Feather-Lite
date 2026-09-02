/**
 * The tier-3 scenarios (issue #1, D4 — Phase 1).
 *
 * A scenario is two things and it is important that they are the same object: **a borrower script**,
 * so the call happens, and **the ledger shape that call must leave**, so the call is judged by
 * something other than "it did not crash". A scenario whose expectation lives somewhere else is a
 * scenario that will drift from what it checks.
 *
 * Turn-taking is a **table of seeded events, not an LLM** — issue #1's Q2, and not reopened here:
 * the harness runs in real time against a real SFU, so reproducibility outranks realism. The seed
 * exists for the parts that are genuinely stochastic (D4's audio degradation, Phase 4) and for the
 * offsets a scenario chooses to jitter; the offsets themselves are data.
 *
 * The five are the spec's five. Two of them — third-party pickup and the accent × noise ablations —
 * need machinery Phase 4 builds (a second participant in the room, and the degradation chain), so
 * they are declared here with what they will assert and marked as needing it. Declaring them now is
 * the point of a table: the shapes are reviewable before the machinery exists, and the runner
 * refuses to pretend it ran one it cannot.
 */
import { makeRng, type Rng } from "@feather-lite/domain";
import type { BorrowerScript, CallContext } from "./scripted-call.js";

/** What a scenario expects the ledger to look like afterwards. Checked against the conversation. */
export interface ExpectedLedger {
  /** The call's final outcome, or null if the scenario does not fix one. */
  readonly finalOutcome: string | null;
  /** Tools that must appear, in order, allowing others between them. */
  readonly tools: ReadonlyArray<string>;
  /**
   * How many times the agent spoke the promise read-back.
   *
   * The number this whole tier exists to pin: the yes-during-read-back defect is *two* read-backs,
   * and nothing before tier 3 could count them.
   */
  readonly readBacks?: { readonly atLeast?: number; readonly atMost?: number } | undefined;
  /** Text that must never appear in any agent line — the compliance half (third-party pickup). */
  readonly neverSaid?: ReadonlyArray<RegExp> | undefined;
  /**
   * Dispositions the call must have recorded, in any order (D4; issue #1's D1).
   *
   * The half of "hold request expects `wait`" that can be asserted from outside. The ledger says
   * what the control plane decided, so a scenario can require that a `wait` actually happened rather
   * than inferring it from a silence — which is also what a slow model looks like.
   */
  readonly dispositions?: ReadonlyArray<string> | undefined;
  /**
   * No agent line was cut off (D4: backchannel mid-line "expects no truncated agent line").
   *
   * Read from the ledger's `AGENT_TURN_PLAYOUT.interrupted`, which is the only durable record of
   * whether audio finished — the transcript looks identical either way. **Absence of playout rows
   * fails**, rather than passing for want of evidence: that is precisely the defect C1 fixed in the
   * read-back guard, and a harness must not reintroduce it one directory over.
   */
  readonly noTruncatedAgentLine?: boolean | undefined;
}

export interface Tier3Scenario {
  readonly id: string;
  readonly what: string;
  /** What this scenario cannot run without. Empty means it runs today. */
  readonly needs: ReadonlyArray<string>;
  readonly expected: ExpectedLedger;
  /**
   * What this scenario **runs but does not yet check**, and why.
   *
   * The middle ground between `needs` (refuse to run) and silence (run and pass). D4 asks the
   * backchannel scenario for a recorded `resume` and the hold scenario for a `wait`; both are
   * decisions issue #1's D1/D2 introduce and neither exists to assert against. The half that can be
   * checked today is checked; the half that cannot is named here, printed on every run and carried
   * in the report — because a gate you think you passed is worse than one you know you skipped.
   */
  readonly notYetAsserted?: ReadonlyArray<string> | undefined;
  /**
   * This scenario asserts what the system **should** do and the system does not do it yet.
   *
   * Neither of the two bad options: not a relaxed expectation (which would have to be rewritten the
   * day it is fixed, and quietly asserts the defect in the meantime), and not a permanently red run
   * (which teaches a reader that red means nothing). The expectation stays as D4 wrote it, the run
   * passes while it fails **for the stated reason**, and it **fails the moment it starts passing** —
   * which is the signal that the phase named in `until` landed.
   */
  readonly expectedToFail?: { readonly reason: string; readonly until: string; readonly matches: RegExp } | undefined;
  readonly script: (rng: Rng) => BorrowerScript;
}

/** What a run's exit code should be, given its failures and whether the scenario expected them. */
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
   * The mark excuses **the failure it names, and only that one**.
   *
   * Found by running it: a broken worker produced `NO_ANSWER` with no tools at all, and the run
   * reported "failed as expected" and exited 0, because the mark excused every failure. A known-red
   * scenario that goes green on a broken box is worse than no scenario at all.
   */
  const unexpected = failures.filter((f) => !expectedToFail.matches.test(f));
  if (unexpected.length > 0) {
    return { exitCode: 1, line: `failed, and not only in the expected way — ${String(unexpected.length)} other failure(s): ${unexpected.join("; ")}` };
  }
  return { exitCode: 0, line: `failed as expected — ${expectedToFail.reason}; ${expectedToFail.until} is what changes it` };
};

const firstNameOf = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const READBACK = /say yes to confirm/i;

/** Everything before the read-back is the same conversation in every scenario; only the end differs. */
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

/** Wait for the read-back to appear after `from`; returns its index, or -1. */
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
       * **One read-back. Phase 2 flipped this, and the flip is the verification.**
       *
       * It used to be `atLeast: 2`, asserting the defect: a "yes" spoken during the read-back was
       * transcribed, committed a turn, was refused by the fully-heard guard, and the read-back
       * played again — eight seconds of it, on the turn the borrower was most ready to agree on.
       * D1 marks the read-back non-interruptible, so `held` (F2) can park a turn that arrives during
       * it, and the same seed now produces one read-back where it produced two.
       *
       * The scenario says yes *after* the read-back finishes, because that is what a borrower whose
       * agent does not talk over them does. Saying it during the read-back is still measured — by
       * `turn.agent_interrupt_rate` and by the open worker-side item in
       * `docs/loadtest/README.md`, which is that words spoken into a non-interruptible segment are
       * dropped at the worker rather than deferred to the control plane as Q4 intends.
       */
      finalOutcome: "PROMISE_TO_PAY",
      tools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
      readBacks: { atMost: 1 },
    },
    script: (rng) => ({
      name: "yes-during-read-back",
      run: async (ctx) => {
        await upToReadBack(ctx);
        /**
         * **Onset, not transcript.** The read-back's segment arrives when it *closes*, so a scenario
         * that waits for its text and then speaks is speaking after the read-back — which is an
         * ordinary confirmation and reproduces nothing. The first attempt at this scenario did
         * exactly that and reported one read-back where the defect produces two.
         *
         * The agent's next stretch after the borrower's payment offer is the read-back, so waiting
         * for that stretch to *begin* is what puts the "yes" inside it. This is the seam H1 built.
         */
        const onset = await ctx.waitNextStretchStart(60_000);
        if (onset === null) {
          ctx.log("the agent never started a line to interrupt; this scenario cannot assert its shape");
          return;
        }
        /**
         * Into the read-back, not at its first word. ~8 s of audio, so 900–1 500 ms in is comfortably
         * inside it and past the opening phrase — a "yes" on the first word races the turn's own
         * commit, which is a different test and belongs to Phase 2's sweep.
         */
        const offset = rng.int(900, 1500);
        ctx.log(`agent line started; saying yes ${String(offset)}ms into it, while it is still playing`);
        await ctx.sleep(offset);
        await ctx.speak("yes (during the read-back)", ctx.lines.yesEarly);
        /**
         * Then confirm properly once the read-back has finished.
         *
         * Before D1 this waited for a **second** read-back, because there always was one. Now there
         * is not, and a scenario that waits for it hangs until its timeout and never confirms —
         * which is how the first run after the fix reported one read-back and no recorded promise.
         */
        /**
         * Wait for the read-back to actually finish. A fixed sleep is not enough: the read-back runs
         * about eight seconds and the early "yes" lands a second into it, so the first attempt at
         * this confirmed four seconds later — still inside the segment, still dropped, and the run
         * reported one read-back with no promise recorded.
         */
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
       * D4's own words for this scenario. **Expected to fail on the current system**, and that is
       * the measurement: VAD stops the agent for "mm-hm", which is what `turn.false_interrupt_rate`
       * counts and what D5's `interruption.minDuration` sweep is meant to fix before any classifier
       * is written. A scenario that asserted the broken behaviour would have to be rewritten the day
       * it was fixed.
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
        // Into the agent's reply, where a backchannel is a listener noise rather than a bid.
        if (await ctx.waitAgentSpeaking(60_000)) {
          await ctx.sleep(rng.int(700, 1400));
          await ctx.speak("mm-hm (backchannel)", ctx.lines.backchannel);
        }
        await ctx.sleep(1500);
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
      /** D4's own expectation for this scenario, assertable now that issue #1's D1 `wait` exists. */
      dispositions: ["wait"],
    },
    /**
     * **Not marked `expectedToFail`, and the reason is worth keeping.** One run on seed 3 ended
     * `NO_ANSWER` at 161 s with the promise never recorded, and it was marked known-red on that
     * single observation; the next run of the same seed passed cleanly, and the tripwire refused it
     * with "passes now". A scenario is only known-red when it is reliably red. What the hold does to
     * a call is still an open question — it is in `docs/loadtest/README.md` as one.
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
        /**
         * **Let the agent answer first, and let the STT close the previous utterance.**
         *
         * Spoken back-to-back, the endpointer merges the two lines into one turn: a live run
         * produced `"Yes. This is Jordan. Hold on. Let me get my card."` as a single final, which
         * carries content and is therefore correctly *not* a hold. The scenario then passed without
         * ever exercising `wait`. A hold has to arrive as its own turn — which in a real call it
         * does, because the borrower answers, the agent replies, and only then does she ask for a
         * moment.
         */
        await ctx.waitAgentSpeaking(60_000);
        await ctx.sleep(2500);
        await ctx.speak("hold on, let me get my card", ctx.lines.hold);
        // The silence the hold buys. Until D1's `wait` exists the agent fills it, and the scenario's
        // job is to make that visible rather than to pass regardless.
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
    /**
     * Needs a second participant publishing audio into the room, which is Phase 4's work (D4's
     * second half). Declared now because the *expectation* is the interesting part and it is
     * reviewable without the machinery: this is the FDCPA rule the state machine encodes, and the
     * spec's own note is that it is currently assumed rather than exercised.
     */
    needs: ["a second participant in the room (Phase 4)"],
    expected: {
      finalOutcome: "THIRD_PARTY_CONTACT",
      tools: ["confirm_right_party"],
      // No balance, no due date, no amount — to anyone who is not the verified borrower.
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
    /** Needs the degradation chain and the persona set — D4's second half, Phase 4. */
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

/**
 * Check a finished call against the shape its scenario expects.
 *
 * Returns the failures rather than throwing, so one scenario's miss does not hide the next one's —
 * the same rule the equivalence runner follows.
 */
export const checkExpectedLedger = (
  expected: ExpectedLedger,
  actual: {
    readonly finalOutcome: string | null;
    readonly tools: ReadonlyArray<string>;
    readonly agentLines: ReadonlyArray<string>;
    /** The ledger's playout rows — the only durable answer to "did that line finish?". */
    readonly playouts?: ReadonlyArray<{ readonly interrupted: boolean }> | undefined;
    /** What the control plane decided about each turn (issue #1, D1). */
    readonly dispositions?: ReadonlyArray<string> | undefined;
  },
): ReadonlyArray<string> => {
  const failures: string[] = [];
  if (expected.finalOutcome !== null && actual.finalOutcome !== expected.finalOutcome) {
    failures.push(`outcome ${String(actual.finalOutcome)} != expected ${expected.finalOutcome}`);
  }
  // In order, others allowed between: a scenario cares that the sequence happened, not that nothing
  // else did — a clarifying question is a legitimate extra turn (ADR 0008 D1).
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

/** The seeded generator a scenario draws from, so a run is reproducible from `--seed`. */
export const rngFor = (seed: number): Rng => makeRng(seed);
