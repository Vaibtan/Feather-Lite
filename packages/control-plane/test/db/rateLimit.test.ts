/**
 * The per-IP budget, and the one caller that must not be subject to it (O9, review §3).
 *
 * The middleware had no test at all, which is how "the harness is rate-limited by its own server"
 * survived: a tier-1 run was 429ed 92 times, reported "23/50 correct", and read like a regression
 * in the agent. The advice was to raise `RATE_LIMIT_PER_MINUTE` and `DAILY_TURN_CAP` in the server's
 * environment for the duration of a run — which measures a server configured differently from the
 * one being described, and moves the knob a public demo depends on.
 *
 * `RATE_LIMIT_BYPASS_TOKEN` exempts a caller that knows it, and nothing else: the bearer check still
 * applies, so this cannot reach an endpoint, only be allowed to reach one often.
 *
 * Driven through the real handler with the real middleware, because the wiring is the thing being
 * asserted. The limiter is a process-wide singleton keyed by client address, so the two phases run
 * in one test, in order: the bypassed requests first, because they must not consume the budget the
 * second phase then exhausts.
 */
import { Effect, Exit, Layer, Redacted, Scope } from "effect";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { afterAll, describe, expect, it } from "vitest";
import { AppConfigTest, ApiLive, LiveKitMediaPlaneLive, Metrics, ProcessMetricsLive, ScriptedTurnDeciderLive, securityMiddleware, ServicesLive } from "../../src/index.js";
import { makeInfraLayer } from "./harness.js";

const BYPASS = "bypass-secret-for-the-harness";
/** One request per minute, so the second is over budget and the arithmetic is not what is tested. */
const budget = { rateLimitPerMinute: 1, rateLimitBypassToken: Redacted.make(BYPASS) };

const scope = Effect.runSync(Scope.make());

/**
 * `toWebHandler`'s middleware slot takes an app with no requirements of its own, and
 * `securityMiddleware` needs `AppConfig` and `Metrics` — in the server those arrive through the
 * same `Layer.provide` the handlers use. Supplied here from a context built with the same config,
 * so the middleware itself is the real one and only its plumbing differs.
 */
const middlewareContext = Effect.runSync(Scope.extend(Layer.build(Layer.mergeAll(AppConfigTest(budget), Metrics.Default)), scope));

const web = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
    Layer.provide(ProcessMetricsLive({ pgPool: () => null, sseStreams: () => 0, liveTurns: () => 0, rateLimitBuckets: () => 0 })),
    Layer.provideMerge(ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive))),
    Layer.provideMerge(makeInfraLayer(budget)),
  ),
  { middleware: (app) => securityMiddleware(app).pipe(Effect.provide(middlewareContext)) },
);

/** A rate-limited prefix. The body is deliberately not a valid call: the middleware answers first. */
const start = (headers: Record<string, string> = {}) =>
  web.handler(new Request("http://localhost/api/calls/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));

afterAll(async () => {
  await web.dispose();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("the per-IP request budget", () => {
  it("exempts a caller with the bypass token, and sheds one without it", async () => {
    // Phase 1: exempt. Five requests against a budget of one, none refused, and none of them
    // consuming the budget — which is what the next phase proves.
    const bypassed: number[] = [];
    for (let i = 0; i < 5; i++) bypassed.push((await start({ "x-ratelimit-bypass": BYPASS })).status);
    expect(bypassed.filter((s) => s === 429)).toEqual([]);

    // Phase 2: not exempt. The budget is untouched, so the first is served and the rest are not.
    const first = await start();
    expect(first.status).not.toBe(429);
    expect((await start()).status).toBe(429);

    // A wrong token is not a token.
    expect((await start({ "x-ratelimit-bypass": "not-the-secret" })).status).toBe(429);
    // ...and neither is an empty one. `RATE_LIMIT_BYPASS_TOKEN=` in a `.env` reads as `Some("")`,
    // and an empty secret compared against the empty-string fallback for a *missing* header would
    // have exempted every request on the box — from a line written to turn the feature off.
    expect((await start({ "x-ratelimit-bypass": "" })).status).toBe(429);
  });
});
