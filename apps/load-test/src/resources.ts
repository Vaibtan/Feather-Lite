/**
 * Resource sampler: what the server and the worker actually cost, in the same report as latency.
 *
 * Both harnesses (tier-1 control plane, tier-2 voice fleet) reported milliseconds and nothing else,
 * so "this change is faster" and "this change is cheaper" could not be told apart, and a run that
 * was slow because the box was starved looked identical to a run that was slow because the code
 * regressed. Spec D1: every run reports **peak RSS and CPU-seconds per process role**, and the
 * per-core budget derived from them.
 *
 * How it samples, and why that shape:
 *
 * - One long-lived `powershell` child emits a JSON line per tick. `Get-Process` (~24 ms for the
 *   whole node population) is the per-tick cost; the expensive `Win32_Process` lookup that carries
 *   the command line runs **once per newly seen pid**, because that is the only thing that ever
 *   changes about it. Sampling the whole `Win32_Process` table every second costs ~150 ms of a core
 *   and would perturb the very measurement it is taking.
 * - Roles are assigned from the command line, not from the process tree: the tree is not contiguous
 *   through node processes (pnpm shells out through `cmd`/`pwsh` shims, so the launcher's parent is
 *   a shell this sampler never sees). Anything it cannot name is counted as `unclassified` rather
 *   than folded into a total — a node process on this box may belong to something else entirely,
 *   and quietly attributing it to the worker is exactly the kind of flattering number this harness
 *   exists to avoid.
 * - CPU-seconds for a pid that existed before the run counts the delta from its first sample;
 *   a pid born during the run counts its whole CPU time, since it started at zero. Job processes
 *   are the second case and would otherwise report near-nothing.
 *
 * Container stats (`docker stats --no-stream`) are polled on a slower loop because the command
 * itself takes ~1 s; the SFU and Postgres are the two that matter for a voice run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, freemem, totalmem, platform } from "node:os";
import { fileURLToPath } from "node:url";

/* ------------------------------- roles -------------------------------- */

export const ROLES = [
  "server",
  "server-launcher",
  "worker-main",
  "worker-inference",
  "worker-job",
  "worker-launcher",
  "harness",
  "harness-borrower",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that make up the voice worker's tree, for the tier-2 per-core budget. */
export const WORKER_ROLES: readonly Role[] = ["worker-main", "worker-inference", "worker-job", "worker-launcher"];
/** Roles that make up the control plane's tree, for the tier-1 per-core budget. */
export const SERVER_ROLES: readonly Role[] = ["server", "server-launcher"];

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\\/g, "/").toLowerCase();

/**
 * Name a process from its command line, or return null.
 *
 * Order is load-bearing. The inference and job children are re-executions of the agents SDK's own
 * `ipc/*_lazy_main.js` and carry `apps/voice-worker/src/agent.ts` as an *argument*, so they must be
 * matched before the main worker's own pattern; likewise the two `tsx` supervisor processes carry
 * the entry script's name and must be matched before the entry script itself.
 *
 * Both the `tsx` runtime form (`src/main.ts`) and the bundled form (`dist/main.js`) are matched, so
 * the classifier survives the D6 build without a second pass.
 */
