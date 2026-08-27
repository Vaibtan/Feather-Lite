/**
 * The sampler's pure parts. Every command line in the classification table below was copied out of
 * `Win32_Process` on the dev box on 2026-08-27 with the server in `start` mode and the worker in
 * `start` mode with one warm job slot — so this is a table of what the machine actually says, not
 * of what the patterns were written against.
 */
import { describe, expect, it } from "vitest";
import { busiestCpuWindow, classifyProcess, cumulativeCpuByPid, parseDockerBytes, perCoreBudget, rssSlopeMbPerMin, SERVER_ROLES, validateReport, WORKER_ROLES, type CpuTick, type ResourceReport, type Role } from "../src/resources.js";

const ROOT = "D:/SWE_DEV_NEW/Feather-Lite/";
const TSX = "D:\\SWE_DEV_NEW\\Feather-Lite\\node_modules\\.pnpm\\tsx@4.23.12\\node_modules\\tsx\\dist";
const AGENTS = "D:\\SWE_DEV_NEW\\Feather-Lite\\node_modules\\.pnpm\\@livekit+agents@1.6.4_@live_3358fca6d8fe956e56fa5faaa04aefca\\node_modules\\@livekit\\agents\\dist";
const PRELUDE = `C:\\nvm4w\\nodejs\\node.exe --require ${TSX}\\preflight.cjs --import file:///D:/SWE_DEV_NEW/Feather-Lite/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs`;

const OBSERVED: ReadonlyArray<readonly [string, Role | null, string]> = [
  [`${PRELUDE} src/main.ts`, "server", "the control-plane server itself"],
  [`${PRELUDE} src/agent.ts start`, "worker-main", "the main worker process"],
  [`${PRELUDE} ${AGENTS}\\ipc\\inference_proc_lazy_main.js "{\\"lk_eot_audio\\":\\"file:///D:/.../inference/eot/runner.js\\"}"`, "worker-inference", "the shared EOU inference process"],
  [`${PRELUDE} ${AGENTS}\\ipc\\job_proc_lazy_main.js D:\\SWE_DEV_NEW\\Feather-Lite\\apps\\voice-worker\\src\\agent.ts`, "worker-job", "a job process — carries agent.ts as an argument, so it must not read as the main worker"],
  [`"C:\\nvm4w\\nodejs\\node.exe" C:\\nvm4w\\nodejs/node_modules/corepack/dist/pnpm.js start:server`, "server-launcher", "outer pnpm launcher"],
  [`"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\corepack\\dist\\pnpm.js" --filter @feather-lite/server start`, "server-launcher", "inner pnpm --filter launcher"],
  [`"C:\\nvm4w\\nodejs\\node.exe" C:\\nvm4w\\nodejs/node_modules/corepack/dist/pnpm.js start:worker`, "worker-launcher", "outer pnpm launcher"],
  [`"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\corepack\\dist\\pnpm.js" --filter @feather-lite/voice-worker start`, "worker-launcher", "inner pnpm --filter launcher"],
  [`node "D:\\SWE_DEV_NEW\\Feather-Lite\\apps\\server\\node_modules\\.bin\\..\\tsx\\dist\\cli.mjs" src/main.ts`, "server-launcher", "the tsx supervisor, not the server"],
  [`node "D:\\SWE_DEV_NEW\\Feather-Lite\\apps\\voice-worker\\node_modules\\.bin\\..\\tsx\\dist\\cli.mjs" src/agent.ts start`, "worker-launcher", "the tsx supervisor, not the worker"],
];

