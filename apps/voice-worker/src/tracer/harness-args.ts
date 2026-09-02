/**
 * The command line every tracer harness shares (issue #4, H6, generalised for tier 3).
 *
 * H6 was written for the fleet and its lesson is not fleet-specific: **a measurement you cannot
 * identify afterwards is not evidence, and a gate you think you passed is worse than one you know
 * you skipped.** So a label is required and lands in the filename, and an unknown flag is a refusal
 * rather than a silent no-op — a run invoked with a misspelled gate used to run without that gate
 * and say nothing.
 *
 * Tier 3 had neither. Its first cut carried the ad hoc `flag()` helper that `shed-probe.ts` still
 * has and that `fleet-args.ts` was written to replace: an optional label defaulting to the scenario
 * id, so a second run of one scenario in a day overwrote the first — the exact collision that cost a
 * tracked report on 2026-09-02. Rather than teach the same lesson a third time, the scanner moves
 * here and each harness declares only its own flags.
 */
import { seedFrom } from "@feather-lite/domain";

/** What flags a harness has, and what each means when a refusal has to name it. */
export interface FlagSpec {
  readonly value: Readonly<Record<string, string>>;
  readonly boolean: Readonly<Record<string, string>>;
  readonly usage: string;
}

export type Scanned =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string>; readonly booleans: ReadonlySet<string> }
  | { readonly ok: false; readonly message: string };

/** Every refusal carries the usage, because the reader of a refusal is someone mid-run. */
export const refusalOf = (spec: FlagSpec, why: string): { readonly ok: false; readonly message: string } => {
  const lines = [
    ...Object.entries(spec.value).map(([k, w]) => `  --${k} <value>   ${w}`),
    ...Object.entries(spec.boolean).map(([k, w]) => `  --${k}   ${w}`),
  ];
  return { ok: false, message: `${why}\n${spec.usage}\n${lines.join("\n")}` };
};

export const scanFlags = (argv: ReadonlyArray<string>, spec: FlagSpec): Scanned => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    // A bare `--` is the separator, not a flag: `pnpm run x -- --label a` forwards it verbatim, and
    // refusing it made the invocation documented in each harness's own header exit 2.
    if (token === "--") continue;
    const name = token.slice(2);
    if (name in spec.value) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return refusalOf(spec, `--${name} needs a value.`);
      values.set(name, v);
      i += 1;
      continue;
    }
    if (name in spec.boolean) {
      booleans.add(name);
      continue;
    }
    return refusalOf(spec, `--${name} is not a flag this harness has.`);
  }
  return { ok: true, values, booleans };
};

/**
 * Lower-case, digits and dashes. Not a general slug: the label becomes a filename in a directory
 * read by humans and globbed by scripts, and a run called `N=10 (retry?)` is a filename nobody can
 * type.
 */
export const normaliseLabel = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The refusal that exists because a tracked report was lost to it. Shared, since the reason is. */
export const labelOrRefusal = (spec: FlagSpec, raw: string | undefined): string | { readonly ok: false; readonly message: string } => {
  const label = normaliseLabel(raw ?? "");
  return label.length > 0
    ? label
    : refusalOf(spec, "--label is required: without it a second run on the same day overwrites the first, which is how a tracked report was lost on 2026-09-02.");
};

const SIM_SPEC: FlagSpec = {
  value: {
    scenario: "which tier-3 scenario to run",
    seed: "the seed, as a number or a word — it goes in the report, because that is what makes a run repeatable",
    persona: "which borrower voice to synthesise the lines with",
    label: "what this run is called, which is also what its report is named",
  },
  boolean: {},
  usage: "usage: sim-borrower --label <name> [--scenario id] [--seed n|word] [--persona name]",
};

export interface SimArgs {
  readonly scenario: string;
  /** Both halves, because a report that carries only the resolved number cannot be re-invoked. */
  readonly seedGiven: string;
  readonly seed: number;
  readonly persona: string | undefined;
  readonly label: string;
  readonly reportFileName: (date: string) => string;
}

export type ParsedSimArgs = { readonly ok: true; readonly args: SimArgs } | { readonly ok: false; readonly message: string };

export const parseSimArgs = (argv: ReadonlyArray<string>): ParsedSimArgs => {
  const scanned = scanFlags(argv, SIM_SPEC);
  if (!scanned.ok) return scanned;

  const label = labelOrRefusal(SIM_SPEC, scanned.values.get("label"));
  if (typeof label !== "string") return label;

  const scenario = scanned.values.get("scenario") ?? "clean-happy-path";
  const seedGiven = scanned.values.get("seed") ?? "1";
  const seed = /^\d+$/.test(seedGiven) ? Number(seedGiven) : seedFrom(seedGiven);

  return {
    ok: true,
    args: {
      scenario,
      seedGiven,
      seed,
      persona: scanned.values.get("persona"),
      label,
      reportFileName: (date: string) => `${date}-tier3-${scenario}-${label}.json`,
    },
  };
};
