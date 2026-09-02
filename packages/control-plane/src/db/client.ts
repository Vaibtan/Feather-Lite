/**
 * Postgres client + migrations. `@effect/sql-pg` wraps node-postgres.
 * Column names are camelCased on the way out and snake_cased on the way in;
 * JSONB payload keys are untouched (they stay snake_case — the wire format).
 */
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

/**
 * The connection pool, held so its depth can be reported (D3).
 *
 * `PgClient` does not expose the pool it builds, and "is the app waiting for a connection?" is one
 * of the two questions an operator asks when turns go slow — the 2026-08-21 experiment that raised
 * the pool from 10 to 40 and got *less* throughput was diagnosed exactly this way, from
 * `pg_stat_activity` showing 22 backends idle in transaction. That was a harness scraping the
 * database; this is the process saying it about itself.
 *
 * Null until the layer is built, and null again in any process that never touches Postgres, so the
 * gauge reports "not measured" rather than a zero-depth pool that does not exist.
 */
let livePool: Pg.Pool | null = null;

/** `{size, idle, waiting}` from node-postgres, or null when there is no pool. */
export const pgPoolGauge = (): { size: number; idle: number; waiting: number } | null =>
  livePool === null ? null : { size: livePool.totalCount, idle: livePool.idleCount, waiting: livePool.waitingCount };

export const PgLive: Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, unknown, AppConfig> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    /**
     * The same client as before, built on a pool this module owns. Every transform is carried over
     * verbatim — the codebase's queries are written in camelCase and the schema is snake_case, so a
     * dropped transform would not fail to compile, it would fail at runtime on every query.
     */
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
  }),
}).pipe(Layer.provide(NodeContext.layer));

/** Runs migrations, then exposes the client. */
export const DatabaseLive = Layer.provideMerge(MigrationsLive, PgLive).pipe(Layer.provideMerge(PgLive));