describe("classifyProcess", () => {
  for (const [cmd, expected, why] of OBSERVED) {
    it(`${expected ?? "null"}: ${why}`, () => {
      expect(classifyProcess(cmd, ROOT)).toBe(expected);
    });
  }

  it("names the harness's own processes, so a fleet run reports what it cost the box", () => {
    expect(classifyProcess(`${PRELUDE} D:/SWE_DEV_NEW/Feather-Lite/apps/voice-worker/src/tracer/borrower-proc.ts`, ROOT)).toBe("harness-borrower");
    expect(classifyProcess(`${PRELUDE} src/tracer/fake-borrower-fleet.ts`, ROOT)).toBe("harness");
    expect(classifyProcess(`${PRELUDE} src/tier1.ts`, ROOT)).toBe("harness");
    expect(classifyProcess(`"C:\nvm4w\nodejs\node.exe" C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js --filter @feather-lite/voice-worker fake-borrower-fleet`, ROOT)).toBe("harness");
  });

  it("names the bundled forms too, so the D6 build does not need a second classifier", () => {
    expect(classifyProcess("C:/nvm4w/nodejs/node.exe D:/SWE_DEV_NEW/Feather-Lite/apps/server/dist/main.js", ROOT)).toBe("server");
    expect(classifyProcess("C:/nvm4w/nodejs/node.exe D:/SWE_DEV_NEW/Feather-Lite/apps/voice-worker/dist/agent.js start", ROOT)).toBe("worker-main");
  });

  it("does not read any pnpm command mentioning a package as that package running", () => {
    // A `--filter @feather-lite/voice-worker typecheck` during a soak run was named `worker-launcher`
    // and its 129 MB landed in a report taken with no worker running.
    const pnpm = `"C:\nvm4w\nodejs\node.exe" C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js`;
    expect(classifyProcess(`${pnpm} --filter @feather-lite/voice-worker typecheck`, ROOT)).toBeNull();
    expect(classifyProcess(`${pnpm} --filter @feather-lite/server test`, ROOT)).toBeNull();
    expect(classifyProcess(`${pnpm} install`, ROOT)).toBeNull();
    // ...but the real launchers still are.
    expect(classifyProcess(`${pnpm} --filter @feather-lite/voice-worker start`, ROOT)).toBe("worker-launcher");
    expect(classifyProcess(`${pnpm} dev:server`, ROOT)).toBe("server-launcher");
  });

  it("refuses another project's entry point on a shared box", () => {
    expect(classifyProcess("node C:/other-project/src/main.ts", ROOT)).toBeNull();
    expect(classifyProcess("node C:/other-project/dist/agent.js", ROOT)).toBeNull();
  });

  it("refuses unrelated node processes rather than folding them into a total", () => {
    expect(classifyProcess("C:/nvm4w/nodejs/node.exe C:/Users/hp/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js", ROOT)).toBeNull();
    expect(classifyProcess("node /usr/lib/code-server/out/server-main.js", ROOT)).toBeNull();
    expect(classifyProcess("", ROOT)).toBeNull();
  });

  it("is case- and separator-insensitive, because Windows is", () => {
    expect(classifyProcess(`${PRELUDE} SRC/MAIN.TS`.toUpperCase(), ROOT)).toBe("server");
  });
});

describe("parseDockerBytes", () => {
  it.each([
    ["52.1MiB", 54_630_810],
    ["1.203GiB", 1_291_711_414],
    ["987.4kB", 987_400],
    ["512B", 512],
  ])("%s", (text, expected) => {
    expect(parseDockerBytes(text)).toBe(expected);
  });

  it("returns null for anything it cannot read", () => {
    expect(parseDockerBytes("--")).toBeNull();
    expect(parseDockerBytes("")).toBeNull();
  });
});

