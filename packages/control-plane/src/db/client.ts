import { Effect, Layer, Redacted, String as Str } from "effect";
import Pg from "pg";
import { NodeContext } from "@effect/platform-node";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Migrator, SqlClient } from "@effect/sql";
import { AppConfig } from "../config.js";
import { migration0001 } from "./migrations/0001_initial.js";
import { migration0002 } from "./migrations/0002_scores.js";
import { migration0003 } from "./migrations/0003_conversation_liveness.js";
import { migration0004 } from "./migrations/0004_conversation_decider.js";
import { migration0005 } from "./migrations/0005_measure_and_hot_rows.js";
import { migration0006 } from "./migrations/0006_indexes_from_evidence.js";
import { migration0007 } from "./migrations/0007_claim_lease.js";
import { migration0008 } from "./migrations/0008_conversation_origin.js";
import { migration0009 } from "./migrations/0009_conversation_harness.js";

// `PgClient` does not expose the pool it builds, so this module owns one to report its depth. Null
// in any process that never touches Postgres, so the gauge reports "not measured" rather than zero.
let livePool: Pg.Pool | null = null;

export const pgPoolGauge = (): { size: number; idle: number; waiting: number } | null =>
  livePool === null ? null : { size: livePool.totalCount, idle: livePool.idleCount, waiting: livePool.waitingCount };

export const PgLive: Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, unknown, AppConfig> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    // The name transforms are load-bearing: queries are written camelCase against a snake_case
    // schema, so dropping one still compiles and fails at runtime on every query.
    return PgClient.layerFromPool({
      acquire: Effect.acquireRelease(
        Effect.sync(() => {
          const pool = new Pg.Pool({ connectionString: Redacted.value(cfg.databaseUrl), max: cfg.dbMaxConnections, application_name: "feather-lite" });
          livePool = pool;
          return pool;
        }),
        (pool) =>
          Effect.promise(() => pool.end()).pipe(
            Effect.ignore,
            Effect.tap(() =>
              Effect.sync(() => {
                livePool = null;
              }),
            ),
          ),
      ),
      transformQueryNames: Str.camelToSnake,
      transformResultNames: Str.snakeToCamel,
      // JSONB payloads are the wire format (snake_case) — never rename keys inside them.
      transformJson: false,
      applicationName: "feather-lite",
    });
  }),
);

export const MigrationsLive = PgMigrator.layer({
  loader: Migrator.fromRecord({
    "0001_initial": migration0001,
    "0002_scores": migration0002,
    "0003_conversation_liveness": migration0003,
    "0004_conversation_decider": migration0004,
    "0005_measure_and_hot_rows": migration0005,
    "0006_indexes_from_evidence": migration0006,
    "0007_claim_lease": migration0007,
    "0008_conversation_origin": migration0008,
    "0009_conversation_harness": migration0009,
  }),
}).pipe(Layer.provide(NodeContext.layer));

export const DatabaseLive = Layer.provideMerge(MigrationsLive, PgLive).pipe(Layer.provideMerge(PgLive));
