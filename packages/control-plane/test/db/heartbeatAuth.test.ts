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

const blankScope = Effect.runSync(Scope.make());
const blankTokenConfig = { apiBearerToken: Redacted.make("") };
const blankMiddlewareContext = Effect.runSync(Scope.extend(Layer.build(Layer.mergeAll(AppConfigTest(blankTokenConfig), Metrics.Default)), blankScope));
const blankWeb = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
    Layer.provide(ProcessMetricsLive({ pgPool: () => null, sseStreams: () => 0, liveTurns: () => 0, rateLimitBuckets: () => 0 })),
    Layer.provideMerge(ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive))),
    Layer.provideMerge(makeInfraLayer(blankTokenConfig)),
  ),
  { middleware: (app) => securityMiddleware(app).pipe(Effect.provide(blankMiddlewareContext)) },
);

describe("a blank API_BEARER_TOKEN", () => {
  it("means no authentication, not authentication with an empty secret", async () => {
    const res = await blankWeb.handler(
      new Request("http://localhost/api/agents/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_name: "feather-lite-agent", conversations: [] }),
      }),
    );
    expect(res.status).not.toBe(401);
    await blankWeb.dispose();
    await Effect.runPromise(Scope.close(blankScope, Exit.void));
  });
});

describe("the agent heartbeat's bearer", () => {
  it("refuses an unauthenticated heartbeat when a token is configured", async () => {
    expect((await heartbeat()).status).toBe(401);
  });

  it("refuses a heartbeat presenting the wrong token", async () => {
    expect((await heartbeat({ authorization: "Bearer not-the-secret" })).status).toBe(401);
    expect((await heartbeat({ authorization: TOKEN })).status).toBe(401);
    expect((await heartbeat({ authorization: "Bearer " })).status).toBe(401);
  });

  it("serves the worker, which presents the same bearer it uses for a turn", async () => {
    expect((await heartbeat({ authorization: `Bearer ${TOKEN}` })).status).not.toBe(401);
  });
});