describe("rssSlopeMbPerMin", () => {
  it("is null below three readings, where a trend is noise", () => {
    expect(rssSlopeMbPerMin([])).toBeNull();
    expect(rssSlopeMbPerMin([{ t: 0, bytes: 1e9 }, { t: 1000, bytes: 2e9 }])).toBeNull();
  });

  it("is null under a minute of wall clock, where working-set settling reads as a trend", () => {
    const twentySeconds = [0, 5_000, 10_000, 15_000, 20_000].map((t, i) => ({ t, bytes: (2900 - i) * 1e6 }));
    expect(rssSlopeMbPerMin(twentySeconds)).toBeNull();
  });

  it("is zero on a flat series", () => {
    expect(rssSlopeMbPerMin([0, 30_000, 60_000, 90_000].map((t) => ({ t, bytes: 500e6 })))).toBe(0);
  });

  it("recovers a known slope", () => {
    // 10 MB per 30 s = 20 MB/min.
    const series = [0, 30_000, 60_000, 90_000].map((t, i) => ({ t, bytes: (100 + 10 * i) * 1e6 }));
    expect(rssSlopeMbPerMin(series)).toBe(20);
  });
});

const report = (over: Partial<ResourceReport> = {}): ResourceReport => ({
  platform: "win32",
  vcpus: 12,
  interval_ms: 1000,
  samples: 60,
  wall_ms: 60_000,
  load_wall_ms: 60_000,
  marked: true,
  roles: [
    { role: "worker-main", pids: [1], samples: 60, peak_rss_bytes: 1.1e9, peak_private_bytes: 1.1e9, cpu_seconds: 18, idle_rss_bytes: 1.0e9, last_rss_bytes: 1.05e9 },
    { role: "worker-job", pids: [2, 3], samples: 60, peak_rss_bytes: 1.0e9, peak_private_bytes: 1.0e9, cpu_seconds: 42, idle_rss_bytes: 0.2e9, last_rss_bytes: 0.9e9 },
    { role: "server", pids: [4], samples: 60, peak_rss_bytes: 0.2e9, peak_private_bytes: 0.2e9, cpu_seconds: 30, idle_rss_bytes: 0.15e9, last_rss_bytes: 0.16e9 },
  ],
  totals: { peak_rss_bytes: 2.3e9, peak_private_bytes: 2.3e9, cpu_seconds: 90, idle_rss_bytes: 1.35e9 },
  subsets: {
    // RSS idle is trimmed well below the private commit, as an idle worker's is on Windows.
    worker: { peak: 2.0e9, idle: 1.2e9, peak_private: 2.1e9, idle_private: 1.6e9, roles: WORKER_ROLES },
    server: { peak: 0.2e9, idle: 0.15e9, peak_private: 0.22e9, idle_private: 0.17e9, roles: SERVER_ROLES },
  },
  // The busiest minute: the worker spent 45 of its 60 CPU-seconds in it, the server 10 of 30.
  steady_state: { target_ms: 60_000, full_window: false, worker: { cpu_seconds: 45, wall_ms: 60_000 }, server: { cpu_seconds: 10, wall_ms: 60_000 } },
  rss_slope_mb_per_min: 0.4,
  private_slope_mb_per_min: 0.4,
  containers: [],
  host: { total_mem_bytes: 16e9, free_mem_bytes_start: 3e9, free_mem_bytes_end: 1e9 },
  unclassified_pids: 0,
  notes: [],
  ...over,
});

