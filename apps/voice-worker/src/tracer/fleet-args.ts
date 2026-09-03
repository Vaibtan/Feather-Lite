/**
 * Separate from `fake-borrower-fleet.ts` because that module places calls at import time; this is
 * the part a test can hold still. The scanner is shared, in `harness-args.ts`.
 */
import { labelOrRefusal, normaliseLabel, refusalOf, scanFlags, type FlagSpec } from "./harness-args.js";

export { normaliseLabel };

const VALUE_FLAGS = {
  calls: "how many concurrent calls to place",
  "max-wer": "the word-error rate above which the run fails",
  "max-amount-errors": "how many amounts the transcript may lose before the run fails (D3; an amount error is a wrong promise, not a degraded transcript)",
  label: "what this run is called, which is also what its report is named",
} as const;

const BOOLEAN_FLAGS = {
  "in-proc": "run the borrowers in this process instead of a forked child",
  "allow-dev": "measure a dev-mode worker on purpose",
  "allow-no-shedding": "measure a worker that cannot shed load on purpose",
  "allow-shed": "run more calls than the worker will admit, to measure the shedding point on purpose (H4)",
} as const;

export interface FleetArgs {
  readonly calls: number;
  readonly maxWer: number;
  /**
   * Zero by default and deliberately: a wrong amount is a wrong promise, so it is not the kind of
   * thing that gets a tolerance. Dates and names are reported rather than gated.
   */
  readonly maxAmountErrors: number;
  /** Filesystem-safe, and never empty: the report is named after it. */
  readonly label: string;
  readonly inProc: boolean;
  readonly allowDev: boolean;
  readonly allowNoShedding: boolean;
  /** Deliberately running past the worker's admitted concurrency. */
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

  const number = (name: "calls" | "max-wer" | "max-amount-errors", fallback: number, min: number, max: number): number | null => {
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
  const maxAmountErrors = number("max-amount-errors", 0, 0, 1000);
  if (maxAmountErrors === null || !Number.isInteger(maxAmountErrors)) return refusalOf(SPEC, "--max-amount-errors must be a whole number of amounts, at least 0.");

  return {
    ok: true,
    args: {
      calls,
      maxWer,
      maxAmountErrors,
      label,
      inProc: booleans.has("in-proc"),
      allowDev: booleans.has("allow-dev"),
      allowNoShedding: booleans.has("allow-no-shedding"),
      allowShed: booleans.has("allow-shed"),
    },
  };
};

/** The label is in the name so two runs on one day cannot collide. */
export const reportFileName = (date: string, calls: number, label: string): string => `${date}-tier2-n${String(calls)}-${label}.json`;