export const classifyProcess = (commandLine: string, repoRoot: string = REPO_ROOT): Role | null => {
  const c = commandLine.replace(/\\/g, "/").toLowerCase();
  const root = repoRoot.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  /** Guards against naming some other project's `src/main.ts` on a shared box. */
  const inRepo = c.includes(root);

  if (c.includes("/ipc/inference_proc_lazy_main")) return "worker-inference";
  if (c.includes("/ipc/job_proc_lazy_main")) return "worker-job";
  // The harness itself, so a fleet run's own cost is reported beside the worker's rather than
  // being invisible (W8) — and, because these roles are in neither budget subset, never folded in.
  if (c.includes("borrower-proc")) return "harness-borrower";
  if (/(fake-borrower|chaos-orphan|tier1|idle-sample|load-test)/.test(c)) return "harness";

  // pnpm's corepack launcher: two per app (`pnpm start:worker` and the `--filter` re-exec). Neither
  // carries the repo path, so they are matched on the script name — and on the script name, not the
  // package name alone. Matching `@feather-lite/voice-worker` anywhere in the command line named a
  // `pnpm --filter @feather-lite/voice-worker typecheck` run as a worker launcher and put its
  // 129 MB and 0.8 CPU-seconds into a soak report that had no worker running at all.
  if (c.includes("corepack/dist/pnpm.js")) {
    if (/\b(start|dev):worker\b|@feather-lite\/voice-worker["'\s]+(start|dev)\b/.test(c)) return "worker-launcher";
    if (/\b(start|dev):server\b|@feather-lite\/server["'\s]+(start|dev)\b/.test(c)) return "server-launcher";
    return null;
  }
  // The `tsx` supervisor that forks the real process.
  if (c.includes("tsx/dist/cli.mjs")) {
    if (c.includes("agent.ts")) return "worker-launcher";
    if (c.includes("main.ts")) return "server-launcher";
    return null;
  }

  /**
   * The bundled processes are launched from the repo root as `node apps/<app>/dist/<entry>.js`, so
   * their command line carries no absolute path and `inRepo` cannot vouch for them. The
   * app-qualified relative path is specific enough on its own — `apps/voice-worker/dist/agent.js`
   * is not a name another project on this box is going to use — and it is why the root `start:*`
   * scripts name the file that way rather than running `node dist/agent.js` from inside the app.
   */
  const qualified = /apps\/(voice-worker\/dist\/agent|server\/dist\/main)\.js/.test(c);
  if (!inRepo && !qualified) return null;
  if (/(apps\/voice-worker\/)?src\/agent\.ts|dist\/agent\.js/.test(c)) return "worker-main";
  if (/(apps\/server\/)?src\/main\.ts|dist\/main\.js/.test(c)) return "server";
  return null;
};

/* ------------------------------ report shape --------------------------- */

export interface RoleResources {
  readonly role: Role;
  readonly pids: readonly number[];
  readonly samples: number;
  readonly peak_rss_bytes: number;
  readonly peak_private_bytes: number;
  readonly cpu_seconds: number;
  /** Tree RSS for this role in the first sample — taken before the load starts, so: idle. */
  readonly idle_rss_bytes: number;
  readonly last_rss_bytes: number;
}

/**
 * Joint memory for a role subset, in both counters, because on Windows they answer different
 * questions and `mb_per_call` is sensitive to which one it asks.
 *
 * Working sets are trimmed when a process sits idle: measured on this box, a worker left alone
 * reported a main process of 191 MB RSS against 1 022 MB of private commit. An `idle` term taken
 * from RSS therefore depends on *how long the worker has been idle*, and a first call that merely
 * faults its own pages back in is charged to `mb_per_call` as though it had allocated them.
 * Private commit does not trim, so `idle_private`/`peak_private` is the pair to read for what a
 * call actually costs the box; the RSS pair is kept because it is what the spec's formula names
 * and what "resident right now" means.
 */
export interface SubsetMemory {
  readonly peak: number;
  readonly idle: number;
  readonly peak_private: number;
  readonly idle_private: number;
  readonly roles: readonly Role[];
}

export interface ContainerResources {
  readonly name: string;
  readonly samples: number;
  readonly peak_mem_bytes: number;
  readonly peak_cpu_percent: number;
  readonly mean_cpu_percent: number;
}

export interface ResourceReport {
  readonly platform: string;
  /** `os.availableParallelism()`. Containers get their own count from the cgroup; see the README. */
  readonly vcpus: number;
  readonly interval_ms: number;
  readonly samples: number;
  readonly wall_ms: number;
  /**
   * Wall clock of the window CPU-seconds cover: from `mark("load")` to the last sample, or the
   * whole run if the harness never marked one. The per-core budget divides by this, not `wall_ms`.
   */
  readonly load_wall_ms: number;
  readonly marked: boolean;
  readonly roles: readonly RoleResources[];
  readonly totals: {
    readonly peak_rss_bytes: number;
    readonly peak_private_bytes: number;
    readonly cpu_seconds: number;
    readonly idle_rss_bytes: number;
  };
  /**
   * True joint tree RSS for the two subsets the per-core budget is defined over, taken over the
   * sample series rather than by adding per-role maxima that never coincided.
   */
  readonly subsets: {
    readonly worker: SubsetMemory;
    readonly server: SubsetMemory;
  };
  /**
   * CPU over the busiest contiguous `target_ms` of the load window, per subset — the spec's
   * "steady-state minute".
   *
   * `cores_used` over the *whole* window is a flattering number for a fleet run: thirty-odd seconds
   * pass between the first room being created and the last call connecting, and averaging the
   * fixed cost of a call across that idle head and the staggered tail understates how busy the
   * worker was while actually carrying N calls. Measured on the N=5 baseline, the difference is
   * about 40 %, all of it in the direction that makes the machine look better.
   *
   * `full_window` is true when the run was shorter than the target, in which case these are the
   * whole-window figures and the budget derived from them says so.
   */
  readonly steady_state: {
    readonly target_ms: number;
    readonly full_window: boolean;
    readonly worker: { readonly cpu_seconds: number; readonly wall_ms: number };
    readonly server: { readonly cpu_seconds: number; readonly wall_ms: number };
  };
  /**
   * MB/min least-squares slope of the classified tree — the soak run's leak detector.
   *
   * Both counters, because on Windows they disagree in a way that matters: the OS trims idle
   * working sets, so a tree doing nothing reports a *negative* RSS slope (−51 MB/min over a 90 s
   * idle sample on the dev box) while its private commit sits still. Private bytes is the counter
   * to read for a leak; RSS is the counter that says what the box is actually holding.
   */
  readonly rss_slope_mb_per_min: number | null;
  readonly private_slope_mb_per_min: number | null;
  readonly containers: readonly ContainerResources[];
  readonly host: {
    readonly total_mem_bytes: number;
    readonly free_mem_bytes_start: number;
    readonly free_mem_bytes_end: number;
  };
  /** Node processes seen but not attributable to this repo. Reported so a surprise is visible. */
  readonly unclassified_pids: number;
  readonly notes: readonly string[];
}

/* ----------------------------- the sampler ----------------------------- */

interface Tick {
  readonly t: number;
  readonly p: ReadonlyArray<readonly [number, number, number, number]>; // pid, rss, private, cpuSeconds
  readonly n?: Record<string, string>;
}

interface PidState {
  role: Role;
  cmd: string;
  lastRss: number;
  samples: number;
}

export interface ResourceSamplerOptions {
  readonly intervalMs?: number;
  readonly containers?: readonly string[];
  readonly containerIntervalMs?: number;
  /** pid -> role, for processes the harness itself owns (itself, a borrower child). */
  readonly roleOverrides?: ReadonlyMap<number, Role>;
  readonly log?: (message: string) => void;
}

const DEFAULT_CONTAINERS = ["feather-lite-livekit", "feather-lite-postgres"] as const;

/** The spec's "steady-state minute" (D1). One minute, because that is what the definition says. */
export const STEADY_STATE_TARGET_MS = 60_000;

/**
 * The PowerShell tick loop. Emits one compact JSON line per interval; command lines are sent once,
 * the first time a pid is seen.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$known = @{}
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rows = @()
  $new = @{}
  foreach ($p in (Get-Process -Name node -ErrorAction SilentlyContinue)) {
    $id = $p.Id
    if (-not $known.ContainsKey($id)) {
      $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine
      if (-not $c) { $c = $p.ProcessName }
      $known[$id] = $c
      $new[[string]$id] = $c
    }
    $rows += ,@($id, $p.WorkingSet64, $p.PrivateMemorySize64, $p.TotalProcessorTime.TotalSeconds)
  }
  $o = @{ t = $t; p = $rows }
  if ($new.Count -gt 0) { $o['n'] = $new }
  ConvertTo-Json -InputObject $o -Depth 4 -Compress
  Start-Sleep -Milliseconds __INTERVAL__
}
`;

export interface ResourceSampler {
  /**
   * Resolve once the first sample has landed — the reading the report calls `idle`, and the
   * `idle_rss_tree` term of `mb_per_call`. Harnesses await this before doing anything, so that the
   * idle reading is genuinely taken with the system idle. It replaces a fixed sleep, which only
   * *hoped* a tick had arrived and would have quietly reported the first under-load sample as the
   * idle one on a box slow enough to miss the deadline. Resolves anyway after `timeoutMs` so a
   * sampler that never starts cannot hang a run; the report's `samples: 0` says so in that case.
   */
  readonly awaitFirstSample: (timeoutMs?: number) => Promise<void>;
  /**
   * Declare that the load starts now. CPU-seconds are counted from the next sample onward, so the
   * harness's own setup does not land in the per-core budget. Call once; the last call wins.
   */
  readonly mark: () => void;
  /** Stop sampling and produce the report. Safe to call twice; the second call returns the same one. */
  readonly stop: () => Promise<ResourceReport>;
}

export const startResourceSampler = (opts: ResourceSamplerOptions = {}): ResourceSampler => {
  const intervalMs = opts.intervalMs ?? 1000;
  const containers = opts.containers ?? DEFAULT_CONTAINERS;
  const containerIntervalMs = opts.containerIntervalMs ?? 5000;
  const overrides = opts.roleOverrides ?? new Map<number, Role>();
  const log = opts.log ?? (() => undefined);
  const notes: string[] = [];

  const pids = new Map<number, PidState>();
  /**
   * Tree RSS per tick, broken down by role. Peaks are taken over this series rather than by summing
   * per-process maxima: two processes that each peak at different moments never held that much
   * memory between them, and the sum would report a tree that never existed.
   */
  const series: Array<{ t: number; byRole: Map<Role, number>; privByRole: Map<Role, number>; privateBytes: number; cpuByPid: Map<number, number> }> = [];
  /**
   * Where the load actually started. Everything before it — the idle wait, minting three thousand
   * fixture borrowers, running the reference scenario — is CPU this run spent but not CPU the
   * *load* spent, and folding it into `cores_used` over a wall clock that also includes it flatters
   * every figure derived from it. Tick 0 is still the idle reading; the mark is where CPU counting
   * starts.
   */
  let markIndex: number | null = null;
  let samples = 0;
  let unclassified = 0;
  const unclassifiedSeen = new Set<number>();
  const startedAt = Date.now();
  const freeStart = freemem();

  const containerStats = new Map<string, { samples: number; peakMem: number; peakCpu: number; cpuSum: number }>();

  let child: ChildProcess | null = null;
  let procfsTimer: NodeJS.Timeout | null = null;
  let report: ResourceReport | null = null;

  /** Resolved by the first ingested tick; see `awaitFirstSample`. The executor runs synchronously,
   * so this is assigned before any tick can arrive. */
  let firstSampleSeen: () => void = () => undefined;
  const firstSample = new Promise<void>((resolve) => {
    firstSampleSeen = resolve;
  });

  const ingest = (tick: Tick): void => {
    samples += 1;
    firstSampleSeen();
    for (const [pidStr, cmd] of Object.entries(tick.n ?? {})) {
      const pid = Number(pidStr);
      const role = overrides.get(pid) ?? classifyProcess(cmd);
      if (role === null) {
        if (!unclassifiedSeen.has(pid)) {
          unclassifiedSeen.add(pid);
          unclassified += 1;
        }
        continue;
      }
      pids.set(pid, { role, cmd, lastRss: 0, samples: 0 });
    }
    const byRole = new Map<Role, number>();
    const privByRole = new Map<Role, number>();
    const cpuByPid = new Map<number, number>();
    let privateBytes = 0;
    for (const [pid, rss, priv, cpu] of tick.p) {
      const st = pids.get(pid);
      if (!st) continue;
      st.lastRss = rss;
      st.samples += 1;
      byRole.set(st.role, (byRole.get(st.role) ?? 0) + rss);
      privByRole.set(st.role, (privByRole.get(st.role) ?? 0) + priv);
      cpuByPid.set(pid, cpu);
      privateBytes += priv;
    }
    series.push({ t: tick.t, byRole, privByRole, privateBytes, cpuByPid });
  };

  if (platform() === "win32") {
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT.replace("__INTERVAL__", String(intervalMs))],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("{")) {
          try {
            ingest(JSON.parse(line) as Tick);
          } catch {
            /* a partial or malformed tick is dropped; the sampler must never fail a run */
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    child.on("error", (e) => {
      notes.push(`sampler child failed: ${String(e)}`);
      log(`[resources] sampler unavailable: ${String(e)}`);
    });
  } else if (platform() === "linux") {
    procfsTimer = setInterval(() => void sampleProcfs(ingest, notes), intervalMs);
    procfsTimer.unref();
    notes.push("procfs sampler (linux); the Windows path is the one exercised on the dev box");
  } else {
    notes.push(`no sampler for platform ${platform()}; resources are not measured`);
  }

  /* ---------------------------- containers ---------------------------- */

  let containerLoop: NodeJS.Timeout | null = null;
  const pollContainers = async (): Promise<void> => {
    if (containers.length === 0) return;
    const out = await runCommand("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}", ...containers]).catch(() => null);
    if (out === null) return;
    for (const line of out.split("\n")) {
      const [name, mem, cpu] = line.trim().split("\t");
      if (!name || !mem || !cpu) continue;
      const bytes = parseDockerBytes(mem.split("/")[0]?.trim() ?? "");
      const pct = Number.parseFloat(cpu.replace("%", ""));
      if (bytes === null || Number.isNaN(pct)) continue;
      const prev = containerStats.get(name) ?? { samples: 0, peakMem: 0, peakCpu: 0, cpuSum: 0 };
      containerStats.set(name, {
        samples: prev.samples + 1,
        peakMem: Math.max(prev.peakMem, bytes),
        peakCpu: Math.max(prev.peakCpu, pct),
        cpuSum: prev.cpuSum + pct,
      });
    }
  };
  if (containers.length > 0) {
    void pollContainers();
    containerLoop = setInterval(() => void pollContainers(), containerIntervalMs);
    containerLoop.unref();
  }

  /* ------------------------------- stop ------------------------------- */

  const stop = async (): Promise<ResourceReport> => {
    if (report) return report;
    if (containerLoop) clearInterval(containerLoop);
    if (procfsTimer) clearInterval(procfsTimer);
    // One last tick has usually just landed; give the pipe a moment rather than truncating it.
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, 1200)));
    child?.kill();

    /** Exact tree memory over a role subset: `peak` is the largest tick, `idle` the first one. */
    const treeFor = (subset: readonly Role[], counter: "byRole" | "privByRole"): { peak: number; idle: number } => {
      const at = (s: (typeof series)[number]) => subset.reduce((a, r) => a + (s[counter].get(r) ?? 0), 0);
      return { peak: series.length === 0 ? 0 : Math.max(...series.map(at)), idle: series[0] ? at(series[0]) : 0 };
    };
    const treeRssFor = (subset: readonly Role[]) => treeFor(subset, "byRole");
    const subsetMemory = (subset: readonly Role[]): SubsetMemory => {
      const rss = treeFor(subset, "byRole");
      const priv = treeFor(subset, "privByRole");
      return { ...rss, peak_private: priv.peak, idle_private: priv.idle, roles: subset };
    };

    const from = markIndex ?? 0;
    /* --- the steady-state window, and the one CPU attribution rule --- */
    const spentByPid = cumulativeCpuByPid(series);
    const pidsIn = (subset: readonly Role[]) => [...pids].filter(([, st]) => subset.includes(st.role)).map(([pid]) => pid);
    /** CPU a role subset spent between two ticks — the one attribution rule the whole file uses. */
    const cpuBetween = (i: number, j: number, subset: readonly Role[]): number =>
      pidsIn(subset).reduce((a, pid) => {
        const spent = spentByPid.get(pid);
        return a + (spent === undefined ? 0 : Math.max(0, (spent[j] ?? 0) - (spent[i] ?? 0)));
      }, 0);

    const busiestWindow = (subset: readonly Role[]) => busiestCpuWindow(series, spentByPid, pidsIn(subset), STEADY_STATE_TARGET_MS, from);
    const steadyWorker = busiestWindow(WORKER_ROLES);
    const steadyServer = busiestWindow(SERVER_ROLES);
    const acc = new Map<Role, { pids: number[]; samples: number; cpu: number; last: number }>();
    for (const [pid, st] of pids) {
      // The same forward-filled rule the windows use, so a process that exits mid-run keeps the CPU
      // it spent here too, and the two numbers in the report can be reconciled with each other.
      const spent = spentByPid.get(pid);
      const cpu = spent === undefined ? 0 : Math.max(0, (spent[series.length - 1] ?? 0) - (spent[from] ?? 0));
      const prev = acc.get(st.role) ?? { pids: [], samples: 0, cpu: 0, last: 0 };
      acc.set(st.role, { pids: [...prev.pids, pid], samples: Math.max(prev.samples, st.samples), cpu: prev.cpu + cpu, last: prev.last + st.lastRss });
    }
    const roles: RoleResources[] = [...acc]
      .map(([role, a]) => {
        const tree = treeRssFor([role]);
        return {
          role,
          pids: a.pids,
          samples: a.samples,
          peak_rss_bytes: tree.peak,
          // Joint, like the RSS peak beside it: the largest this role's processes held *together*,
          // not the sum of maxima they reached at different moments.
          peak_private_bytes: treeFor([role], "privByRole").peak,
          cpu_seconds: Number(a.cpu.toFixed(3)),
          idle_rss_bytes: tree.idle,
          last_rss_bytes: a.last,
        };
      })
      .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));

    const allRoles = roles.map((r) => r.role);
    const measured = allRoles.filter((r) => r !== "harness" && r !== "harness-borrower");
    const whole = treeRssFor(allRoles);


    report = {
      platform: platform(),
      vcpus: availableParallelism(),
      interval_ms: intervalMs,
      samples,
      wall_ms: Date.now() - startedAt,
      /** The window CPU-seconds are counted over: from the load mark, or the whole run without one. */
      load_wall_ms: series[from] && series.length > 0 ? series.at(-1)!.t - series[from]!.t : Date.now() - startedAt,
      marked: markIndex !== null,
      roles,
      totals: {
        peak_rss_bytes: whole.peak,
        peak_private_bytes: treeFor(allRoles, "privByRole").peak,
        cpu_seconds: Number(roles.reduce((a, r) => a + r.cpu_seconds, 0).toFixed(3)),
        idle_rss_bytes: whole.idle,
      },
      subsets: { worker: subsetMemory(WORKER_ROLES), server: subsetMemory(SERVER_ROLES) },
      // Over the roles under test only. The harness is the measuring apparatus, and its own arrival
      // and departure inside the window is a step change that reads as a leak.
      steady_state: {
        target_ms: STEADY_STATE_TARGET_MS,
        full_window: steadyWorker.full && steadyServer.full,
        worker: { cpu_seconds: steadyWorker.cpu_seconds, wall_ms: steadyWorker.wall_ms },
        server: { cpu_seconds: steadyServer.cpu_seconds, wall_ms: steadyServer.wall_ms },
      },
      rss_slope_mb_per_min: rssSlopeMbPerMin(series.map((s) => ({ t: s.t, bytes: sumOver(s.byRole, measured) }))),
      private_slope_mb_per_min: rssSlopeMbPerMin(series.map((s) => ({ t: s.t, bytes: sumOver(s.privByRole, measured) }))),
      containers: [...containerStats].map(([name, s]) => ({
        name,
        samples: s.samples,
        peak_mem_bytes: s.peakMem,
        peak_cpu_percent: Number(s.peakCpu.toFixed(1)),
        mean_cpu_percent: Number((s.cpuSum / Math.max(1, s.samples)).toFixed(1)),
      })),
      host: { total_mem_bytes: totalmem(), free_mem_bytes_start: freeStart, free_mem_bytes_end: freemem() },
      unclassified_pids: unclassified,
      notes: samples === 0 ? [...notes, "no samples were taken; every resource number below is absent, not zero"] : notes,
    };
    return report;
  };

  const awaitFirstSample = async (timeoutMs = intervalMs * 5): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([firstSample, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  };

  return { awaitFirstSample, mark: () => (markIndex = series.length === 0 ? 0 : series.length - 1), stop };
};