describe("perCoreBudget", () => {
  it("computes the spec's figures from the worker subset over the steady-state window", () => {
    // 45 CPU-seconds in the busiest minute = 0.75 cores; 5 calls / 0.75 = 6.67 calls per vCPU.
    const b = perCoreBudget(report(), { roles: WORKER_ROLES, calls: 5 });
    expect(b.cores_used).toBe(0.75);
    expect(b.calls_per_vcpu).toBe(6.67);
    expect(b.cores_over_full_window).toBe(false);
    // (2.0 GB peak - 1.2 GB idle) / 5 calls = 160 MB per call, from the joint tree, not role maxima.
    expect(b.mb_per_call).toBe(160);
    // The same call costs 100 MB of private commit. The RSS figure is inflated by the idle working
    // set having been trimmed and faulted back in, which is not memory the call asked for.
    expect(b.mb_per_call_private).toBe(100);
    expect(b.vcpus).toBe(12);
  });

  it("does not let a run's idle ramp flatter its core count", () => {
    // Whole window: 60 CPU-s over 60 s = 1.0 core, and 5 calls / 1.0 = 5 calls per vCPU, which
    // reads as *cheaper* than the steady-state answer above. That is the direction the ramp always
    // errs in, and why D1 asks for the minute rather than the run.
    const wholeWindow = perCoreBudget(report({ steady_state: { target_ms: 60_000, full_window: true, worker: { cpu_seconds: 60, wall_ms: 60_000 }, server: { cpu_seconds: 30, wall_ms: 60_000 } } }), {
      roles: WORKER_ROLES,
      calls: 5,
    });
    expect(wholeWindow.cores_used).toBe(1);
    expect(wholeWindow.calls_per_vcpu).toBe(5);
    expect(wholeWindow.cores_over_full_window).toBe(true);
  });

  it("computes turns/s/core from the server subset", () => {
    // 10 CPU-seconds in the busiest minute = 0.167 cores.
    const b = perCoreBudget(report(), { roles: SERVER_ROLES, turnsPerSecond: 78 });
    expect(b.cores_used).toBe(0.167);
    expect(b.turns_per_s_per_core).toBe(467.07);
  });

  it("divides the per-unit-of-work figures by the whole run, not the steady-state window", () => {
    // CPU per turn and per call-minute answer "what did one unit of work cost", so windowing the
    // numerator while the denominator counts every unit would understate both.
    expect(perCoreBudget(report(), { roles: SERVER_ROLES, turns: 300 }).cpu_seconds_per_turn).toBe(0.1);
    expect(perCoreBudget(report(), { roles: WORKER_ROLES, calls: 5, callMinutes: 5 }).cpu_seconds_per_call_minute).toBe(12);
  });

  it("is null rather than zero when nothing was sampled", () => {
    const b = perCoreBudget(report({ samples: 0 }), { roles: WORKER_ROLES, calls: 5, turnsPerSecond: 10 });
    expect(b.cores_used).toBeNull();
    expect(b.calls_per_vcpu).toBeNull();
    expect(b.turns_per_s_per_core).toBeNull();
  });

  it("is null rather than zero for a figure whose other input is missing", () => {
    const b = perCoreBudget(report(), { roles: WORKER_ROLES });
    expect(b.cores_used).toBe(0.75);
    expect(b.calls_per_vcpu).toBeNull();
    expect(b.mb_per_call).toBeNull();
  });
});

describe("validateReport", () => {
  const valid = { resources: report(), per_core: perCoreBudget(report(), { roles: SERVER_ROLES }) };

  it("passes a report that carries a resources block", () => {
    expect(validateReport(valid)).toEqual([]);
  });

  it("refuses a report with no resources block, which is the whole point", () => {
    expect(validateReport({ per_core: {} })).toEqual(["report has no `resources` block"]);
    expect(validateReport(null)).toEqual(["report is not an object"]);
  });

  it("names every part of the block that is missing", () => {
    const problems = validateReport({ resources: { platform: "win32", vcpus: 12, interval_ms: 1000, samples: 5, wall_ms: 1, load_wall_ms: 1, roles: [] }, per_core: {} });
    expect(problems).toContain("resources.totals is missing");
    expect(problems).toContain("resources.subsets is missing");
    expect(problems).toContain("resources.steady_state is missing");
  });

  it("refuses an unmeasured run that does not admit to being unmeasured", () => {
    // `samples: 0` is legitimate — a platform with no sampler — but it has to be declared, or the
    // zeroes below it read as "the tree used nothing".
    expect(validateReport({ resources: report({ samples: 0, notes: [] }), per_core: {} })).toContain(
      "resources.samples is 0 but no note says the run was not measured",
    );
    expect(validateReport({ resources: report({ samples: 0, notes: ["no samples were taken; every resource number below is absent, not zero"] }), per_core: {} })).toEqual([]);
  });
});

