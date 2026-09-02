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
  Quality.Default,
  Scores.Default,
  Sweeper.Default,
  ScenarioRunner.Default,
  SeedService.Default,
  VoiceSessions.Default,
  WorkflowService.Default,
  SchedulingRepo.Default,
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
    /**
     * `/api/agents/heartbeat` is **not** here (C2). It reads like telemetry and is not: it upserts
     * `conversation_liveness` for whatever conversation ids the caller names, which is the column
     * the orphaned-call sweeper filters on, so an unauthenticated beat keeps any call un-swept and
     * its borrower blocked behind an active call nobody is serving. The worker already presents the
     * bearer on every request it makes, this one included.
     *
     * **And it is deliberately not in `RATE_LIMITED_PREFIXES` either**, though C2 names it as
     * un-rate-limited. A budget is the wrong control for liveness: every job process beats its own
     * conversation every 10 s and the main worker beats every 10 s, so ten concurrent calls are 66
     * beats a minute from one container address against a default budget of 120 — and a *shed*
     * beat is not a dropped metric, it is the sweeper finalizing a call somebody is serving. Auth
     * is what this endpoint needed; a per-IP budget on it would turn load into orphaned calls.
     */
    const open = method === "GET" || method === "OPTIONS" || url.startsWith("/healthz") || url.startsWith("/readyz") || url.startsWith("/docs");
    if (!open && cfg.apiBearerToken !== null) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${Redacted.value(cfg.apiBearerToken)}`) {
        return HttpServerResponse.unsafeJson({ _tag: "ApiUnauthorized", message: "missing or invalid bearer token" }, { status: 401 });
      }
    }
    if (!open && RATE_LIMITED_PREFIXES.some((p) => url.startsWith(p))) {
      const metrics = yield* Metrics;
      /**
       * The harness is not a stranger (O9).
       *
       * Its runs drive hundreds of turns a minute from one address and the per-IP budget sheds
       * them, so the previous answer was to raise `RATE_LIMIT_PER_MINUTE` and `DAILY_TURN_CAP` in
       * the server's environment for the duration — which measures a server configured differently
       * from the one being described, and moves the knob a public demo depends on. A run that
       * presents this secret is exempt instead, and is counted so an operator can see how much of
       * the traffic was exempt rather than budgeted.
       */
      const presented = req.headers["x-ratelimit-bypass"];
      if (cfg.rateLimitBypassToken !== null && presented !== undefined && presented === Redacted.value(cfg.rateLimitBypassToken)) {
        yield* metrics.increment("rate_limit_bypassed");
        return yield* app;
      }
      /**
       * A shed request is counted before it is refused (O9). A tier-1 run from one IP was 429ed 92
       * times, reported "23/50 correct", and moved no counter anywhere - so the status page could
       * not tell "the agent is broken" from "my own middleware is shedding load". The two prefixes
       * are counted apart because they mean different things: a refused start is a call that never
       * happened, a refused turn is a call that broke midway.
       */
      // Matched on the path's last segment, not on a substring of the whole URL: `includes("/turn")`
      // is correct for today's five rate-limited routes and would silently miscount the first route
      // that merely contains the word (a `/return`, a `/turnaround`).
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

/**
 * Is this the turn-taking path? The two routes that consume the daily budget both end in a segment
 * named for a turn; anything else under the rate-limited prefixes is a call-level request.
 */
const isTurnPath = (url: string): boolean => {
  const path = (url.split("?")[0] ?? "").replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last === "turn" || last === "simulate_turn";
};

/** The per-IP budget; see `rateLimit.ts` for why it is a unit rather than six lines inline (O9). */
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

/** Serve the API with CORS, OpenAPI JSON at /docs/openapi.json and Swagger UI at /docs. */
export const HttpLive = HttpApiBuilder.serve(securityMiddleware).pipe(
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/docs/openapi.json" })),
  Layer.provide(HttpApiBuilder.middlewareCors({ allowedOrigins: () => true, allowedMethods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "last-event-id"], credentials: false })),
  Layer.provide(ApiLive),
);

