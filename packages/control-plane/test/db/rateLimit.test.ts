import { Effect, Exit, Layer, Redacted, Scope } from "effect";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { afterAll, describe, expect, it } from "vitest";
import { AppConfigTest, ApiLive, LiveKitMediaPlaneLive, Metrics, ProcessMetricsLive, ScriptedTurnDeciderLive, securityMiddleware, ServicesLive } from "../../src/index.js";
import { makeInfraLayer } from "./harness.js";

const BYPASS = "bypass-secret-for-the-harness";
// One request per minute, so the second is over budget and the arithmetic is not what is tested.
const budget = { rateLimitPerMinute: 1, rateLimitBypassToken: Redacted.make(BYPASS) };

const scope = Effect.runSync(Scope.make());

// `toWebHandler`'s middleware slot takes an app with no requirements of its own, so `securityMiddleware`'s `AppConfig` and `Metrics` are supplied here from a context built with the same config.
const middlewareContext = Effect.runSync(Scope.extend(Layer.build(Layer.mergeAll(AppConfigTest(budget), Metrics.Default)), scope));

const web = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
    Layer.provide(ProcessMetricsLive({ pgPool: () => null, sseStreams: () => 0, liveTurns: () => 0, rateLimitBuckets: () => 0 })),
    Layer.provideMerge(ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive))),
    Layer.provideMerge(makeInfraLayer(budget)),
  ),
  { middleware: (app) => securityMiddleware(app).pipe(Effect.provide(middlewareContext)) },
);

// The body is deliberately not a valid call: the middleware answers first.
const start = (headers: Record<string, string> = {}) =>
  web.handler(new Request("http://localhost/api/calls/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));

afterAll(async () => {
  await web.dispose();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("the per-IP request budget", () => {
  it("exempts a caller with the bypass token, and sheds one without it", async () => {
    // The limiter is a process-wide singleton keyed by client address, so both phases run in one test, bypassed first: they must not consume the budget the second phase exhausts.
    const bypassed: number[] = [];
    for (let i = 0; i < 5; i++) bypassed.push((await start({ "x-ratelimit-bypass": BYPASS })).status);
    expect(bypassed.filter((s) => s === 429)).toEqual([]);

    const first = await start();
    expect(first.status).not.toBe(429);
    expect((await start()).status).toBe(429);

    expect((await start({ "x-ratelimit-bypass": "not-the-secret" })).status).toBe(429);
    // `RATE_LIMIT_BYPASS_TOKEN=` in a `.env` reads as `Some("")`, which compared against the empty-string fallback for a missing header would exempt every request on the box.
    expect((await start({ "x-ratelimit-bypass": "" })).status).toBe(429);
  });
});
