/**
 * `collectDefaultMetrics()` is deliberately not called: it installs its own event-loop-delay
 * histogram and GC observer, so the process would publish two disagreeing answers for loop lag.
 */
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { ProcessSnapshot } from "../services/ProcessMetrics.js";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface ExpositionInput {
  readonly process: ProcessSnapshot;
  readonly counters: Readonly<Record<string, number>>;
  readonly service: string;
  readonly version: string;
}

const COUNTER_FAMILY = "feather_lite_counter_total";

export const prometheusText = async (input: ExpositionInput): Promise<string> => {
  const registry = new Registry();
  const registers = [registry];
  const p = input.process;

  const gauge = (name: string, help: string, value: number, labelNames?: ReadonlyArray<string>, labels?: Record<string, string>) => {
    const g = new Gauge({ name, help, registers, ...(labelNames ? { labelNames: [...labelNames] } : {}) });
    if (labels) g.set(labels, value);
    else g.set(value);
    return g;
  };

  new Gauge({ name: "feather_lite_build_info", help: "Always 1; the labels carry the build.", labelNames: ["service", "version", "node_version"], registers }).set(
    { service: input.service, version: input.version, node_version: process.versions.node },
    1,
  );

  const cpu = new Counter({ name: "process_cpu_seconds_total", help: "Total user and system CPU time spent in seconds.", labelNames: ["mode"], registers });
  cpu.inc({ mode: "user" }, p.cpu_seconds.user);
  cpu.inc({ mode: "system" }, p.cpu_seconds.system);
  gauge("process_resident_memory_bytes", "Resident memory size in bytes.", p.memory_bytes.rss);
  gauge("feather_lite_process_uptime_seconds", "Seconds since this process started.", p.uptime_seconds);

  gauge("nodejs_heap_size_used_bytes", "Process heap space used, in bytes.", p.memory_bytes.heap_used);
  gauge("nodejs_heap_size_total_bytes", "Process heap space allocated, in bytes.", p.memory_bytes.heap_total);
  gauge("nodejs_external_memory_bytes", "Memory used by C++ objects bound to JavaScript, in bytes.", p.memory_bytes.external);

  const gcPause = new Counter({ name: "nodejs_gc_pause_seconds_total", help: "Cumulative time this process has spent paused for garbage collection.", registers });
  gcPause.inc(p.gc.total_pause_ms / 1000);
  const gcRuns = new Counter({ name: "nodejs_gc_collections_total", help: "Number of garbage collections observed.", registers });
  gcRuns.inc(p.gc.collections);

  const lag = new Gauge({ name: "feather_lite_event_loop_delay_seconds", help: "Event-loop lateness beyond the 20 ms sampling period.", labelNames: ["quantile"], registers });
  lag.set({ quantile: "0.5" }, p.event_loop_delay_ms.p50 / 1000);
  lag.set({ quantile: "0.99" }, p.event_loop_delay_ms.p99 / 1000);
  lag.set({ quantile: "max" }, p.event_loop_delay_ms.max / 1000);

  // Absent entirely without a database rather than published as an empty pool: a scraper reading
  // `waiting=0` from a process that never had one would conclude the pool is healthy.
  if (p.pg_pool !== null) {
    const pool = new Gauge({ name: "feather_lite_pg_pool_connections", help: "Postgres pool depth by state.", labelNames: ["state"], registers });
    pool.set({ state: "total" }, p.pg_pool.size);
    pool.set({ state: "idle" }, p.pg_pool.idle);
    pool.set({ state: "waiting" }, p.pg_pool.waiting);
  }

  const loopAge = new Gauge({ name: "feather_lite_loop_last_tick_age_seconds", help: "Seconds since a background loop last completed a tick.", labelNames: ["loop"], registers });
  const loopStale = new Gauge({ name: "feather_lite_loop_stale", help: "1 when a background loop has missed three of its own intervals.", labelNames: ["loop"], registers });
  const loopFailures = new Gauge({ name: "feather_lite_loop_consecutive_failures", help: "Ticks a background loop has failed in a row since its last success.", labelNames: ["loop"], registers });
  const now = Date.now();
  for (const l of p.loops) {
    if (l.lastTickAt !== null) loopAge.set({ loop: l.name }, Math.max(0, Math.round((now - Date.parse(l.lastTickAt)) / 10) / 100));
    loopStale.set({ loop: l.name }, l.stale ? 1 : 0);
    loopFailures.set({ loop: l.name }, l.consecutiveFailures);
  }

  gauge("feather_lite_sse_streams", "Open server-sent-event turn streams.", p.sse_streams);
  gauge("feather_lite_live_turns", "Turns held in the TurnRunner retention map.", p.live_turns);
  gauge("feather_lite_rate_limit_buckets", "Per-IP rate-limit buckets currently held.", p.rate_limit_buckets);

  const appCounters = new Counter({ name: COUNTER_FAMILY, help: "In-process counters, reset on restart. The name label is the counter's own name.", labelNames: ["name"], registers });
  for (const [name, value] of Object.entries(input.counters)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) appCounters.inc({ name }, value);
  }

  return registry.metrics();
};
