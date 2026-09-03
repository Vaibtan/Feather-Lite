import { describe, expect, it } from "vitest";
import { MAX_JOBS, IDLE_PROCESSES, parseCount, parseWorkerLimits, interruptionMode, parseRatio, LOAD_THRESHOLD, VAD_ACTIVATION, VAD_MIN_SILENCE_MS, JOB_MEMORY_WARN_MB, JOB_MEMORY_LIMIT_MB, INTERRUPTION_MIN_DURATION_MS, parseFlag } from "../src/env.js";

describe("parseCount", () => {
  it("takes a whole number at or above the minimum", () => {
    expect(parseCount("8", MAX_JOBS)).toEqual({ ok: true, value: 8 });
    expect(parseCount("1", MAX_JOBS)).toEqual({ ok: true, value: 1 });
    expect(parseCount(" 10 ", MAX_JOBS)).toEqual({ ok: true, value: 10 });
  });

  it("takes zero where zero is a meaningful setting", () => {
    // `WORKER_IDLE_PROCESSES=0` means "no warm pool", so a parser that refused it would put back
    // the framework default of four.
    expect(parseCount("0", IDLE_PROCESSES)).toEqual({ ok: true, value: 0 });
  });

  it("falls back when the variable is not set at all", () => {
    // An empty string is the same statement as unset: it is what an unset variable expands to.
    expect(parseCount(undefined, MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
    expect(parseCount("", MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
    expect(parseCount("   ", MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
  });

  it("refuses a value that is not a number, naming the variable and what was typed", () => {
    const r = parseCount("eight", MAX_JOBS);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("WORKER_MAX_JOBS");
    expect(r.ok === false && r.message).toContain("eight");
  });

  it("refuses a value below the minimum rather than clamping it", () => {
    expect(parseCount("-1", MAX_JOBS).ok).toBe(false);
    expect(parseCount("0", MAX_JOBS).ok).toBe(false);
    expect(parseCount("-1", IDLE_PROCESSES).ok).toBe(false);
  });

  it("refuses a fraction: these are counts of things", () => {
    expect(parseCount("2.5", MAX_JOBS).ok).toBe(false);
  });

  it("refuses the values that survive Number() but are not counts", () => {
    // These survive `Number()`, and `Infinity` in particular reads as "no ceiling".
    expect(parseCount("Infinity", MAX_JOBS).ok).toBe(false);
    expect(parseCount("NaN", MAX_JOBS).ok).toBe(false);
    expect(parseCount("1e3", MAX_JOBS).ok).toBe(false);
  });
});

describe("parseWorkerLimits", () => {
  it("gives both numbers when both are set", () => {
    expect(parseWorkerLimits({ WORKER_MAX_JOBS: "10", WORKER_IDLE_PROCESSES: "0" })).toEqual({ ok: true, maxJobs: 10, idleProcesses: 0 });
  });

  it("gives the defaults on an environment that sets neither", () => {
    expect(parseWorkerLimits({})).toEqual({ ok: true, maxJobs: MAX_JOBS.fallback, idleProcesses: IDLE_PROCESSES.fallback });
  });

  it("reports every refusal at once, not the first", () => {
    const r = parseWorkerLimits({ WORKER_MAX_JOBS: "eight", WORKER_IDLE_PROCESSES: "-2" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.messages).toHaveLength(2);
    expect(r.ok === false && r.messages.join(" ")).toContain("WORKER_MAX_JOBS");
    expect(r.ok === false && r.messages.join(" ")).toContain("WORKER_IDLE_PROCESSES");
  });
});

describe("the warm pool's default against the ceiling", () => {
  it("never defaults to more warm slots than there are calls to put in them", () => {
    expect(parseWorkerLimits({ WORKER_MAX_JOBS: "2" })).toEqual({ ok: true, maxJobs: 2, idleProcesses: 2 });
    expect(parseWorkerLimits({ WORKER_MAX_JOBS: "10" })).toEqual({ ok: true, maxJobs: 10, idleProcesses: 4 });
  });

  it("leaves an explicit value alone, even above the ceiling", () => {
    expect(parseWorkerLimits({ WORKER_MAX_JOBS: "2", WORKER_IDLE_PROCESSES: "6" })).toEqual({ ok: true, maxJobs: 2, idleProcesses: 6 });
  });
});

describe("interruptionMode", () => {
  it("defaults to vad, which is what this deployment actually runs", () => {
    // Not a preference: the self-hosted profile has no credentials for the hosted detector, so
    // `adaptive` gets a 401 and falls back to VAD anyway.
    expect(interruptionMode(undefined)).toEqual({ ok: true, value: "vad" });
    expect(interruptionMode("")).toEqual({ ok: true, value: "vad" });
    expect(interruptionMode("   ")).toEqual({ ok: true, value: "vad" });
  });

  it("takes either mode when one is named", () => {
    expect(interruptionMode("vad")).toEqual({ ok: true, value: "vad" });
    expect(interruptionMode("adaptive")).toEqual({ ok: true, value: "adaptive" });
  });

  it("refuses a typo rather than quietly picking one", () => {
    for (const bad of ["Adaptive", "VAD", "auto", "true", "1"]) {
      const r = interruptionMode(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("WORKER_INTERRUPTION_MODE");
    }
  });
});

describe("parseRatio", () => {
  it("takes the fallback when unset, and the value when set", () => {
    expect(parseRatio(undefined, LOAD_THRESHOLD)).toEqual({ ok: true, value: 0.75 });
    expect(parseRatio("", LOAD_THRESHOLD)).toEqual({ ok: true, value: 0.75 });
    expect(parseRatio("0.9", LOAD_THRESHOLD)).toEqual({ ok: true, value: 0.9 });
    expect(parseRatio(".5", LOAD_THRESHOLD)).toEqual({ ok: true, value: 0.5 });
    expect(parseRatio("0", LOAD_THRESHOLD)).toEqual({ ok: true, value: 0 });
    expect(parseRatio("1", LOAD_THRESHOLD)).toEqual({ ok: true, value: 1 });
  });

  it("refuses what Number would have accepted and turned into no threshold at all", () => {
    // `load >= NaN` is always false, so these typos delete shedding rather than loosening it.
    for (const bad of ["75%", "eighty", "1e-1", "0x1", "Infinity", "-0.1", "1.5", "0.5.1"]) {
      const r = parseRatio(bad, LOAD_THRESHOLD);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("WORKER_LOAD_THRESHOLD");
    }
  });
});

describe("the knobs that used to bypass the parser", () => {
  it("gives each one its documented default when unset", () => {
    expect(parseRatio(undefined, VAD_ACTIVATION)).toEqual({ ok: true, value: 0.5 });
    expect(parseCount(undefined, VAD_MIN_SILENCE_MS)).toEqual({ ok: true, value: 550 });
    expect(parseCount(undefined, JOB_MEMORY_WARN_MB)).toEqual({ ok: true, value: 400 });
    expect(parseCount(undefined, JOB_MEMORY_LIMIT_MB)).toEqual({ ok: true, value: 800 });
    // The framework's own default, not one this repo invented.
    expect(parseCount(undefined, INTERRUPTION_MIN_DURATION_MS)).toEqual({ ok: true, value: 500 });
  });

  it("refuses a mistyped memory limit rather than removing the limit", () => {
    const r = parseCount("800mb", JOB_MEMORY_LIMIT_MB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("WORKER_JOB_MEMORY_LIMIT_MB");
    // Zero is refused too: it reads as "no limit" and means "kill everything".
    expect(parseCount("0", JOB_MEMORY_LIMIT_MB).ok).toBe(false);
  });
});

describe("parseFlag", () => {
  const spec = { name: "WORKER_THING", fallback: false, means: "a thing" };

  it("takes the fallback when unset or blank, because a default is a decision", () => {
    expect(parseFlag(undefined, spec)).toEqual({ ok: true, value: false });
    expect(parseFlag("   ", spec)).toEqual({ ok: true, value: false });
    expect(parseFlag(undefined, { ...spec, fallback: true })).toEqual({ ok: true, value: true });
  });

  it("accepts the spellings an operator actually types", () => {
    for (const on of ["true", "TRUE", "1", "yes", "on"]) expect(parseFlag(on, spec)).toEqual({ ok: true, value: true });
    for (const off of ["false", "False", "0", "no", "off"]) expect(parseFlag(off, spec)).toEqual({ ok: true, value: false });
  });

  it("refuses a typo rather than reading it as false", () => {
    const r = parseFlag("ture", spec);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("WORKER_THING");
    expect(!r.ok && r.message).toContain("a thing");
  });
});
