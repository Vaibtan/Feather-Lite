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
 */

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
} as const;

export interface FleetArgs {
  readonly calls: number;
  readonly maxWer: number;
  /** Filesystem-safe, and never empty: the report is named after it. */
  readonly label: string;
  readonly inProc: boolean;
  readonly allowDev: boolean;
  readonly allowNoShedding: boolean;
}

export type ParsedFleetArgs = { readonly ok: true; readonly args: FleetArgs } | { readonly ok: false; readonly message: string };

const usage = (): string => {
  const lines = [
    ...Object.entries(VALUE_FLAGS).map(([k, why]) => `  --${k} <value>   ${why}`),
    ...Object.entries(BOOLEAN_FLAGS).map(([k, why]) => `  --${k}   ${why}`),
  ];
  return `usage: fake-borrower-fleet --label <name> [--calls N] [--max-wer R] [flags]\n${lines.join("\n")}`;
};

/**
 * Lower-case, digits and dashes. Not a general slug: the label becomes a filename in a directory
 * that is read by humans and globbed by scripts, and a run called `N=10 (retry?)` is a filename
 * nobody can type.
 */
export const normaliseLabel = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const parseFleetArgs = (argv: ReadonlyArray<string>): ParsedFleetArgs => {
  const refuse = (why: string): ParsedFleetArgs => ({ ok: false, message: `${why}\n${usage()}` });

  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (name in VALUE_FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return refuse(`--${name} needs a value.`);
      values.set(name, value);
      i += 1;
      continue;
    }
    if (name in BOOLEAN_FLAGS) {
      booleans.add(name);
      continue;
    }
    // The point of H6's second half: a flag nobody implemented used to be accepted in silence, so a
    // run invoked with a misspelled gate ran without it.
    return refuse(`--${name} is not a flag this harness has.`);
  }

  const label = normaliseLabel(values.get("label") ?? "");
  if (label.length === 0) {
    return refuse("--label is required: without it a second run on the same day overwrites the first, which is how a tracked report was lost on 2026-09-02.");
  }

  const number = (name: "calls" | "max-wer", fallback: number, min: number, max: number): number | null => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  };
  const calls = number("calls", 5, 1, 1000);
  if (calls === null || !Number.isInteger(calls)) return refuse("--calls must be a whole number of calls, at least 1.");
  const maxWer = number("max-wer", 0.2, 0, 1);
  if (maxWer === null) return refuse("--max-wer must be a rate between 0 and 1.");

  return {
    ok: true,
    args: {
      calls,
      maxWer,
      label,
      inProc: booleans.has("in-proc"),
      allowDev: booleans.has("allow-dev"),
      allowNoShedding: booleans.has("allow-no-shedding"),
    },
  };
};

/** Where this run's report goes. The label is in the name so two runs a day cannot collide. */
export const reportFileName = (date: string, calls: number, label: string): string => `${date}-tier2-n${String(calls)}-${label}.json`;
