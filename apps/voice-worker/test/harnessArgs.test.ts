import { describe, expect, it } from "vitest";
import { parseSimArgs, scanFlags } from "../src/tracer/harness-args.js";

const SPEC = {
  value: { label: "what this run is called", seed: "the seed" },
  boolean: { loud: "say more" },
  usage: "usage: thing --label <name>",
} as const;

describe("scanFlags", () => {
  it("takes values and booleans", () => {
    const r = scanFlags(["--label", "a", "--loud"], SPEC);
    expect(r.ok && r.values.get("label")).toBe("a");
    expect(r.ok && r.booleans.has("loud")).toBe(true);
  });

  it("refuses a flag the harness does not have, rather than ignoring it", () => {
    // H6's second half: a misspelled gate used to run without the gate and say nothing.
    const r = scanFlags(["--label", "a", "--max-wer", "0.2"], SPEC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("--max-wer is not a flag");
  });

  it("skips a bare `--`, because that is a separator and pnpm forwards it", () => {
    // `pnpm run x -- --label a` reaches the script as ["--", "--label", "a"]. Refusing it made the
    // documented invocation in the module's own header fail with exit 2.
    const r = scanFlags(["--", "--label", "a"], SPEC);
    expect(r.ok && r.values.get("label")).toBe("a");
  });

  it("does not let a bare `--` swallow the flag after it", () => {
    const r = scanFlags(["--label", "--", "--loud"], SPEC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("--label needs a value");
  });

  it("refuses a value flag with no value", () => {
    const r = scanFlags(["--label", "--loud"], SPEC);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("--label needs a value");
  });

  it("puts the usage line in every refusal", () => {
    const r = scanFlags(["--nope"], SPEC);
    expect(!r.ok && r.message).toContain("usage: thing --label <name>");
  });
});

describe("parseSimArgs", () => {
  it("requires a label, so two runs of one scenario in a day cannot collide", () => {
    const r = parseSimArgs(["--scenario", "clean-happy-path"]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("--label is required");
  });

  it("normalises the label into something namable", () => {
    const r = parseSimArgs(["--label", "Onset (retry?)"]);
    expect(r.ok && r.args.label).toBe("onset-retry");
  });

  it("defaults the scenario and the seed, and carries the persona through", () => {
    const r = parseSimArgs(["--label", "x", "--persona", "accented"]);
    expect(r.ok && r.args.scenario).toBe("clean-happy-path");
    expect(r.ok && r.args.seedGiven).toBe("1");
    expect(r.ok && r.args.persona).toBe("accented");
  });

  it("accepts a word as a seed, and resolves it to a number that is stable", () => {
    const a = parseSimArgs(["--label", "x", "--seed", "friday"]);
    const b = parseSimArgs(["--label", "x", "--seed", "friday"]);
    expect(a.ok && b.ok && a.args.seed).toBe(b.ok ? b.args.seed : -1);
    expect(a.ok && Number.isInteger(a.args.seed)).toBe(true);
  });

  it("refuses a tier-2 flag, because tier 3 does not have one", () => {
    const r = parseSimArgs(["--label", "x", "--calls", "5"]);
    expect(!r.ok && r.message).toContain("--calls is not a flag");
  });

  it("names the report after scenario and label", () => {
    const r = parseSimArgs(["--label", "onset", "--scenario", "yes-during-read-back"]);
    expect(r.ok && r.args.reportFileName("2026-09-02")).toBe("2026-09-02-tier3-yes-during-read-back-onset.json");
  });
});
