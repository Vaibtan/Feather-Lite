/**
 * The fleet harness's command line (issue #4, H6).
 *
 * Pure and separate from `fake-borrower-fleet.ts` because that module places calls at import time;
 * this is the part a test can hold still.
 *
 * Two defects, and they are the same defect twice. The report was written to
 * `${date}-tier2-n${CALLS}.json`, so a second run on the same day at the same N **silently
 * overwrote the first** — which happened during the 2026-09-02 review, to a tracked report that had
 * to be restored from git, and five more times in the session that wrote this. And `--label` was
 * accepted and ignored, along with every other flag nobody had implemented: a run invoked with a
 * misspelled gate ran without that gate and said nothing.
 *
 * So the label is required and lands in the filename, and an unknown flag is a refusal. Both are
 * about the same thing: a measurement you cannot identify afterwards is not evidence, and a gate
 * you think you passed is worse than one you know you skipped.
 *
 * The scanner itself lives in `harness-args.ts` — tier 3 needed the same two rules, and the lesson
 * is not fleet-specific. What stays here is the fleet's own flags and their bounds.
 */
import { labelOrRefusal, normaliseLabel, refusalOf, scanFlags, type FlagSpec } from "./harness-args.js";

export { normaliseLabel };

/** A flag that takes a value, and what it means when a refusal has to name it. */
const VALUE_FLAGS = {
  calls: "how many concurrent calls to place",
  "max-wer": "the word-error rate above which the run fails",
  label: "what this run is called, which is also what its report is named",
} as const;

/** A flag that is present or absent. */
const BOOLEAN_FLAGS = {
  "in-proc": "run the borrowers in this process instead of a forked child",
  "allow-dev": "measure a dev-mode worker on purpose",
  "allow-no-shedding": "measure a worker that cannot shed load on purpose",
  "allow-shed": "run more calls than the worker will admit, to measure the shedding point on purpose (H4)",
} as const;

export interface FleetArgs {
  readonly calls: number;
  readonly maxWer: number;
  /** Filesystem-safe, and never empty: the report is named after it. */
  readonly label: string;
  readonly inProc: boolean;
  readonly allowDev: boolean;
  readonly allowNoShedding: boolean;
  /** Deliberately running past the worker's admitted concurrency (H4). */
  readonly allowShed: boolean;
}

export type ParsedFleetArgs = { readonly ok: true; readonly args: FleetArgs } | { readonly ok: false; readonly message: string };

const SPEC: FlagSpec = {
  value: VALUE_FLAGS,
  boolean: BOOLEAN_FLAGS,
  usage: "usage: fake-borrower-fleet --label <name> [--calls N] [--max-wer R] [flags]",
};

export const parseFleetArgs = (argv: ReadonlyArray<string>): ParsedFleetArgs => {
  const scanned = scanFlags(argv, SPEC);
  if (!scanned.ok) return scanned;
  const { values, booleans } = scanned;

  const label = labelOrRefusal(SPEC, values.get("label"));
  if (typeof label !== "string") return label;

  const number = (name: "calls" | "max-wer", fallback: number, min: number, max: number): number | null => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  };
  const calls = number("calls", 5, 1, 1000);
  if (calls === null || !Number.isInteger(calls)) return refusalOf(SPEC, "--calls must be a whole number of calls, at least 1.");
  const maxWer = number("max-wer", 0.2, 0, 1);
  if (maxWer === null) return refusalOf(SPEC, "--max-wer must be a rate between 0 and 1.");

  return {
    ok: true,
    args: {
      calls,
      maxWer,
      label,
      inProc: booleans.has("in-proc"),
      allowDev: booleans.has("allow-dev"),
      allowNoShedding: booleans.has("allow-no-shedding"),
      allowShed: booleans.has("allow-shed"),
    },
  };
};

/** Where this run's report goes. The label is in the name so two runs a day cannot collide. */
export const reportFileName = (date: string, calls: number, label: string): string => `${date}-tier2-n${String(calls)}-${label}.json`;
