/**
 * The `/metrics` body (D3). What is under test is the *contract with a scraper*: the names a
 * dashboard or alert will be written against, and that a counter whose name a Prometheus metric
 * name cannot legally hold still arrives intact.
 *
 * There is no assertion here that the numbers are right — they come verbatim from the same
 * `ProcessSnapshot` `/status` serves, which `processMetrics.test.ts` covers. What this file exists
 * to catch is a rename, a dropped series, and the one thing the type checker cannot see: a counter
 * name with a dot in it silently colliding with another vendor's.
 */
import { describe, expect, it } from "vitest";
import { PROMETHEUS_CONTENT_TYPE, prometheusText } from "../../src/http/prometheus.js";
import type { ProcessSnapshot } from "../../src/services/ProcessMetrics.js";

const snapshot = (over: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  uptime_seconds: 120,
  cpu_seconds: { user: 3.5, system: 1.25 },
  event_loop_delay_ms: { p50: 0, p99: 12.5, max: 200 },
  memory_bytes: { rss: 168_000_000, heap_used: 40_000_000, heap_total: 60_000_000, external: 2_000_000 },
  gc: { total_pause_ms: 30, collections: 7 },
  pg_pool: { size: 10, idle: 8, waiting: 0 },
  loops: [{ name: "outbox", lastTickAt: new Date(Date.now() - 4_000).toISOString(), intervalMs: 5_000, stale: false, consecutiveFailures: 0 }],
  sse_streams: 2,
  live_turns: 5,
  rate_limit_buckets: 3,
  ...over,
});

const render = (over: Partial<ProcessSnapshot> = {}, counters: Record<string, number> = {}) =>
  prometheusText({ process: snapshot(over), counters, service: "feather-lite-server", version: "2.0.0" });

describe("prometheus exposition", () => {
  it("is the content type a scraper parses", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("publishes the process series under the names an alert would be written against", async () => {
    const text = await render();
    for (const name of [
      "feather_lite_build_info",
      "process_cpu_seconds_total",
      "process_resident_memory_bytes",
      "feather_lite_process_uptime_seconds",
      "nodejs_heap_size_used_bytes",
      "nodejs_gc_pause_seconds_total",
      "feather_lite_event_loop_delay_seconds",
      "feather_lite_pg_pool_connections",
      "feather_lite_loop_last_tick_age_seconds",
      "feather_lite_loop_stale",
      "feather_lite_sse_streams",
      "feather_lite_live_turns",
      "feather_lite_rate_limit_buckets",
      "feather_lite_counter_total",
    ]) {
      expect(text, `missing ${name}`).toContain(`# TYPE ${name} `);
    }
  });

  it("carries the values from the snapshot, in Prometheus' base units", async () => {
    const text = await render();
    expect(text).toContain('process_cpu_seconds_total{mode="user"} 3.5');
    expect(text).toContain('process_cpu_seconds_total{mode="system"} 1.25');
    expect(text).toContain("process_resident_memory_bytes 168000000");
    // Milliseconds on the JSON surface, seconds here: the exposition format's convention, and a
    // dashboard that assumed seconds would otherwise read a 12 ms blip as three hours.
    expect(text).toContain('feather_lite_event_loop_delay_seconds{quantile="0.99"} 0.0125');
    expect(text).toContain("nodejs_gc_pause_seconds_total 0.03");
  });

  it("keeps a counter name a metric name could not hold, rather than mangling it into a collision", async () => {
    // Both would sanitise to `provider_deepgram_STT_error`. As label values they stay two series.
    const text = await render({}, { "provider_deepgram.STT_error": 2, "provider_deepgram_STT_error": 9, rate_limited_turn: 4 });
    expect(text).toContain('feather_lite_counter_total{name="provider_deepgram.STT_error"} 2');
    expect(text).toContain('feather_lite_counter_total{name="provider_deepgram_STT_error"} 9');
    expect(text).toContain('feather_lite_counter_total{name="rate_limited_turn"} 4');
  });

  it("omits the pool entirely in a process that has none, rather than publishing a healthy empty one", async () => {
    const text = await render({ pg_pool: null });
    expect(text).not.toContain("feather_lite_pg_pool_connections");
  });

  it("reports a stopped loop as stale, which is the same verdict /readyz reaches", async () => {
    const text = await render({ loops: [{ name: "outbox", lastTickAt: new Date(Date.now() - 60_000).toISOString(), intervalMs: 5_000, stale: true, consecutiveFailures: 0 }] });
    expect(text).toContain('feather_lite_loop_stale{loop="outbox"} 1');
    expect(text).toMatch(/feather_lite_loop_last_tick_age_seconds\{loop="outbox"} 6\d(\.\d+)?/);
  });

  it("separates a loop that is failing from one that has stopped", async () => {
    // A loop erroring on every tick used to be indistinguishable from a healthy one, because the
    // stamp was written on the error path too. Fresh age, non-zero failures: alive and failing.
    const text = await render({ loops: [{ name: "outbox", lastTickAt: new Date(Date.now() - 1_000).toISOString(), intervalMs: 5_000, stale: false, consecutiveFailures: 4 }] });
    expect(text).toContain('feather_lite_loop_consecutive_failures{loop="outbox"} 4');
    expect(text).toContain('feather_lite_loop_stale{loop="outbox"} 0');
  });

  it("registers the counter family even with nothing counted yet, so an absent series is not read as a zero", async () => {
    const text = await render();
    expect(text).toContain("# TYPE feather_lite_counter_total counter");
  });
});
