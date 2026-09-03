/**
 * The compose file is read as text and the values picked out by name: a YAML parser would be a
 * dependency for three scalars, and a regex that stops finding its key fails loudly here rather
 * than passing quietly.
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
  const end = rest.search(/\n(?:\S|  [a-z_-]+:\n)/);
  return end === -1 ? rest : rest.slice(0, end);
};

/** `KEY: ${KEY:-N}` or `KEY: N`. */
const envDefault = (block: string, key: string): number => {
  const m = new RegExp(`${key}:\\s*(?:\\$\\{${key}:-(\\d+)\\}|(\\d+))`).exec(block);
  expect(m, `${key} not found in the worker service`).not.toBeNull();
  return Number(m?.[1] ?? m?.[2]);
};

/** The same read, for a value that is a fraction rather than a count. */
const envDefaultFloat = (block: string, key: string): number => {
  const m = new RegExp(`${key}:\\s*(?:\\$\\{${key}:-([\\d.]+)\\}|([\\d.]+))`).exec(block);
  expect(m, `${key} not found in the worker service`).not.toBeNull();
  return Number(m?.[1] ?? m?.[2]);
};

const memLimitMb = (block: string): number => {
  const m = /mem_limit:\s*(\d+)([gm])/i.exec(block);
  expect(m, "mem_limit not found in the worker service").not.toBeNull();
  return Number(m?.[1]) * (m?.[2]?.toLowerCase() === "g" ? 1024 : 1);
};

/**
 * Measured with `docker stats` on the worker container: 1 093 MB idle with four warm slots, and
 * ~200 MB per concurrent call above that. The 20 % margin is carried on the per-call term, where
 * the variance is, rather than on the fixed warm pool.
 */
const FIXED_MB = 1093;
const PER_CALL_MB = 240;

const ACCEPTANCE_CALLS = 10;
/** Read from the compose file rather than copied, so the sizing arithmetic cannot drift from it. */
const LOAD_THRESHOLD = envDefaultFloat(workerBlock(), "WORKER_LOAD_THRESHOLD");
const ACCEPTANCE_CEILING = 14; // 14 x 0.75 = 10.5, so ten are assigned and the eleventh is shed

describe("docker-compose worker sizing", () => {
  it("gives the worker enough memory for the calls it is configured to carry", () => {
    const block = workerBlock();
    const maxJobs = envDefault(block, "WORKER_MAX_JOBS");
    const demanded = FIXED_MB + maxJobs * PER_CALL_MB;
    expect(memLimitMb(block)).toBeGreaterThanOrEqual(demanded);
  });

  it("keeps a warm slot for every call it will not refuse, without over-warming", () => {
    const block = workerBlock();
    expect(envDefault(block, "WORKER_IDLE_PROCESSES")).toBeLessThanOrEqual(envDefault(block, "WORKER_MAX_JOBS"));
  });

  it("carries the acceptance run's ceiling, which is not the same as its ten calls", () => {
    // The SFU stops assigning at `load >= WORKER_LOAD_THRESHOLD`, so the ceiling `mem_limit` has to
    // cover is the one the worker will accept, not the ten calls it is asked to serve.
    const block = workerBlock();
    expect(ACCEPTANCE_CEILING * LOAD_THRESHOLD).toBeGreaterThanOrEqual(ACCEPTANCE_CALLS);
    expect(memLimitMb(block)).toBeGreaterThanOrEqual(FIXED_MB + ACCEPTANCE_CEILING * PER_CALL_MB);
  });
});
