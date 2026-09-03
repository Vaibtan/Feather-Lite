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
  LiveKitMediaPlaneLive,
  MediaPlane,
  Metrics,
  OpenAILlmClientLive,
  OpenAITurnDeciderLive,
  OutboxService,
  Gauges,
  pgPoolGauge,
  ProcessMetrics,
  ProcessMetricsLive,
  profileIfAsked,
  SchedulingService,
  ScriptedTurnDeciderLive,
  ServicesLive,
  rateLimitBucketCount,
  Sweeper,
} from "@feather-lite/control-plane";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "0.0.0.0";

const DeciderLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    if (cfg.turnDecider === "openai") {
      if (cfg.openaiApiKey === null) yield* Effect.logWarning("TURN_DECIDER=openai but OPENAI_API_KEY is missing; every turn will degrade to the safe fallback");
      yield* Effect.logInfo(`turn decider: openai (${cfg.llmModelByState.GREETING} / ${cfg.llmModelByState.DISCUSSING_PAYMENT}); tracing: ${cfg.langfuse && cfg.langfuseEnabled ? "langfuse" : "off"}`);
      return OpenAITurnDeciderLive;
    }
    yield* Effect.logInfo(`turn decider: scripted (deterministic); tracing: ${cfg.langfuse && cfg.langfuseEnabled ? "langfuse" : "off"}`);
    return ScriptedTurnDeciderLive;
  }),
);

const SchedulersLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const scheduling = yield* SchedulingService;
    const outbox = yield* OutboxService;
    const sweeper = yield* Sweeper;
    const media = yield* MediaPlane;
    const process = yield* ProcessMetrics;
    // Register before forking, stamp only on the success path. Stamping under `catchAll` keeps
    // `/readyz` green for a loop that fails every tick; registering on first success hides a loop
    // that died before reaching one.
    const tick = <A, E, R>(name: string, run: (onProgress: Effect.Effect<void>) => Effect.Effect<A, E, R>, every: Duration.DurationInput) =>
      Effect.gen(function* () {
        const intervalMs = Duration.toMillis(Duration.decode(every));
        const stamp = process.tick(name, intervalMs);
        yield* process.register(name, intervalMs);
        return yield* run(stamp).pipe(
          Effect.zipLeft(stamp),
          Effect.tapError((e) => Effect.logError(`${name} tick failed`, e)),
          Effect.tapError(() => process.tickFailed(name, intervalMs)),
          Effect.catchAll(() => Effect.void),
          Effect.repeat(Schedule.spaced(every)),
          Effect.forkScoped,
        );
      });
    // Declared before any is registered, so `/readyz` can tell "no loops are late" from "the
    // schedulers never started".
    yield* process.expectLoops(["scheduled-actions", "outbox", "sweeper"]);
    yield* tick("scheduled-actions", () => scheduling.runOnce(20), "15 seconds");
    // The stamp is passed in so a long drain reports liveness per batch rather than only when it
    // finishes; otherwise a busy outbox is what trips `/readyz`.
    yield* tick("outbox", (onBatch) => outbox.drain(20, onBatch), "5 seconds");
    // Every 10 s puts worst-case orphan detection one heartbeat interval past the staleness window.
    yield* tick("sweeper", () => sweeper.runOnce(20), "10 seconds");
    yield* Effect.logInfo(`schedulers started (sweeper ${cfg.sweeperEnabled ? `on, ${sweeper.stalenessMs} ms staleness, confirming via ${media.name}` : "off"})`);
    yield* profileIfAsked;
  }),
);

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
  // Provided unconditionally, not only for the openai decider: the post-call judge calls a model
  // whichever conversationalist ran the call.
  Layer.provideMerge(OpenAILlmClientLive),
  Layer.provideMerge(LiveKitMediaPlaneLive),
  Layer.provideMerge(LangfuseTracingLive),
  Layer.provideMerge(Metrics.Default),
  Layer.provideMerge(
    Layer.unwrapEffect(
      Effect.gen(function* () {
        const gauges = yield* Gauges;
        return ProcessMetricsLive({
          pgPool: pgPoolGauge,
          sseStreams: () => gauges.read("sse_streams"),
          liveTurns: () => gauges.read("live_turns"),
          rateLimitBuckets: rateLimitBucketCount,
        });
      }),
    ),
  ),
  Layer.provideMerge(Gauges.Default),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(AppConfigLive),
  Layer.provide(NodeServerLive),
);

Layer.launch(MainLive).pipe(
  Effect.tapErrorCause((c) => Effect.logError("server failed", c)),
  NodeRuntime.runMain,
);
