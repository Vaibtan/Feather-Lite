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

// The decider is provided *into* the services, not merged beside them, or the orchestrator cannot see it.
const infra = ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive), Layer.provideMerge(makeInfraLayer()));

interface Readyz {
  readonly metrics: Effect.Effect.Success<ReturnType<typeof makeProcessMetrics>>;
  readonly call: () => Promise<Response>;
}

// Each case gets its own ProcessMetrics and handler: the verdict is over all loops, and each ProcessMetrics holds a PerformanceObserver that has to be closed rather than accumulated.
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

  it("fails when the registry is empty, because no loops registered is not the same as no loops late", async () =>
    withReadyz(async ({ metrics, call }) => {
      await Effect.runPromise(metrics.expectLoops(["outbox", "sweeper"]));
      await Effect.runPromise(metrics.tick("outbox", 5_000));
      const res = await call();
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).toContain("never started: sweeper");
    }));

  it("fails for a loop that was registered and never ticked", async () =>
    withReadyz(async ({ metrics, call }) => {
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
      expect(JSON.stringify(await res.json())).toContain("3 consecutive failures");
    }));

  it("stays ready through a drain that runs longer than its own staleness window", async () =>
    // Six batches at 400 ms is 2.4 s of work against a 1.5 s staleness window: survivable only because each batch reports.
    withReadyz(async ({ metrics, call }) => {
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
