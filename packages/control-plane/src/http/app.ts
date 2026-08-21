/**
 * Composes the HttpApi implementation, security middleware (bearer token on mutating routes,
 * per-IP rate limits, daily turn cap — plan rev.2 R15), CORS, OpenAPI docs, and the runtime
 * layers. `HttpLive` needs an `HttpServer` (Node in apps/server; a web handler for the edge stretch).
 */
import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { FeatherApi } from "@feather-lite/contracts";
import { AppConfig } from "../config.js";
import { CallsLive, ConversationsLive, DemoLive, SystemLive, TestingLive, VoiceLive } from "./handlers.js";
import { Metrics } from "./Metrics.js";
import { TurnRunner } from "./TurnRunner.js";
import { Orchestrator } from "../services/Orchestrator.js";
import { OutboxService } from "../services/Outbox.js";
import { SchedulingService } from "../services/Scheduling.js";
import { Queries } from "../services/Queries.js";
import { ScenarioRunner } from "../services/Scenarios.js";
import { SeedService } from "../services/Seed.js";
import { VoiceSessions } from "../services/VoiceSessions.js";
import { WorkflowService } from "../services/Workflow.js";
import { SchedulingRepo } from "../repos/scheduling.js";

/** All groups implemented. Requires the service layers + AppConfig + PgClient. */
export const ApiLive = HttpApiBuilder.api(FeatherApi).pipe(
  Layer.provide([SystemLive, CallsLive, ConversationsLive, TestingLive, VoiceLive, DemoLive]),
);

/** Service graph the API needs (everything but the DB client / config / decider). */
export const ServicesLive = Layer.mergeAll(
  Orchestrator.Default,
  SchedulingService.Default,
  OutboxService.Default,
  TurnRunner.Default,
  Queries.Default,
  ScenarioRunner.Default,
  SeedService.Default,
  VoiceSessions.Default,
  WorkflowService.Default,
  SchedulingRepo.Default,
  Metrics.Default,
);

const RATE_LIMITED_PREFIXES = ["/api/calls/start", "/api/voice/sessions", "/api/conversations"];

/**
 * Bearer auth for mutating requests when API_BEARER_TOKEN is set; simple per-IP token bucket;
 * daily cap on turn requests (each may spend LLM tokens). Health/docs/OPTIONS are always open.
 *
 * Both budgets are config (`RATE_LIMIT_PER_MINUTE`, `DAILY_TURN_CAP`) because a load run drives
 * hundreds of turns a minute from one IP; the public-demo defaults are unchanged.
 */
export const securityMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const url = req.url;
    const method = req.method;
    const open = method === "GET" || method === "OPTIONS" || url.startsWith("/healthz") || url.startsWith("/readyz") || url.startsWith("/docs") || url.startsWith("/api/agents/heartbeat");
    if (!open && cfg.apiBearerToken !== null) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${Redacted.value(cfg.apiBearerToken)}`) {
        return HttpServerResponse.unsafeJson({ _tag: "ApiUnauthorized", message: "missing or invalid bearer token" }, { status: 401 });
      }
    }
    if (!open && RATE_LIMITED_PREFIXES.some((p) => url.startsWith(p))) {
      const ip = (req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.remoteAddress.pipe((o) => (o._tag === "Some" ? o.value : "local"))).split(",")[0]!.trim();
      const ok = yield* rateLimit(ip, cfg.rateLimitPerMinute);
      if (!ok) return HttpServerResponse.unsafeJson({ _tag: "ApiRateLimited", message: "too many requests" }, { status: 429 });
      if (url.includes("/turn") || url.includes("/simulate_turn")) {
        const under = yield* dailyTurnBudget(cfg.dailyTurnCap);
        if (!under) return HttpServerResponse.unsafeJson({ _tag: "ApiRateLimited", message: "daily turn budget exhausted" }, { status: 429 });
      }
    }
    return yield* app;
  }),
);

// Process-local buckets (fine for a single Node process; the edge port would use KV/DO).
const buckets = new Map<string, { count: number; windowStart: number }>();
const rateLimit = (ip: string, perMinute: number) =>
  Effect.sync(() => {
    const now = Date.now();
    const b = buckets.get(ip);
    if (!b || now - b.windowStart > 60_000) {
      buckets.set(ip, { count: 1, windowStart: now });
      return true;
    }
    b.count += 1;
    return b.count <= perMinute;
  });
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

/** Serve the API with CORS, OpenAPI JSON at /docs/openapi.json and Swagger UI at /docs. */
export const HttpLive = HttpApiBuilder.serve(securityMiddleware).pipe(
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/docs/openapi.json" })),
  Layer.provide(HttpApiBuilder.middlewareCors({ allowedOrigins: () => true, allowedMethods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "last-event-id"], credentials: false })),
  Layer.provide(ApiLive),
);