/**
 * The window arithmetic, against the case that broke it: a job process that finishes its call
 * before the window closes. `cpuByPid` is rebuilt from `Get-Process` each tick, so such a process
 * is simply absent from every later tick — and reading the closing tick directly credited it with
 * nothing. In a fleet run that is the ordinary case, not an edge one, and the error runs in the
 * flattering direction: less CPU counted, so fewer cores, so more calls per vCPU.
 */
const ticks = (rows: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]>): CpuTick[] =>
  rows.map(([t, pairs]) => ({ t, cpuByPid: new Map(pairs.map(([pid, cpu]) => [pid, cpu])) }));

describe("cumulativeCpuByPid", () => {
  it("holds a process's CPU after it exits instead of dropping it", () => {
    // pid 2 is born at tick 1, spends 4 CPU-seconds, and is gone by tick 3.
    const series = ticks([
      [0, [[1, 100]]],
      [1_000, [[1, 100.5], [2, 1]]],
      [2_000, [[1, 101], [2, 4]]],
      [3_000, [[1, 101.5]]],
    ]);
    const spent = cumulativeCpuByPid(series);
    expect([...spent.get(2)!]).toEqual([0, 1, 4, 4]);
    // pid 1 was alive before the run, so the 100 s it arrived with is not this run's.
    expect([...spent.get(1)!]).toEqual([0, 0.5, 1, 1.5]);
  });

  it("counts all of a process born inside the run, from zero", () => {
    const spent = cumulativeCpuByPid(ticks([[0, [[1, 5]]], [1_000, [[1, 6], [2, 3]]]]));
    expect([...spent.get(2)!]).toEqual([0, 3]);
  });
});

describe("busiestCpuWindow", () => {
  // Five ticks a second apart; pid 2 works hard early and exits, pid 1 ticks over throughout.
  const series = ticks([
    [0, [[1, 0]]],
    [1_000, [[1, 0.1], [2, 0]]],
    [2_000, [[1, 0.2], [2, 1]]],
    [3_000, [[1, 0.3], [2, 2]]],
    [4_000, [[1, 0.4]]],
  ]);
  const spent = cumulativeCpuByPid(series);

  it("credits a window with the CPU of a process that exited inside it", () => {
    // 0 -> 4 s: pid 1 spent 0.4, pid 2 spent 2.0 before exiting. Reading the closing tick alone
    // would have seen pid 2 absent and reported 0.4.
    const w = busiestCpuWindow(series, spent, [1, 2], 4_000);
    expect(w.cpu_seconds).toBe(2.4);
    expect(w.wall_ms).toBe(4_000);
    expect(w.full).toBe(false);
  });

  it("picks the busiest window, not the first or the longest", () => {
    // Two-second windows: [0,2] has 1.2, [1,3] has 2.2 (0.2 from pid 1, all 2.0 of pid 2's work),
    // [2,4] has 1.2. The middle one wins.
    expect(busiestCpuWindow(series, spent, [1, 2], 2_000).cpu_seconds).toBe(2.2);
  });

  it("falls back to the whole span, flagged, when nothing reaches the target", () => {
    const w = busiestCpuWindow(series, spent, [1, 2], 60_000);
    expect(w.full).toBe(true);
    expect(w.cpu_seconds).toBe(2.4);
    expect(w.wall_ms).toBe(4_000);
  });

  it("respects the load mark, so setup CPU stays out of the window", () => {
    expect(busiestCpuWindow(series, spent, [1, 2], 60_000, 2).cpu_seconds).toBe(1.2);
  });

  it("says nothing rather than guessing when there is no series", () => {
    expect(busiestCpuWindow([], new Map(), [1], 60_000)).toEqual({ cpu_seconds: 0, wall_ms: 0, full: true });
  });
});
