/**
 * The agent heartbeat is a mutating endpoint and is authenticated like one (C2).
 *
 * `POST /api/agents/heartbeat` upserts `conversation_liveness` for whatever conversation ids the
 * caller names, and that column is exactly what the orphaned-call sweeper filters on: a call whose
 * liveness is fresh is a call somebody is serving, so it is not swept. While the path sat in the
 * middleware's `open` list, anyone who could reach the port could keep any conversation alive
 * forever — pinning the borrower behind an active call that no worker was actually running — and
 * could do it without a token on a server that had one configured for every other write.
 *
 * Driven through the real handler with the real middleware, like `rateLimit.test.ts`, because the
 * wiring is the thing being asserted.
 */
import { Effect, Exit, Layer, Redacted, Scope } from "effect";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { afterAll, describe, expect, it } from "vitest";
import { AppConfigTest, ApiLive, LiveKitMediaPlaneLive, Metrics, ProcessMetricsLive, ScriptedTurnDeciderLive, securityMiddleware, ServicesLive } from "../../src/index.js";
import { makeInfraLayer } from "./harness.js";

const TOKEN = "bearer-secret-for-the-worker";
const withToken = { apiBearerToken: Redacted.make(TOKEN) };

const scope = Effect.runSync(Scope.make());
const middlewareContext = Effect.runSync(Scope.extend(Layer.build(Layer.mergeAll(AppConfigTest(withToken), Metrics.Default)), scope));

const web = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
    Layer.provide(ProcessMetricsLive({ pgPool: () => null, sseStreams: () => 0, liveTurns: () => 0, rateLimitBuckets: () => 0 })),
    Layer.provideMerge(ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive))),
    Layer.provideMerge(makeInfraLayer(withToken)),
  ),
  { middleware: (app) => securityMiddleware(app).pipe(Effect.provide(middlewareContext)) },
);

/** The body a worker beats with. It never gets as far as the handler in the unauthorised cases. */
const heartbeat = (headers: Record<string, string> = {}) =>
  web.handler(
    new Request("http://localhost/api/agents/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ agent_name: "feather-lite-agent", conversations: [] }),
    }),
  );

afterAll(async () => {
  await web.dispose();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("the agent heartbeat's bearer", () => {
  it("refuses an unauthenticated heartbeat when a token is configured", async () => {
    expect((await heartbeat()).status).toBe(401);
  });

  it("refuses a heartbeat presenting the wrong token", async () => {
    expect((await heartbeat({ authorization: "Bearer not-the-secret" })).status).toBe(401);
    // A bare token is not a bearer, and an empty one is not a token.
    expect((await heartbeat({ authorization: TOKEN })).status).toBe(401);
    expect((await heartbeat({ authorization: "Bearer " })).status).toBe(401);
  });

  it("serves the worker, which presents the same bearer it uses for a turn", async () => {
    expect((await heartbeat({ authorization: `Bearer ${TOKEN}` })).status).not.toBe(401);
  });
});