/* ------------------------------ procfs path ---------------------------- */

/** Linux/container sampling. Written for the container acceptance run; the Windows path is the one the dev box exercises. */
const sampleProcfs = async (ingest: (t: Tick) => void, notes: string[]): Promise<void> => {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const entries = await readdir("/proc");
    const rows: Array<[number, number, number, number]> = [];
    const names: Record<string, string> = {};
    const clockTicks = 100; // _SC_CLK_TCK is 100 on every Linux this runs on
    const pageSize = 4096;
    for (const e of entries) {
      const pid = Number(e);
      if (!Number.isInteger(pid)) continue;
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
        if (!cmdline.includes("node")) continue;
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        // The comm field can contain spaces and parentheses; fields are counted after the last ')'.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const utime = Number(fields[11] ?? 0);
        const stime = Number(fields[12] ?? 0);
        const rssPages = Number(fields[21] ?? 0);
        rows.push([pid, rssPages * pageSize, rssPages * pageSize, (utime + stime) / clockTicks]);
        names[String(pid)] = cmdline;
      } catch {
        /* the process exited between readdir and read */
      }
    }
    ingest({ t: Date.now(), p: rows, n: names });
  } catch (e) {
    notes.push(`procfs sample failed: ${String(e)}`);
  }
};

/* ------------------------------- helpers ------------------------------- */

