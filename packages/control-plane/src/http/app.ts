import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { createHash, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted } from "effect";
import { FeatherApi } from "@feather-lite/contracts";
import { AppConfig } from "../config.js";
import { CallsLive, ConversationsLive, DemoLive, SystemLive, TestingLive, VoiceLive } from "./handlers.js";
import { TurnRunner } from "./TurnRunner.js";
import { Orchestrator } from "../services/Orchestrator.js";
import { OutboxService } from "../services/Outbox.js";
import { SchedulingService } from "../services/Scheduling.js";
import { Metrics } from "../services/Metrics.js";
import { limiter } from "./rateLimit.js";
import { Queries } from "../services/Queries.js";
import { Quality } from "../services/Quality.js";
import { Scores } from "../services/Scores.js";
import { Sweeper } from "../services/Sweeper.js";
import { ScenarioRunner } from "../services/Scenarios.js";
import { SeedService } from "../services/Seed.js";
import { VoiceSessions } from "../services/VoiceSessions.js";
import { WorkflowService } from "../services/Workflow.js";
import { SchedulingRepo } from "../repos/scheduling.js";

export const ApiLive = HttpApiBuilder.api(FeatherApi).pipe(
  Layer.provide([SystemLive, CallsLive, ConversationsLive, TestingLive, VoiceLive, DemoLive]),
);

export const ServicesLive = Layer.mergeAll(
  Orchestrator.Default,
  SchedulingService.Default,
  OutboxService.Default,
  TurnRunner.Default,
  Queries.Default,
  Quality.Default,
  Scores.Default,
  Sweeper.Default,
  ScenarioRunner.Default,
  SeedService.Default,
  VoiceSessions.Default,
  WorkflowService.Default,
  SchedulingRepo.Default,
);

// `===` returns on the first differing byte, a timing oracle for the secret. Digests are compared
// rather than the values because `timingSafeEqual` throws on a length mismatch, leaking its length.
const secretEquals = (presented: string, expected: string): boolean =>
  timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(expected).digest());

const RATE_LIMITED_PREFIXES = ["/api/calls/start", "/api/voice/sessions", "/api/conversations"];

export const securityMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const url = req.url;
    const method = req.method;
    // `/api/agents/heartbeat` is deliberately neither open nor rate-limited: it upserts the
    // liveness column the orphan sweeper filters on, so a shed or unauthenticated beat lets the
    // sweeper finalize a call somebody is still serving.
    const open = method === "GET" || method === "OPTIONS" || url.startsWith("/healthz") || url.startsWith("/readyz") || url.startsWith("/docs");
    // A blank token is not a token: an empty `API_BEARER_TOKEN` must leave auth off, not switch it
    // on with an empty secret that every caller then has to present.
    const bearer = cfg.apiBearerToken === null ? "" : Redacted.value(cfg.apiBearerToken);
    if (!open && bearer.length > 0) {
      const auth = req.headers["authorization"] ?? "";
      if (!secretEquals(auth, `Bearer ${bearer}`)) {
        return HttpServerResponse.unsafeJson({ _tag: "ApiUnauthorized", message: "missing or invalid bearer token" }, { status: 401 });
      }
    }
    if (!open && RATE_LIMITED_PREFIXES.some((p) => url.startsWith(p))) {
      const metrics = yield* Metrics;
      const presented = req.headers["x-ratelimit-bypass"];
      if (cfg.rateLimitBypassToken !== null && presented !== undefined && secretEquals(presented, Redacted.value(cfg.rateLimitBypassToken))) {
        yield* metrics.increment("rate_limit_bypassed");
        return yield* app;
      }
      const bucketName = isTurnPath(url) ? "rate_limited_turn" : "rate_limited_start";
      const ip = (req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.remoteAddress.pipe((o) => (o._tag === "Some" ? o.value : "local"))).split(",")[0]!.trim();
      const ok = yield* rateLimit(ip, cfg.rateLimitPerMinute);
      if (!ok) {
        yield* metrics.increment(bucketName);
        return HttpServerResponse.unsafeJson({ _tag: "ApiRateLimited", message: "too many requests" }, { status: 429 });
      }
      if (isTurnPath(url)) {
        const under = yield* dailyTurnBudget(cfg.dailyTurnCap);
        if (!under) {
          yield* metrics.increment("rate_limited_daily_cap");
          return HttpServerResponse.unsafeJson({ _tag: "ApiRateLimited", message: "daily turn budget exhausted" }, { status: 429 });
        }
      }
    }
    return yield* app;
  }),
);

const isTurnPath = (url: string): boolean => {
  const path = (url.split("?")[0] ?? "").replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last === "turn" || last === "simulate_turn";
};

const rateLimit = (ip: string, perMinute: number) => Effect.sync(() => limiter.check(ip, perMinute));
const dailyRef = { day: "", count: 0 };
const dailyTurnBudget = (cap: number) =>
  Effect.sync(() => {
    const day = new Date().toISOString().slice(0, 10);
    if (dailyRef.day !== day) {
      dailyRef.day = day;
      dailyRef.count = 0;
    }
    dailyRef.count += 1;
    return dailyRef.count <= cap;
  });

export const HttpLive = HttpApiBuilder.serve(securityMiddleware).pipe(
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/docs/openapi.json" })),
  Layer.provide(HttpApiBuilder.middlewareCors({ allowedOrigins: () => true, allowedMethods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "last-event-id"], credentials: false })),
  Layer.provide(ApiLive),
);

