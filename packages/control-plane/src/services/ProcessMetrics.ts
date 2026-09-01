/**
 * What the server process is doing to itself (spec D3).
 *
 * Everything else in this system measures the *call*: how fast a turn was, whether the ledger
 * replayed, what a vendor did. Nothing measured the process serving them, so the two questions an
 * operator asks when a call goes slow — "is the box busy?" and "is the event loop blocked?" — had
 * no answer here at all. The audit's finding was blunt: no process metrics anywhere.
 *
 * Sampled rather than computed on request. An event-loop delay histogram is a running measurement,
 * not something a handler can ask for, and taking RSS on every `/status` poll would make the page
 * the thing perturbing the number.
 *
 * No new vendor. `perf_hooks` ships with Node, and the values land on `/status` and `/metrics`
 * beside the counters that were already there.
 */
import { Effect, Layer } from "effect";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { cpuUsage, memoryUsage } from "node:process";

/** A scheduler loop that is expected to tick, and when it last did. */
export interface LoopLiveness {
  readonly name: string;
  /** `null` when the loop has been registered but has never *completed* a tick. */
  readonly lastTickAt: string | null;
  /** How often it is expected to tick, so staleness is judged against its own cadence. */
  readonly intervalMs: number;
  readonly stale: boolean;
  /**
   * Ticks that have failed in a row since the last success.
   *
   * A loop erroring on every tick is not the same failure as a loop whose fiber has died, and the
   * two used to be indistinguishable from outside — both showed as "not ticking". This separates
   * them: a rising count with a fresh `lastTickAt` is a loop that is alive and failing.
   */
  readonly consecutiveFailures: number;
}

export interface ProcessSnapshot {
  readonly uptime_seconds: number;
  /**
   * CPU this process has burned since it started, split the way the OS accounts for it.
   *
   * The one number the per-core budget (D1) needs from the server and could only get from outside
   * it: the load harness was reading it out of `Get-Process` through a child `powershell`, which
   * measures whichever process the harness guessed was the server. A process that reports its own
   * CPU cannot be confused with its launcher.
   */
  readonly cpu_seconds: { readonly user: number; readonly system: number };
  /** Lateness *beyond* the sampling period: 0 means the loop is keeping up. See `ms` below. */
  readonly event_loop_delay_ms: { readonly p50: number; readonly p99: number; readonly max: number };
  readonly memory_bytes: { readonly rss: number; readonly heap_used: number; readonly heap_total: number; readonly external: number };
  /** Cumulative time this process has spent in garbage collection, and how many pauses. */
  readonly gc: { readonly total_pause_ms: number; readonly collections: number };
  readonly pg_pool: { readonly size: number; readonly idle: number; readonly waiting: number } | null;
  readonly loops: ReadonlyArray<LoopLiveness>;
  readonly sse_streams: number;
  readonly live_turns: number;
  readonly rate_limit_buckets: number;
}

/** Where a gauge's value comes from. Wired at layer construction so this module owns no state but its own. */
export interface ProcessMetricsSources {
  readonly pgPool: () => { readonly size: number; readonly idle: number; readonly waiting: number } | null;
  readonly sseStreams: () => number;
  readonly liveTurns: () => number;
  readonly rateLimitBuckets: () => number;
}

export class ProcessMetrics extends Effect.Tag("@feather-lite/ProcessMetrics")<
  ProcessMetrics,
  {
    /**
     * Declare that a loop is expected to tick, before its fiber is forked.
     *
     * Without this a loop that dies before completing its first tick — an outbox with bad
     * credentials, a scheduler whose first claim throws — never entered the map at all, so
     * `staleLoops()` was `[]` and `/readyz` reported `loops: []` and "ready" for the life of the
     * process. Registration makes "expected but never seen" a state that can be reported, and a
     * registered loop with no tick is stale after **one** of its own intervals: there is no slow
     * first tick to be forgiving of when nothing has happened at all.
     */
    readonly register: (loop: string, intervalMs: number) => Effect.Effect<void>;
    /** Record that a named loop just completed a tick. Cheap enough to call on every iteration. */
    readonly tick: (loop: string, intervalMs: number) => Effect.Effect<void>;
    /** Record that a tick errored. Does **not** stamp the clock — a failing loop is not a live one. */
    readonly tickFailed: (loop: string, intervalMs: number) => Effect.Effect<void>;
    readonly snapshot: () => Effect.Effect<ProcessSnapshot>;
    /**
     * Are the background loops alive? A loop that has not ticked in three of its own intervals has
     * stopped, and a process whose outbox has stopped is not ready however well it answers HTTP.
     */
    readonly staleLoops: () => Effect.Effect<ReadonlyArray<LoopLiveness>>;
  }
