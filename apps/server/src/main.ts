/**
 * Feather-Lite control-plane server (Node). One process:
 *   - HTTP API (Effect HttpApi) with OpenAPI docs at /docs
 *   - in-process schedulers: scheduled actions (callbacks/retries) and outbox jobs
 *   - root pointer page (the console is a separate static app, see apps/console)
 *
 * Config comes from the environment / .env at the repo root (see packages/control-plane/src/config.ts).
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer, Schedule } from "effect";
import {
  AppConfig,
  AppConfigLive,
  DatabaseLive,
  HttpLive,
  LangfuseTracingLive,
  liveTurnCount,
  LiveKitMediaPlaneLive,
  MediaPlane,
  Metrics,
  OpenAILlmClientLive,
  OpenAITurnDeciderLive,
  OutboxService,
  pgPoolGauge,
  ProcessMetrics,
  ProcessMetricsLive,
  SchedulingService,
  ScriptedTurnDeciderLive,
  ServicesLive,
  rateLimitBucketCount,
  subscriberCount,
  Sweeper,
} from "@feather-lite/control-plane";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "0.0.0.0";

/** Which conversationalist to run: TURN_DECIDER=openai (real model + Langfuse) or scripted (deterministic). */
const DeciderLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    if (cfg.turnDecider === "openai") {
      if (cfg.openaiApiKey === null) yield* Effect.logWarning("TURN_DECIDER=openai but OPENAI_API_KEY is missing; every turn will degrade to the safe fallback");
      // `cfg.langfuse` alone was not the state: LANGFUSE_ENABLED=false with keys present reported
      // "tracing: langfuse" while exporting nothing.
      yield* Effect.logInfo(`turn decider: openai (${cfg.llmModelByState.GREETING} / ${cfg.llmModelByState.DISCUSSING_PAYMENT}); tracing: ${cfg.langfuse && cfg.langfuseEnabled ? "langfuse" : "off"}`);
      // Tracing is provided once, at the root: the decider records the generation and the
      // orchestrator records the turn it belongs to, and they have to be the same instance for the
      // two halves to meet.
      // The client comes from the root rather than being provided here: the judge needs one too,
      // and it must be the same one whichever decider is running.
      return OpenAITurnDeciderLive;
    }
    /**
     * The tracing state is said on *both* branches (D3). It used to be named only under
     * `openai`, so a scripted run left "is Langfuse on?" unanswered in the log — and the answer
     * matters most there: the scripted decider is what the tier-1 harness drives, and an exporter
     * left on during a load run is both a cost and a latency the numbers would carry silently.
     */
    yield* Effect.logInfo(`turn decider: scripted (deterministic); tracing: ${cfg.langfuse && cfg.langfuseEnabled ? "langfuse" : "off"}`);
    return ScriptedTurnDeciderLive;
  }),
);

/** Background loops: claim + process due scheduled actions and outbox jobs. */
const SchedulersLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const scheduling = yield* SchedulingService;
    const outbox = yield* OutboxService;
    const sweeper = yield* Sweeper;
    const media = yield* MediaPlane;
    const process = yield* ProcessMetrics;
    /**
     * Each loop records that it ticked (D3). A loop whose fiber has died stops updating its stamp
     * and `/readyz` fails — which is the point: a process with a dead outbox answers HTTP perfectly
     * and is not ready, and nothing could tell the difference before.
     *
     * Stamped after the run, so a tick that throws does not claim to have happened. The error is
     * already logged and swallowed below to keep the loop alive.
     */
    const tick = <A, E, R>(name: string, run: Effect.Effect<A, E, R>, every: Duration.DurationInput) =>
      run.pipe(
        Effect.tapError((e) => Effect.logError(`${name} tick failed`, e)),
        Effect.catchAll(() => Effect.void),
        Effect.zipLeft(process.tick(name, Duration.toMillis(Duration.decode(every)))),
        Effect.repeat(Schedule.spaced(every)),
        Effect.forkScoped,
      );
    yield* tick("scheduled-actions", scheduling.runOnce(20), "15 seconds");
    yield* tick("outbox", outbox.runOnce(20), "5 seconds");
    // Every 10 s, so worst-case detection is one heartbeat interval past the staleness window
    // (~40 s) and typical is ~35 s — the number D6 set.
    yield* tick("sweeper", sweeper.runOnce(20), "10 seconds");
    // Which media plane resolved matters: without LiveKit every sweep falls back to the long
    // unconfirmed window, which is a very different detection time than the ~35 s headline.
    yield* Effect.logInfo(`schedulers started (sweeper ${cfg.sweeperEnabled ? `on, ${sweeper.stalenessMs} ms staleness, confirming via ${media.name}` : "off"})`);
  }),
);

/** Root pointer page; serves the built console if present. */
const consoleDist = fileURLToPath(new URL("../../console/dist", import.meta.url));
const RootRoute = HttpApiBuilder.Router.use((router) =>
  router.get(
    "/",
    Effect.gen(function* () {
      if (existsSync(`${consoleDist}/index.html`)) return yield* HttpServerResponse.file(`${consoleDist}/index.html`).pipe(Effect.orDie);
      return HttpServerResponse.text("Feather-Lite control plane is running.\n\nAPI docs: /docs\nHealth: /healthz  Ready: /readyz  Status: /api/system/status\n");
    }),
  ),
);

const NodeServerLive = NodeHttpServer.layer(() => createServer(), { port, host });

const MainLive = Layer.mergeAll(HttpLive, RootRoute, SchedulersLive).pipe(
  Layer.provide(ServicesLive),
  Layer.provide(DeciderLive),
  // Provided unconditionally, not only for TURN_DECIDER=openai: the post-call judge calls a model
  // regardless of which conversationalist ran the call, and constructing the client is free — it
  // fails at call time, with a clear message, when no key is configured.
  Layer.provideMerge(OpenAILlmClientLive),
  // Metrics is provided once, at the root, for the same reason Tracing is: the decider records
  // provider failures, the HTTP edge counts requests and rejections, and the status handler reads
  // both. Separate instances would each hold half the answer.
  //
  // (This comment used to say the orchestrator counted here as well. It never has — O14.)
  Layer.provideMerge(LiveKitMediaPlaneLive),
  Layer.provideMerge(LangfuseTracingLive),
  // Below the tracing layer, not above it: `provideMerge` supplies downward, and the Langfuse
  // exporter now counts its own ingestion failures (O7). Still merged upward, so the decider and
  // the HTTP edge see the same single instance.
  Layer.provideMerge(Metrics.Default),
  // The process's own gauges (D3). Its sources are functions rather than services because the
  // things it reports on — the pool, the SSE map, the rate-limit buckets — are owned by modules
  // that must not depend on a metrics service to be observable.
  Layer.provideMerge(
    ProcessMetricsLive({
      pgPool: pgPoolGauge,
      sseStreams: () => subscriberCount(),
      liveTurns: () => liveTurnCount(),
      rateLimitBuckets: rateLimitBucketCount,
    }),
  ),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(AppConfigLive),
  Layer.provide(NodeServerLive),
);

Layer.launch(MainLive).pipe(
  Effect.tapErrorCause((c) => Effect.logError("server failed", c)),
  NodeRuntime.runMain,
);
