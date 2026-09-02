/**
 * The fleet harness's command line (issue #4, H6).
 *
 * Both halves are about a run you cannot trust afterwards: a report that overwrote the previous one
 * without saying so, and a flag that was accepted and ignored.
 */
import { describe, expect, it } from "vitest";
import { normaliseLabel, parseFleetArgs, reportFileName } from "../src/tracer/fleet-args.js";

const ok = (argv: string[]) => {
  const r = parseFleetArgs(argv);
  if (!r.ok) throw new Error(`expected these args to parse: ${r.message}`);
  return r.args;
};

describe("parseFleetArgs", () => {
  it("takes the documented flags, with the documented defaults", () => {
    const a = ok(["--label", "n5-baseline"]);
    expect(a).toEqual({ calls: 5, maxWer: 0.2, label: "n5-baseline", inProc: false, allowDev: false, allowNoShedding: false });
  });

  it("reads values and booleans together", () => {
    const a = ok(["--calls", "10", "--max-wer", "0.15", "--label", "acceptance", "--in-proc", "--allow-dev"]);
    expect(a.calls).toBe(10);
    expect(a.maxWer).toBe(0.15);
    expect(a.inProc).toBe(true);
    expect(a.allowDev).toBe(true);
    expect(a.allowNoShedding).toBe(false);
  });

  it("requires a label, because without one a second run overwrites the first", () => {
    // This is not tidiness: a tracked report was lost to exactly this on 2026-09-02, and five more
    // runs in one session each had to be copied aside by hand.
    const r = parseFleetArgs(["--calls", "5"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--label is required");
  });

  it("treats a label that normalises to nothing as no label", () => {
    for (const empty of ["", "   ", "///", "--"]) {
      expect(parseFleetArgs(["--label", empty]).ok).toBe(false);
    }
  });

  it("refuses a flag it does not have, rather than accepting it in silence", () => {
    // The defect: `--label` itself used to be accepted and ignored. A run invoked with a misspelled
    // gate ran without that gate and said nothing about it.
    const r = parseFleetArgs(["--label", "x", "--allow-shedding"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--allow-shedding is not a flag this harness has");
  });

  it("refuses a value flag with no value, including one followed by another flag", () => {
    expect(parseFleetArgs(["--label"]).ok).toBe(false);
    expect(parseFleetArgs(["--label", "--in-proc"]).ok).toBe(false);
  });

  it("refuses numbers that are not the quantity they name", () => {
    for (const bad of ["0", "-1", "2.5", "ten", "Infinity"]) {
      expect(parseFleetArgs(["--label", "x", "--calls", bad]).ok).toBe(false);
    }
    for (const bad of ["-0.1", "1.5", "half"]) {
      expect(parseFleetArgs(["--label", "x", "--max-wer", bad]).ok).toBe(false);
    }
  });

  it("ignores the runner's own argv preamble", () => {
    // Called with `process.argv`, whose first two entries are node and the script.
    expect(ok(["/usr/bin/node", "/repo/src/tracer/fake-borrower-fleet.ts", "--label", "via-argv"]).label).toBe("via-argv");
  });
});

describe("normaliseLabel", () => {
  it("makes a filename a human can type and a glob can match", () => {
    expect(normaliseLabel("N=10 (retry?)")).toBe("n-10-retry");
    expect(normaliseLabel("  Before W2  ")).toBe("before-w2");
    expect(normaliseLabel("container-harness")).toBe("container-harness");
  });
});

describe("reportFileName", () => {
  it("puts the label in the name, so two runs a day cannot collide", () => {
    expect(reportFileName("2026-09-02", 5, "before-w2")).toBe("2026-09-02-tier2-n5-before-w2.json");
    expect(reportFileName("2026-09-02", 5, "after-w2")).toBe("2026-09-02-tier2-n5-after-w2.json");
  });
});
