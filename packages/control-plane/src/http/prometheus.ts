/**
 * `GET /metrics` — the same numbers `/api/system/status` reports, in the format a scraper reads
 * (spec D3).
 *
 * **One source, two renderings.** Every value here comes from the `ProcessSnapshot` and the
 * `Metrics` counters that the status page already serves; nothing is measured a second time. That
 * is deliberate and it is why `collectDefaultMetrics()` is not called: it installs its *own*
 * `monitorEventLoopDelay` histogram and its *own* GC `PerformanceObserver`, so this process would
 * carry two of each and publish two answers to "how late is the event loop" that disagree — the raw
 * lag under `nodejs_eventloop_lag_p99_seconds`, and the sampling-floor-subtracted one on `/status`.
 * A spec whose first finding was two percentile implementations disagreeing (O1) does not get to
 * ship that. The handful of standard series worth having from the default set — resident memory,
 * CPU seconds — are published from our own snapshot under their conventional names instead.
 *
 * **The registry is built per scrape.** The metric objects are pure formatting: they hold no state
 * between requests, every value is set from the snapshot as it is registered, and a scrape is a
 * once-every-15-seconds event. Building a fresh `Registry` costs microseconds and buys a module
 * with no global mutable state, which is also what makes it testable without a running server.
 *
 * The package is `@prometheus-io/client`, not `prom-client`: the latter is the same library under
 * its pre-donation name and npm now marks it deprecated in favour of this one.
 */
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { ProcessSnapshot } from "../services/ProcessMetrics.js";

/** What the endpoint must send as `Content-Type` for a scraper to parse the body. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface ExpositionInput {
  readonly process: ProcessSnapshot;
  /** The flat in-process counter map from `Metrics.snapshot()`. */
  readonly counters: Readonly<Record<string, number>>;
  readonly service: string;
  readonly version: string;
}

/**
 * Counter names in `Metrics` are free-form strings assembled at the call site
 * (`provider_deepgram.STT_error`), and a Prometheus metric name may not contain a dot. Sanitising
 * them into names would silently collide two different vendors onto one series, so the exact name
 * travels as a **label value** — where arbitrary UTF-8 is legal — on one family. A query reads
 * `feather_lite_counter_total{name="rate_limited_turn"}`, which is the same question with the same
 * answer and no lossy rewriting in between.
 */
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

  /**
   * Conventional names, our numbers. `process_cpu_seconds_total` is the denominator of the
   * per-core budget in D1 (`turns_per_s_per_core`), so it is the one series here an operator is
   * most likely to graph.
   */
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

  /**
   * Lateness beyond the sampling floor, as `/status` reports it — see `ProcessMetrics` for why the
   * floor is subtracted. `quantile` rather than three metric names, so a dashboard can plot the
   * spread as one series.
   */
  const lag = new Gauge({ name: "feather_lite_event_loop_delay_seconds", help: "Event-loop lateness beyond the 20 ms sampling period.", labelNames: ["quantile"], registers });
  lag.set({ quantile: "0.5" }, p.event_loop_delay_ms.p50 / 1000);
  lag.set({ quantile: "0.99" }, p.event_loop_delay_ms.p99 / 1000);
  lag.set({ quantile: "max" }, p.event_loop_delay_ms.max / 1000);

  /**
   * Absent entirely when this process has no database, rather than published as an empty pool: a
   * scraper reading `waiting=0` from a process that never had a pool would conclude the pool is
   * healthy.
   */
  if (p.pg_pool !== null) {
    const pool = new Gauge({ name: "feather_lite_pg_pool_connections", help: "Postgres pool depth by state.", labelNames: ["state"], registers });
    pool.set({ state: "total" }, p.pg_pool.size);
    pool.set({ state: "idle" }, p.pg_pool.idle);
    pool.set({ state: "waiting" }, p.pg_pool.waiting);
  }

  /**
   * The two series behind `/readyz`. Age rather than a timestamp, so an alert is
   * `feather_lite_loop_last_tick_age_seconds > 45` and needs no clock arithmetic; `stale` is the
   * verdict this process reached with the loop's own interval, which a scraper cannot recompute
   * because it does not know the cadence.
   */
  const loopAge = new Gauge({ name: "feather_lite_loop_last_tick_age_seconds", help: "Seconds since a background loop last completed a tick.", labelNames: ["loop"], registers });
  const loopStale = new Gauge({ name: "feather_lite_loop_stale", help: "1 when a background loop has missed three of its own intervals.", labelNames: ["loop"], registers });
  /**
   * The third: a loop that is alive and failing every tick reads fresh on `age` and non-zero here.
   * Before this it was indistinguishable from a healthy loop, because the stamp was written on the
   * error path too.
   */
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

  /**
   * Registered even when empty, so a scrape of a freshly started process returns the family with
   * its HELP line rather than nothing — an absent series and a zero one look identical in a graph
   * and mean different things.
   */
  const appCounters = new Counter({ name: COUNTER_FAMILY, help: "In-process counters, reset on restart. The name label is the counter's own name.", labelNames: ["name"], registers });
  for (const [name, value] of Object.entries(input.counters)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) appCounters.inc({ name }, value);
  }

  return registry.metrics();
};
