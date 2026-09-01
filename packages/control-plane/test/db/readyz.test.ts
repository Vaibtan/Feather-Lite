/**
 * `/readyz` against the real handler, because the three ways it could not fail were all invisible
 * to a unit test of `staleLoops()` (review #3, #9).
 *
 * Before this file the endpoint had **no** test at all. What it now pins:
 *
 *   1. a loop that died before completing its first tick used to never enter the map, so the
 *      endpoint answered `loops: []` and "ready" for the life of the process;
 *   2. a loop that errors on *every* tick used to keep stamping `last_tick_at`, because `catchAll`
 *      ran before the stamp — an outbox with bad credentials was indistinguishable from a healthy
 *      one;
 *   3. a *busy* outbox used to trip the endpoint, because the stamp was written only when a whole
 *      ten-batch drain finished and a single batch can wait tens of seconds on the judge. The
 *      signal fired hardest when the fiber was healthiest.
 *
 * Each case gets its own ProcessMetrics and its own handler, because the endpoint's verdict is over
 * *all* loops and a stale one left behind by an earlier case would decide the next. (A shared
 * `MemoMap` would be cheaper and is wrong here: it memoises `ApiLive` itself, so every case would
 * get the first case's loop registry back.)
 */
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { describe, expect, it } from "vitest";
import {
  ApiLive,
  LiveKitMediaPlaneLive,
  makeProcessMetrics,
  ProcessMetrics,
  ScriptedTurnDeciderLive,
  ServicesLive,
  type ProcessMetricsSources,
} from "../../src/index.js";
import { makeInfraLayer } from "./harness.js";

const sources: ProcessMetricsSources = {
  pgPool: () => null,
  sseStreams: () => 0,
  liveTurns: () => 0,
  rateLimitBuckets: () => 0,
};

// The same shape `apps/server/src/main.ts` composes: the decider is provided *into* the services,
// not merged beside them, or the orchestrator cannot see it.
const infra = ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive), Layer.provideMerge(makeInfraLayer()));

interface Readyz {
  readonly metrics: Effect.Effect.Success<ReturnType<typeof makeProcessMetrics>>;
  readonly call: () => Promise<Response>;
}

/**
 * One case: a fresh loop registry behind the real endpoint, torn down before the next.
 *
 * Each `ProcessMetrics` holds a `PerformanceObserver` and an event-loop histogram, so they are
 * closed per case rather than accumulated — the same one-runtime-per-scope discipline the other DB
 * tests get from `makeRuntime`/`dispose`.
 */
const withReadyz = async (body: (r: Readyz) => Promise<void>): Promise<void> => {
  const scope = await Effect.runPromise(Scope.make());
  const metrics = await Effect.runPromise(Scope.extend(makeProcessMetrics(sources), scope));
  const web = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(Layer.provide(Layer.succeed(ProcessMetrics, metrics)), Layer.provideMerge(infra)),
  );
  try {
    await body({ metrics, call: () => web.handler(new Request("http://localhost/readyz")) });
  } finally {
    await web.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

describe("/readyz", () => {
  it("is ready when every registered loop has ticked", async () =>
    withReadyz(async ({ metrics, call }) => {
      await Effect.runPromise(metrics.tick("outbox", 5_000));
      await Effect.runPromise(metrics.tick("sweeper", 10_000));
      const res = await call();
      expect(res.status).toBe(200);
      expect(((await res.json()) as { loops: string[] }).loops).toContain("outbox");
    }));

  it("fails for a loop that was registered and never ticked", async () =>
    withReadyz(async ({ metrics, call }) => {
      // The fiber died on its first iteration. It has an interval and no tick, and one interval is
      // long enough to say so: there is no slow first tick to be forgiving of.
      await Effect.runPromise(metrics.register("never-started", 1));
      await new Promise((r) => setTimeout(r, 20));
      const res = await call();
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).toContain("never-started (last never)");
    }));

  it("fails for a loop that errors on every tick, and says how many in a row", async () =>
    withReadyz(async ({ metrics, call }) => {
      await Effect.runPromise(metrics.tick("failing", 1));
      for (let i = 0; i < 3; i++) await Effect.runPromise(metrics.tickFailed("failing", 1));
      await new Promise((r) => setTimeout(r, 20));
      const res = await call();
      expect(res.status).toBe(503);
      // The stamp is not written on the error path any more, so the loop goes stale — and the count
      // says it is failing rather than simply gone.
      expect(JSON.stringify(await res.json())).toContain("3 consecutive failures");
    }));

  it("stays ready through a drain that runs longer than its own staleness window", async () =>
    withReadyz(async ({ metrics, call }) => {
      // A drain is up to ten batches and a single batch can wait tens of seconds on the judge. The
      // stamp used to be written only when the whole drain finished, so the *busier* the outbox was
      // the more likely `/readyz` was to call it dead. Six batches at 400 ms is 2.4 s of work
      // against a 1.5 s staleness window: it is only survivable because each batch reports.
      const INTERVAL_MS = 500;
      const verdicts: number[] = [];
      for (let batch = 0; batch < 6; batch++) {
        await new Promise((r) => setTimeout(r, 400));
        await Effect.runPromise(metrics.tick("long-drain", INTERVAL_MS));
        verdicts.push((await call()).status);
      }
      expect(verdicts).toEqual([200, 200, 200, 200, 200, 200]);
    }));
});