const runCommand = (cmd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${String(code)}`))));
  });

/** `docker stats` prints `52.1MiB`, `1.203GiB`, `987.4kB`. */
export const parseDockerBytes = (text: string): number | null => {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const scale: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  const s = scale[unit];
  return s === undefined || Number.isNaN(n) ? null : Math.round(n * s);
};

/**
 * Least-squares slope in MB per minute — the soak run's leak detector.
 *
 * Null below three readings or under a minute of wall clock. Windows trims idle working sets by a
 * percent or so on its own, and extrapolating that to MB/min from a 20-second window reported
 * −100 MB/min on a tree that was doing nothing at all. A leak needs a window long enough to be a
 * trend rather than settling noise, and the run this number exists for (30 turns/s for 300 s) has
 * one.
 */
export const MIN_SLOPE_WINDOW_MS = 60_000;

export const rssSlopeMbPerMin = (series: ReadonlyArray<{ t: number; bytes: number }>): number | null => {
  if (series.length < 3) return null;
  if (series.at(-1)!.t - series[0]!.t < MIN_SLOPE_WINDOW_MS) return null;
  const t0 = series[0]!.t;
  const xs = series.map((s) => (s.t - t0) / 60_000);
  const ys = series.map((s) => s.bytes / 1e6);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : Number((num / den).toFixed(2));
};

/* --------------------------- per-core budget --------------------------- */

export interface PerCoreBudget {
  /** Mean cores busy over the steady-state window: CPU-seconds / wall-seconds. */
  readonly cores_used: number | null;
  /** True when the run was too short to contain a steady-state minute, so this is the whole window. */
  readonly cores_over_full_window: boolean;
  readonly calls_per_vcpu: number | null;
  /** From RSS, as D1's formula names it. Read `mb_per_call_private` beside it — see {@link SubsetMemory}. */
  readonly mb_per_call: number | null;
  /** From private commit, which does not trim while a process idles. The stable one. */
  readonly mb_per_call_private: number | null;
  readonly turns_per_s_per_core: number | null;
  /** Tier 1: CPU-seconds the control plane spent per completed turn. */
  readonly cpu_seconds_per_turn: number | null;
  /** Tier 2: CPU-seconds the worker spent per minute of call carried. */
  readonly cpu_seconds_per_call_minute: number | null;
  readonly vcpus: number;
  readonly basis: string;
}

const sumOver = (byRole: ReadonlyMap<Role, number>, roles: readonly Role[]): number => roles.reduce((a, r) => a + (byRole.get(r) ?? 0), 0);

const sumRoles = (report: ResourceReport, roles: readonly Role[], pick: (r: RoleResources) => number): number =>
  report.roles.filter((r) => roles.includes(r.role)).reduce((a, r) => a + pick(r), 0);

/**
 * The per-core budget, defined once (spec D1) so every report means the same thing by it:
 *
 *   cores_used           = cpu_seconds / wall_seconds        (mean cores busy)
 *   calls_per_vcpu       = N / worker cores_used
 *   mb_per_call          = (peak tree RSS - idle tree RSS) / N
 *   turns_per_s_per_core = throughput / server cores_used
 *
 * Anything whose inputs are missing is `null`, never 0: a budget of zero calls per vCPU and a
 * budget nobody measured are different findings.
 */
export const perCoreBudget = (
  report: ResourceReport,
  input: {
    readonly roles: readonly Role[];
    readonly calls?: number;
    readonly turnsPerSecond?: number;
    /** Completed turns, for tier 1's CPU-seconds per turn. */
    readonly turns?: number;
    /** Total call time carried, for tier 2's CPU-seconds per call-minute. */
    readonly callMinutes?: number;
  },
): PerCoreBudget => {
  // Total CPU over the whole load window: the numerator of the per-unit-of-work figures, which
  // divide by work done rather than by wall clock and so must not be windowed.
  const cpu = sumRoles(report, input.roles, (r) => r.cpu_seconds);
  // The joint tree figures when the caller asks for one of the two named subsets; otherwise the sum
  // of per-role peaks, which can only overstate.
  const same = (a: readonly Role[], b: readonly Role[]) => a.length === b.length && a.every((r) => b.includes(r));
  const isWorker = same(input.roles, WORKER_ROLES);
  const isServer = same(input.roles, SERVER_ROLES);
  const subset = isWorker ? report.subsets.worker : isServer ? report.subsets.server : null;
  // Cores are taken over the steady-state window (D1: "over the steady-state minute of an N-call
  // run"), which is not the same as the whole load window and is not flattered by the ramp.
  const steady = isWorker ? report.steady_state.worker : isServer ? report.steady_state.server : null;
  const wallSeconds = (steady?.wall_ms ?? report.load_wall_ms) / 1000;
  const steadyCpu = steady?.cpu_seconds ?? cpu;
  const coresUsed = report.samples === 0 || wallSeconds <= 0 || steadyCpu <= 0 ? null : Number((steadyCpu / wallSeconds).toFixed(3));
  const peak = subset ? subset.peak : sumRoles(report, input.roles, (r) => r.peak_rss_bytes);
  const idle = subset ? subset.idle : sumRoles(report, input.roles, (r) => r.idle_rss_bytes);
  return {
    cores_used: coresUsed,
    cores_over_full_window: report.steady_state.full_window,
    calls_per_vcpu: coresUsed && input.calls ? Number((input.calls / coresUsed).toFixed(2)) : null,
    mb_per_call: input.calls && peak > idle ? Number(((peak - idle) / 1e6 / input.calls).toFixed(1)) : null,
    mb_per_call_private:
      input.calls && subset && subset.peak_private > subset.idle_private
        ? Number(((subset.peak_private - subset.idle_private) / 1e6 / input.calls).toFixed(1))
        : null,
    turns_per_s_per_core: coresUsed && input.turnsPerSecond ? Number((input.turnsPerSecond / coresUsed).toFixed(2)) : null,
    cpu_seconds_per_turn: cpu > 0 && input.turns ? Number((cpu / input.turns).toFixed(4)) : null,
    cpu_seconds_per_call_minute: cpu > 0 && input.callMinutes ? Number((cpu / input.callMinutes).toFixed(2)) : null,
    vcpus: report.vcpus,
    basis: input.roles.join("+"),
  };
};

/* -------------------------- window arithmetic -------------------------- */

/** One tick's per-pid cumulative CPU seconds, as the sampler observed it. */
export interface CpuTick {
  readonly t: number;
  readonly cpuByPid: ReadonlyMap<number, number>;
}

/**
 * Per-pid CPU **spent during the run**, forward-filled across every tick.
 *
 * Forward-filled because `cpuByPid` is rebuilt from `Get-Process` each tick, so a process that has
 * exited is simply absent from every later tick. Reading a window's closing tick directly therefore
 * credits a job process that finished its call *before* that tick with zero CPU — and job processes
 * finishing before the end of a window is the ordinary case in a fleet run, not an edge one. The
 * error is in the flattering direction (less CPU counted, so fewer cores, so more calls per vCPU),
 * which is the exact bias the steady-state window exists to remove.
 *
 * A pid first seen in tick 0 was alive before the run, so its CPU at that tick is a baseline this
 * run did not spend; one first seen later was born inside the run and all of its CPU counts.
 */
export const cumulativeCpuByPid = (ticks: readonly CpuTick[]): Map<number, Float64Array> => {
  const pids = new Set<number>();
  for (const tick of ticks) for (const pid of tick.cpuByPid.keys()) pids.add(pid);
  const out = new Map<number, Float64Array>();
  for (const pid of pids) {
    const spent = new Float64Array(ticks.length);
    let baseline: number | null = null;
    let last = 0;
    for (let k = 0; k < ticks.length; k++) {
      const cpu = ticks[k]!.cpuByPid.get(pid);
      if (cpu !== undefined) {
        baseline ??= k === 0 ? cpu : 0;
        last = Math.max(0, cpu - baseline);
      }
      spent[k] = last; // held, not dropped, once the process is gone
    }
    out.set(pid, spent);
  }
  return out;
};

export interface CpuWindow {
  readonly cpu_seconds: number;
  readonly wall_ms: number;
  /** True when the series was too short to hold `targetMs`, so this is the whole span. */
  readonly full: boolean;
}

/**
 * The contiguous window of at least `targetMs` with the highest mean core count, over `pids`.
 * Falls back to the whole span `[from, last]` when nothing reaches the target.
 */
export const busiestCpuWindow = (
  ticks: readonly CpuTick[],
  spentByPid: ReadonlyMap<number, Float64Array>,
  pids: Iterable<number>,
  targetMs: number,
  from = 0,
): CpuWindow => {
  const members = [...pids].map((pid) => spentByPid.get(pid)).filter((s): s is Float64Array => s !== undefined);
  const cpu = (i: number, j: number) => members.reduce((a, s) => a + Math.max(0, (s[j] ?? 0) - (s[i] ?? 0)), 0);
  const last = ticks.length - 1;
  if (ticks.length < 2 || from >= last) {
    return { cpu_seconds: ticks.length === 0 ? 0 : Number(cpu(from, Math.max(from, last)).toFixed(3)), wall_ms: 0, full: true };
  }
  const whole: CpuWindow = { cpu_seconds: Number(cpu(from, last).toFixed(3)), wall_ms: ticks[last]!.t - ticks[from]!.t, full: true };
  let best: CpuWindow | null = null;
  let j = from;
  for (let i = from; i < last; i++) {
    if (j < i) j = i;
    while (j < last && ticks[j]!.t - ticks[i]!.t < targetMs) j += 1;
    const wall = ticks[j]!.t - ticks[i]!.t;
    if (wall < targetMs) break; // no later i can reach the target either
    const c = cpu(i, j);
    if (best === null || c / wall > best.cpu_seconds / best.wall_ms) best = { cpu_seconds: Number(c.toFixed(3)), wall_ms: wall, full: false };
  }
  return best ?? whole;
};

/* ------------------------------ validation ----------------------------- */

/**
 * Check a harness report carries the block that makes it a measurement (Testing Decisions: "every
 * tier-1/tier-2 report validates against a schema that requires the `resources` block").
 *
 * Hand-rolled rather than an `effect/Schema`: this package is deliberately framework-free plain
 * `tsx` scripts, and the only thing worth asserting is that the block exists and is not silently
 * empty. A report written without one is worse than no report — it looks like a measurement and
 * is not, and the next phase would cite it.
 *
 * Returns the problems; empty means valid.
 */
export const validateReport = (report: unknown): string[] => {
  const problems: string[] = [];
  const r = report as { resources?: unknown; per_core?: unknown } | null;
  if (r === null || typeof r !== "object") return ["report is not an object"];
  const res = r.resources as Partial<ResourceReport> | undefined;
  if (res === undefined || typeof res !== "object" || res === null) return ["report has no `resources` block"];
  for (const key of ["platform", "vcpus", "interval_ms", "samples", "wall_ms", "load_wall_ms"] as const) {
    if (typeof res[key] !== (key === "platform" ? "string" : "number")) problems.push(`resources.${key} is missing or the wrong type`);
  }
  if (!Array.isArray(res.roles)) problems.push("resources.roles is missing");
  if (res.totals === undefined) problems.push("resources.totals is missing");
  if (res.subsets === undefined) problems.push("resources.subsets is missing");
  if (res.steady_state === undefined) problems.push("resources.steady_state is missing");
  // Zero samples is a legitimate outcome (a platform with no sampler), but it must be declared in
  // `notes` rather than left to be read as "the tree used nothing".
  if (res.samples === 0 && !(Array.isArray(res.notes) ? res.notes : []).some((n) => String(n).includes("no samples"))) {
    problems.push("resources.samples is 0 but no note says the run was not measured");
  }
  if (r.per_core === undefined) problems.push("report has no `per_core` block");
  return problems;
};

/* ------------------------------- printing ------------------------------ */

const mb = (bytes: number): string => `${Math.round(bytes / 1e6)}`;

export const formatResourceReport = (report: ResourceReport, budget?: PerCoreBudget): string => {
  const lines: string[] = [];
  if (report.samples === 0) {
    lines.push(`  resources             not measured${report.notes.length ? ` (${report.notes[0]!})` : ""}`);
    return lines.join("\n");
  }
  lines.push(`  resources             ${report.samples} samples @ ${report.interval_ms}ms, ${report.vcpus} vCPU, ${report.unclassified_pids} unclassified node pid(s)`);
  lines.push(`    role                idle MB   peak MB   peak priv MB   CPU s`);
  for (const r of report.roles) {
    lines.push(
      `    ${r.role.padEnd(18)}${mb(r.idle_rss_bytes).padStart(7)}${mb(r.peak_rss_bytes).padStart(10)}${mb(r.peak_private_bytes).padStart(15)}${r.cpu_seconds.toFixed(1).padStart(8)}`,
    );
  }
  lines.push(
    `    ${"TOTAL".padEnd(18)}${mb(report.totals.idle_rss_bytes).padStart(7)}${mb(report.totals.peak_rss_bytes).padStart(10)}${mb(report.totals.peak_private_bytes).padStart(15)}${report.totals.cpu_seconds.toFixed(1).padStart(8)}`,
  );
  if (report.rss_slope_mb_per_min !== null) lines.push(`    slope MB/min        rss ${report.rss_slope_mb_per_min}, private ${report.private_slope_mb_per_min ?? "n/a"}`);
  for (const c of report.containers) {
    lines.push(`    container ${c.name.padEnd(26)} peak ${mb(c.peak_mem_bytes)} MB, cpu peak ${c.peak_cpu_percent}% mean ${c.mean_cpu_percent}%`);
  }
  lines.push(`    host free MB        ${mb(report.host.free_mem_bytes_start)} at start -> ${mb(report.host.free_mem_bytes_end)} at end (of ${mb(report.host.total_mem_bytes)})`);
  if (budget) {
    lines.push(
      `    per-core (${budget.basis})  cores used ${budget.cores_used ?? "n/a"}${budget.cores_over_full_window ? " (whole window; run shorter than a steady-state minute)" : ""}` +
        `${budget.calls_per_vcpu === null ? "" : `, calls/vCPU ${budget.calls_per_vcpu}`}` +
        `${budget.mb_per_call === null ? "" : `, MB/call ${budget.mb_per_call} rss`}` +
        `${budget.mb_per_call_private === null ? "" : ` / ${budget.mb_per_call_private} private`}` +
        `${budget.turns_per_s_per_core === null ? "" : `, turns/s/core ${budget.turns_per_s_per_core}`}` +
        `${budget.cpu_seconds_per_turn === null ? "" : `, CPU s/turn ${budget.cpu_seconds_per_turn}`}` +
        `${budget.cpu_seconds_per_call_minute === null ? "" : `, CPU s/call-min ${budget.cpu_seconds_per_call_minute}`}`,
    );
  }
  for (const n of report.notes) lines.push(`    note: ${n}`);
  return lines.join("\n");
};
