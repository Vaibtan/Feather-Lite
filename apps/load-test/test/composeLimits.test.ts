/**
 * The compose worker's memory ceiling has to agree with the concurrency it is told to carry
 * (review #7).
 *
 * It did not. `mem_limit: 3g` sat under `WORKER_MAX_JOBS: ${WORKER_MAX_JOBS:-8}` while the comment
 * beside it sized the container for four calls — 4.4 GB demanded against a 3 GB cgroup, so under
 * exactly the N=10 load the efficiency spec's acceptance bar names the kernel would kill the whole
 * worker and every call on it. Per-job limits do not save it: eight jobs at the 800 MB ceiling is
 * past 3 GB on their own.
 *
 * This asserts the inequality rather than the numbers, so raising either side deliberately is a
 * one-line change and raising one and forgetting the other is a failing test.
 *
 * The file is read as text and the three values picked out by name. A YAML parser would be a
 * dependency for three scalars, and a regex that stops finding its key fails loudly here rather
 * than quietly passing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const compose = readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8");

/** The `worker:` service's block, so `mem_limit` cannot be read off `postgres` or `server`. */
const workerBlock = (): string => {
  const start = compose.indexOf("\n  worker:");
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  // Ends at the next top-level key (`volumes:`) or the next two-space service key.
  const end = rest.search(/\n(?:\S|  [a-z_-]+:\n)/);
  return end === -1 ? rest : rest.slice(0, end);
};

/** `KEY: ${KEY:-N}` or `KEY: N`. */
const envDefault = (block: string, key: string): number => {
  const m = new RegExp(`${key}:\\s*(?:\\$\\{${key}:-(\\d+)\\}|(\\d+))`).exec(block);
  expect(m, `${key} not found in the worker service`).not.toBeNull();
  return Number(m?.[1] ?? m?.[2]);
};

const memLimitMb = (block: string): number => {
  const m = /mem_limit:\s*(\d+)([gm])/i.exec(block);
  expect(m, "mem_limit not found in the worker service").not.toBeNull();
  return Number(m?.[1]) * (m?.[2]?.toLowerCase() === "g" ? 1024 : 1);
};

/**
 * Measured on the worker **container** and written beside the limit in `docker-compose.yml`. Kept
 * here as the one place the arithmetic lives, so the comment and the assertion cannot disagree.
 *
 * Container numbers, not host ones (2026-09-01): the worker only ever runs in this container, and
 * the earlier host figures described a different VAD on a different platform. `docker stats` on an
 * idle worker with four warm slots reads 1 093 MB; five concurrent calls peaked at 2 018-2 095 MB,
 * so a call costs ~200 MB above idle. The 20 % margin is on the per-call term, where the variance
 * is, rather than on the fixed one, which is a warm pool that does not move.
 */
const FIXED_MB = 1093; // idle: main + inference + four warm job slots, native VAD
const PER_CALL_MB = 240; // ~200 MB measured, +20 %; confirmed exactly at N=9: (2917 - 755) / 9 = 240

/**
 * The acceptance bar, and the ceiling it needs.
 *
 * These are not the same number, which is the finding of the first N=10 attempt. `WORKER_MAX_JOBS`
 * is the denominator of the load the worker reports to the SFU, and the SFU stops assigning at
 * `WORKER_LOAD_THRESHOLD` — so a ceiling of ten is a *served* concurrency of eight or nine, and the
 * run's tenth call finalized `NEVER_SERVED` without the worker ever seeing it.
 */
const ACCEPTANCE_CALLS = 10;
const LOAD_THRESHOLD = 0.75; // `WORKER_LOAD_THRESHOLD`'s default, in `agent.ts`
const ACCEPTANCE_CEILING = 14; // 14 x 0.75 = 10.5, so ten are assigned and the eleventh is shed

describe("docker-compose worker sizing", () => {
  it("gives the worker enough memory for the calls it is configured to carry", () => {
    const block = workerBlock();
    const maxJobs = envDefault(block, "WORKER_MAX_JOBS");
    const demanded = FIXED_MB + maxJobs * PER_CALL_MB;
    expect(memLimitMb(block)).toBeGreaterThanOrEqual(demanded);
  });

  it("keeps a warm slot for every call it will not refuse, without over-warming", () => {
    // `WORKER_IDLE_PROCESSES` above `WORKER_MAX_JOBS` is memory held for jobs that will be refused.
    const block = workerBlock();
    expect(envDefault(block, "WORKER_IDLE_PROCESSES")).toBeLessThanOrEqual(envDefault(block, "WORKER_MAX_JOBS"));
  });

  it("carries the acceptance run's ceiling, which is not the same as its ten calls", () => {
    // Ten is the efficiency spec's acceptance bar. **The ceiling that serves ten is fourteen**, and
    // that distinction cost the first N=10 attempt a call.
    //
    // `loadFunc` reports `activeJobs / WORKER_MAX_JOBS` and the SFU stops assigning at
    // `load >= WORKER_LOAD_THRESHOLD` — so the ceiling and the concurrency the SFU will actually
    // hand over differ by the margin the threshold exists for. Measured 2026-09-01:
    // `WORKER_MAX_JOBS=10` started **nine** jobs for ten calls, and the tenth finalized
    // `NEVER_SERVED`. `agent.ts` says the same thing beside the constant.
    //
    // So what `mem_limit` has to cover is the ceiling the worker will *accept*, not the ten it is
    // asked to serve — otherwise the ceiling is a number that OOM-kills the container it exists to
    // protect. Until 2026-09-01 this assertion was the counterexample instead
    // (`1093 + 10 x 240 > 3 x 1024`), there to prove the arithmetic could fail; the run came due and
    // it became a live guard.
    const block = workerBlock();
    expect(ACCEPTANCE_CEILING * LOAD_THRESHOLD).toBeGreaterThanOrEqual(ACCEPTANCE_CALLS);
    expect(memLimitMb(block)).toBeGreaterThanOrEqual(FIXED_MB + ACCEPTANCE_CEILING * PER_CALL_MB);
  });
});
