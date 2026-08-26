/**
 * Postgres client + migrations. `@effect/sql-pg` wraps node-postgres.
 * Column names are camelCased on the way out and snake_cased on the way in;
 * JSONB payload keys are untouched (they stay snake_case — the wire format).
 */
import { Effect, Layer, String as Str } from "effect";
import { NodeContext } from "@effect/platform-node";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Migrator, SqlClient } from "@effect/sql";
import { AppConfig } from "../config.js";
import { migration0001 } from "./migrations/0001_initial.js";
import { migration0002 } from "./migrations/0002_scores.js";
import { migration0003 } from "./migrations/0003_conversation_liveness.js";

export const PgLive: Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, unknown, AppConfig> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    return PgClient.layer({
      url: cfg.databaseUrl,
      maxConnections: cfg.dbMaxConnections,
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
  }),
}).pipe(Layer.provide(NodeContext.layer));

/** Runs migrations, then exposes the client. */
export const DatabaseLive = Layer.provideMerge(MigrationsLive, PgLive).pipe(Layer.provideMerge(PgLive));
