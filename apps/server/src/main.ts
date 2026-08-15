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
  OutboxService,
  SchedulingService,
  ScriptedTurnDeciderLive,
  ServicesLive,
} from "@feather-lite/control-plane";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "0.0.0.0";

/** Which conversationalist to run: scripted (deterministic) or the OpenAI decider (Phase 4). */
const DeciderLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    if (cfg.turnDecider === "openai") {
      yield* Effect.logWarning("TURN_DECIDER=openai requested but the OpenAI decider ships in Phase 4; using scripted");
    }
    return ScriptedTurnDeciderLive;
  }),
);

/** Background loops: claim + process due scheduled actions and outbox jobs. */
const SchedulersLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const scheduling = yield* SchedulingService;
    const outbox = yield* OutboxService;
    const tick = <A, E, R>(name: string, run: Effect.Effect<A, E, R>, every: Duration.DurationInput) =>
      run.pipe(
        Effect.tapError((e) => Effect.logError(`${name} tick failed`, e)),
        Effect.catchAll(() => Effect.void),
        Effect.repeat(Schedule.spaced(every)),
        Effect.forkScoped,
      );
    yield* tick("scheduled-actions", scheduling.runOnce(20), "15 seconds");
    yield* tick("outbox", outbox.runOnce(20), "5 seconds");
    yield* Effect.logInfo("schedulers started");
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
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(AppConfigLive),
  Layer.provide(NodeServerLive),
);

Layer.launch(MainLive).pipe(
  Effect.tapErrorCause((c) => Effect.logError("server failed", c)),
  NodeRuntime.runMain,
);
