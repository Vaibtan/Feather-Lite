import { Effect, Layer } from "effect";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { cpuUsage, memoryUsage } from "node:process";

export interface LoopLiveness {
  readonly name: string;
  readonly lastTickAt: string | null;
  readonly intervalMs: number;
  readonly stale: boolean;
  readonly consecutiveFailures: number;
}

export interface ProcessSnapshot {
  readonly uptime_seconds: number;
  readonly cpu_seconds: { readonly user: number; readonly system: number };
  readonly event_loop_delay_ms: { readonly p50: number; readonly p99: number; readonly max: number };
  readonly memory_bytes: { readonly rss: number; readonly heap_used: number; readonly heap_total: number; readonly external: number };
  readonly gc: { readonly total_pause_ms: number; readonly collections: number };
  readonly pg_pool: { readonly size: number; readonly idle: number; readonly waiting: number } | null;
  readonly loops: ReadonlyArray<LoopLiveness>;
  readonly sse_streams: number;
  readonly live_turns: number;
  readonly rate_limit_buckets: number;
}

export interface ProcessMetricsSources {
  readonly pgPool: () => { readonly size: number; readonly idle: number; readonly waiting: number } | null;
  readonly sseStreams: () => number;
  readonly liveTurns: () => number;
  readonly rateLimitBuckets: () => number;
}

export class ProcessMetrics extends Effect.Tag("@feather-lite/ProcessMetrics")<
  ProcessMetrics,
  {
    // Must be called before the loop's fiber is forked: a loop that dies before its first tick
    // would otherwise never enter the map, and `staleLoops()` would report nothing wrong.
    readonly register: (loop: string, intervalMs: number) => Effect.Effect<void>;
    readonly tick: (loop: string, intervalMs: number) => Effect.Effect<void>;
    readonly tickFailed: (loop: string, intervalMs: number) => Effect.Effect<void>;
    readonly snapshot: () => Effect.Effect<ProcessSnapshot>;
    readonly staleLoops: () => Effect.Effect<ReadonlyArray<LoopLiveness>>;
    // Declared rather than inferred, because only the composition root knows which loops this
    // process should run; "no loops are late" and "there are no loops" are opposite facts.
    readonly expectLoops: (names: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly missingLoops: () => Effect.Effect<ReadonlyArray<string>>;
  }
>() {}

export const STALE_TICKS = 3;

export const makeProcessMetrics = (sources: ProcessMetricsSources) =>
  Effect.gen(function* () {
    const startedAt = Date.now();

    // `monitorEventLoopDelay` is sampled by libuv itself; a `setTimeout` measuring its own lateness
    // would compete with the work it is trying to measure.
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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        gcObserver.disconnect();
        loopDelay.disable();
      }),
    );

    interface Tick {
      at: number | null;
      readonly since: number;
      intervalMs: number;
      failures: number;
    }
    const ticks = new Map<string, Tick>();
    const expected = new Set<string>();
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
      expectLoops: (names: ReadonlyArray<string>) =>
        Effect.sync(() => {
          for (const n of names) expected.add(n);
        }),
      missingLoops: () => Effect.sync(() => [...expected].filter((n) => !ticks.has(n))),
      snapshot: () =>
        Effect.sync(() => {
          const mem = memoryUsage();
          const cpu = cpuUsage();
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
