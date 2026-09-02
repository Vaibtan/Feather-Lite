/**
 * The worker's numeric configuration, and the rule that a typo cannot silently remove a limit
 * (review #18).
 *
 * The defect this pins: `Math.max(1, Number("eight"))` is `NaN`, and `inFlight() >= NaN` is always
 * false — so a misspelled `WORKER_MAX_JOBS` did not raise the ceiling, it deleted it. The admission
 * controller Phase 0 built to refuse the ninth call would have accepted every call ever offered,
 * and the heartbeat would have reported `max_jobs: null` to a page nobody reads during a burst.
 *
 * The table is the point. Every row is a value an operator can actually type.
 */
import { describe, expect, it } from "vitest";
import { MAX_JOBS, IDLE_PROCESSES, parseCount, parseWorkerLimits, interruptionMode } from "../src/env.js";

describe("parseCount", () => {
  it("takes a whole number at or above the minimum", () => {
    expect(parseCount("8", MAX_JOBS)).toEqual({ ok: true, value: 8 });
    expect(parseCount("1", MAX_JOBS)).toEqual({ ok: true, value: 1 });
    expect(parseCount(" 10 ", MAX_JOBS)).toEqual({ ok: true, value: 10 });
  });

  it("takes zero where zero is a meaningful setting", () => {
    // The whole reason the framework patch exists: `WORKER_IDLE_PROCESSES=0` means "no warm pool",
    // and until the patch it meant "the production default, four". A parser that refused 0 here
    // would put the lie back in a different place.
    expect(parseCount("0", IDLE_PROCESSES)).toEqual({ ok: true, value: 0 });
  });

  it("falls back when the variable is not set at all", () => {
    // Unset is not misconfiguration — it is the documented default, and the limit still exists.
    // An empty string is the same statement: it is what an unset variable expands to.
    expect(parseCount(undefined, MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
    expect(parseCount("", MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
    expect(parseCount("   ", MAX_JOBS)).toEqual({ ok: true, value: MAX_JOBS.fallback });
  });

  it("refuses a value that is not a number, naming the variable and what was typed", () => {
    const r = parseCount("eight", MAX_JOBS);
    expect(r.ok).toBe(false);
    // The message has to be readable in a container log with no context around it.
    expect(r.ok === false && r.message).toContain("WORKER_MAX_JOBS");
    expect(r.ok === false && r.message).toContain("eight");
  });

  it("refuses a value below the minimum rather than clamping it", () => {
    // `Math.max(1, ...)` silently turned `-1` into 1. Clamping is how a configuration file and a
    // running process come to disagree about what the operator asked for.
    expect(parseCount("-1", MAX_JOBS).ok).toBe(false);
    expect(parseCount("0", MAX_JOBS).ok).toBe(false);
    expect(parseCount("-1", IDLE_PROCESSES).ok).toBe(false);
  });

  it("refuses a fraction: these are counts of things", () => {
    expect(parseCount("2.5", MAX_JOBS).ok).toBe(false);
  });

  it("refuses the values that survive Number() but are not counts", () => {
    // `Number("Infinity")` is a number and `Number("0x10")` is 16 — neither is what the operator
    // meant to type, and `Infinity` in particular reads as "no ceiling" all over again.
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
    // An operator fixing a compose file should learn about both typos on one boot rather than
    // finding the second after the restart the first one caused.
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
    // It costs memory and nothing else, and quietly rewriting what an operator typed is how a
    // compose file and a running process come to disagree about the configuration.
    expect(parseWorkerLimits({ WORKER_MAX_JOBS: "2", WORKER_IDLE_PROCESSES: "6" })).toEqual({ ok: true, maxJobs: 2, idleProcesses: 6 });
  });
});

describe("interruptionMode (W1)", () => {
  it("defaults to vad, which is what this deployment actually runs", () => {
    // Not a preference: the self-hosted profile has no credentials for the hosted detector, so
    // asking for `adaptive` got a 401 and a silent fall back to VAD on every job.
    expect(interruptionMode(undefined)).toEqual({ ok: true, value: "vad" });
    expect(interruptionMode("")).toEqual({ ok: true, value: "vad" });
    expect(interruptionMode("   ")).toEqual({ ok: true, value: "vad" });
  });

  it("takes either mode when one is named", () => {
    expect(interruptionMode("vad")).toEqual({ ok: true, value: "vad" });
    // Still selectable: on LiveKit Cloud it runs, and D5's A/B wants to turn it on.
    expect(interruptionMode("adaptive")).toEqual({ ok: true, value: "adaptive" });
  });

  it("refuses a typo rather than quietly picking one", () => {
    // The whole point of W1 is that "I asked for adaptive and silently got VAD" was invisible; a
    // misspelling must not be another way to reach it.
    for (const bad of ["Adaptive", "VAD", "auto", "true", "1"]) {
      const r = interruptionMode(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("WORKER_INTERRUPTION_MODE");
    }
  });
});
