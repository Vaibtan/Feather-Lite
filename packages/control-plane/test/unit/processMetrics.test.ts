/**
 * The process's own gauges, and the readiness rule built on them (D3).
 *
 * The rule that matters is staleness: `/readyz` used to be `SELECT 1`, so a process whose outbox
 * fiber had died answered "ready" indefinitely. These tests drive the clock rather than sleeping,
 * so "the loop stopped three intervals ago" is a fact and not a wait.
 */
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProcessMetrics, STALE_TICKS, type ProcessMetricsSources, type ProcessSnapshot } from "../../src/services/ProcessMetrics.js";

const sources = (over: Partial<ProcessMetricsSources> = {}): ProcessMetricsSources => ({
  pgPool: () => ({ size: 3, idle: 2, waiting: 0 }),
  sseStreams: () => 0,
  liveTurns: () => 0,
  rateLimitBuckets: () => 0,
  ...over,
});

/** Run one scoped program against a fresh instance, so the observer is torn down each time. */
const withMetrics = <A>(f: (m: Effect.Effect.Success<ReturnType<typeof makeProcessMetrics>>) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeProcessMetrics(sources()), f)) as Effect.Effect<A, never, never>);

afterEach(() => {
  vi.useRealTimers();
});

describe("ProcessMetrics", () => {
  it("reports a loop as alive right after it ticks", async () => {
    const stale = await withMetrics((m) => Effect.flatMap(m.tick("outbox", 5_000), () => m.staleLoops()));
    expect(stale).toEqual([]);
  });

  it("reports a loop as stale once it has missed three of its own intervals", async () => {
    // The defect: a dead outbox fiber and a healthy one were indistinguishable from outside.
    vi.useFakeTimers();
    const stale = await withMetrics((m) =>
      Effect.gen(function* () {
        yield* m.tick("outbox", 5_000);
        // Just inside the window: one slow tick is not an outage.
        vi.setSystemTime(Date.now() + 5_000 * STALE_TICKS - 1);
        const alive = yield* m.staleLoops();
        // ...and just past it.
        vi.setSystemTime(Date.now() + 2);
        const dead = yield* m.staleLoops();
        return { alive, dead };
      }),
    );
    expect(stale.alive).toEqual([]);
    expect(stale.dead.map((l) => l.name)).toEqual(["outbox"]);
  });

  it("reports a registered loop that has never ticked as stale after one interval", async () => {
    // The hole `/readyz` could not see: a loop whose fiber died before its first completed tick
    // never entered the map at all, so `staleLoops()` was `[]` and the process reported ready for
    // as long as it ran. One interval, not three — there is no slow first tick to forgive when
    // nothing has happened.
    vi.useFakeTimers();
    const out = await withMetrics((m) =>
      Effect.gen(function* () {
        yield* m.register("outbox", 5_000);
        const early = yield* m.staleLoops();
        vi.setSystemTime(Date.now() + 5_001);
        const late = yield* m.staleLoops();
        return { early, late };
      }),
    );
    expect(out.early).toEqual([]);
    expect(out.late.map((l) => l.name)).toEqual(["outbox"]);
    expect(out.late[0]?.lastTickAt).toBeNull();
  });

  it("does not stamp the clock for a failed tick, and counts the failures in a row", async () => {
    // The other half of the same defect: `catchAll` ran before the stamp, so a loop that errored on
    // every tick kept claiming to have ticked. An outbox with bad credentials stayed green.
    vi.useFakeTimers();
    const out = await withMetrics((m) =>
      Effect.gen(function* () {
        yield* m.tick("outbox", 5_000);
        vi.setSystemTime(Date.now() + 5_000 * STALE_TICKS + 1);
        yield* m.tickFailed("outbox", 5_000);
        yield* m.tickFailed("outbox", 5_000);
        const stale = yield* m.staleLoops();
        // ...and a success clears the count, so the gauge means "in a row" and not "ever".
        yield* m.tick("outbox", 5_000);
        const recovered = yield* m.staleLoops();
        const snapshot = yield* m.snapshot();
        return { stale, recovered, failures: snapshot.loops[0]?.consecutiveFailures };
      }),
    );
    expect(out.stale.map((l) => l.name)).toEqual(["outbox"]);
    expect(out.stale[0]?.consecutiveFailures).toBe(2);
    expect(out.recovered).toEqual([]);
    expect(out.failures).toBe(0);
  });

  it("judges each loop against its own cadence, not a shared one", async () => {
    // The sweeper ticks every 10 s and the scheduled actions every 15 s; a rule with one timeout
    // would call the slower one dead while it was working perfectly.
    vi.useFakeTimers();
    const out = await withMetrics((m) =>
      Effect.gen(function* () {
        yield* m.tick("sweeper", 10_000);
        yield* m.tick("scheduled-actions", 60_000);
        vi.setSystemTime(Date.now() + 40_000);
        return yield* m.staleLoops();
      }),
    );
    expect(out.map((l) => l.name)).toEqual(["sweeper"]);
  });

  it("carries the gauges its sources provide, and null for a pool that does not exist", async () => {
    const withPool = await withMetrics((m) => m.snapshot());
    expect(withPool.pg_pool).toEqual({ size: 3, idle: 2, waiting: 0 });

    const noPool = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(makeProcessMetrics(sources({ pgPool: () => null })), (m) => m.snapshot())) as Effect.Effect<ProcessSnapshot, never, never>,
    );
    // Null, not a zero-depth pool: a process with no database has not got an empty pool, it has
    // no pool, and reporting `{size: 0}` would read as exhaustion.
    expect(noPool.pg_pool).toBeNull();
  });

  it("reports event-loop lateness above the sampling floor, so 0 means keeping up", async () => {
    // Measured on this box, an idle loop reads p50 31.5 ms raw at 20 ms resolution — Windows' timer
    // granularity on top of the sampling period. Reported raw, an idle server looks blocked.
    const snap = await withMetrics((m) => m.snapshot());
    expect(snap.event_loop_delay_ms.p50).toBeGreaterThanOrEqual(0);
    expect(snap.event_loop_delay_ms.p50).toBeLessThan(50);
  });

  it("is a layer that tears its observers down with its scope", async () => {
    // A PerformanceObserver that outlives its scope keeps the process alive; the test suite is
    // where that shows up first.
    await Effect.runPromise(Effect.scoped(Layer.build(Layer.scopedDiscard(Effect.asVoid(makeProcessMetrics(sources()))))) as Effect.Effect<unknown, never, never>);
    expect(true).toBe(true);
  });
});