>() {}

/** How many intervals a loop may miss before it counts as stopped. Three, so one slow tick is not an outage. */
export const STALE_TICKS = 3;

export const makeProcessMetrics = (sources: ProcessMetricsSources) =>
  Effect.gen(function* () {
    const startedAt = Date.now();

    /**
     * `monitorEventLoopDelay` is a native histogram sampled by libuv itself, not a `setTimeout`
     * measuring its own lateness — the latter competes with the work it is trying to measure.
     * Resolution 20 ms: fine enough to see a blocked loop, coarse enough not to be a cost.
     */
    const LOOP_RESOLUTION_MS = 20;
    const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    loopDelay.enable();

    const gc = { totalPauseMs: 0, collections: 0 };
    const gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gc.totalPauseMs += entry.duration;
        gc.collections += 1;
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    // Torn down with the layer: an observer outliving its scope keeps the process alive in tests.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        gcObserver.disconnect();
        loopDelay.disable();
      }),
    );

    /** `at` is null until the loop has completed a tick; `since` is when it was registered. */
    interface Tick {
      at: number | null;
      readonly since: number;
      intervalMs: number;
      failures: number;
    }
    const ticks = new Map<string, Tick>();
    /** The loop's row, created on first sight so a `tick` from an unregistered loop is not lost. */
    const rowFor = (loop: string, intervalMs: number): Tick => {
      const existing = ticks.get(loop);
      if (existing) {
        existing.intervalMs = intervalMs;
        return existing;
      }
      const fresh: Tick = { at: null, since: Date.now(), intervalMs, failures: 0 };
      ticks.set(loop, fresh);
      return fresh;
    };

    const loops = (): ReadonlyArray<LoopLiveness> => {
      const now = Date.now();
      return [...ticks].map(([name, t]) => ({
        name,
        lastTickAt: t.at === null ? null : new Date(t.at).toISOString(),
        intervalMs: t.intervalMs,
        /**
         * One interval for a loop that has never ticked, three for one that has. There is no slow
         * first tick to forgive when nothing has completed at all, and a loop whose fiber died on
         * its first iteration is precisely the case `/readyz` could not see.
         */
        stale: t.at === null ? now - t.since > t.intervalMs : now - t.at > t.intervalMs * STALE_TICKS,
        consecutiveFailures: t.failures,
      }));
    };

    return {
      register: (loop: string, intervalMs: number) => Effect.sync(() => void rowFor(loop, intervalMs)),
      tick: (loop: string, intervalMs: number) =>
        Effect.sync(() => {
          const row = rowFor(loop, intervalMs);
          row.at = Date.now();
          row.failures = 0;
        }),
      tickFailed: (loop: string, intervalMs: number) =>
        Effect.sync(() => {
          rowFor(loop, intervalMs).failures += 1;
        }),
      staleLoops: () => Effect.sync(() => loops().filter((l) => l.stale)),
      snapshot: () =>
        Effect.sync(() => {
          const mem = memoryUsage();
          // Microseconds since process start, both counters monotonic. Rounded to the millisecond:
          // more precision than that is noise from the accounting itself.
          const cpu = cpuUsage();
          /**
           * Nanoseconds to milliseconds, minus the sampling period.
           *
           * The histogram records the whole interval between scheduled and actual fire, so an
           * idle loop reads at least the resolution — measured on this box, p50 31.5 ms at rest,
           * because Windows' timer granularity (~15.6 ms) sits on top of the 20 ms period. An
           * operator reading "31 ms of event-loop delay" on an idle server concludes the loop is
           * blocked. Subtracting the floor makes **0 mean the loop is keeping up**, which is the
           * question being asked; anything above it is real lateness.
           */
          const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 100) / 100);
          return {
            uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
            cpu_seconds: { user: Math.round(cpu.user / 1000) / 1000, system: Math.round(cpu.system / 1000) / 1000 },
            event_loop_delay_ms: { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) },
            memory_bytes: { rss: mem.rss, heap_used: mem.heapUsed, heap_total: mem.heapTotal, external: mem.external },
            gc: { total_pause_ms: Math.round(gc.totalPauseMs * 100) / 100, collections: gc.collections },
            pg_pool: sources.pgPool(),
            loops: loops(),
            sse_streams: sources.sseStreams(),
            live_turns: sources.liveTurns(),
            rate_limit_buckets: sources.rateLimitBuckets(),
          } satisfies ProcessSnapshot;
        }),
    };
  });

export const ProcessMetricsLive = (sources: ProcessMetricsSources): Layer.Layer<ProcessMetrics> =>
  Layer.scoped(ProcessMetrics, makeProcessMetrics(sources));
