/**
 * DB test harness: one ManagedRuntime per test file over the real Postgres (docker-compose,
 * DATABASE_URL). Migrations run on first use; `truncateAll` resets data between files.
 */
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import pg from "pg";
import { AppConfigTest, DatabaseLive, NoopTracingLive } from "../../src/index.js";
import type { AppConfigShape } from "../../src/index.js";

/**
 * Tests use their own database (`<db>_test`) so `pnpm test:db` never wipes dev/demo data.
 * The database is created on first use through the maintenance connection.
 */
const baseUrl = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5434/feather_lite";
const testUrl = /_test$/.test(baseUrl) ? baseUrl : `${baseUrl}_test`;
const ensureTestDatabase = Effect.promise(async () => {
  const dbName = testUrl.slice(testUrl.lastIndexOf("/") + 1);
  const maintenance = `${baseUrl.slice(0, baseUrl.lastIndexOf("/"))}/postgres`;
  const client = new pg.Client({ connectionString: maintenance });
  await client.connect();
  try {
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (r.rowCount === 0) {
      // Test files are collected in parallel; a concurrent CREATE is fine.
      await client.query(`CREATE DATABASE "${dbName}"`).catch((e: { code?: string }) => {
        if (e.code !== "42P04" && e.code !== "23505") throw e;
      });
    }
  } finally {
    await client.end();
  }
});

/**
 * Infra every DB test needs: the test database plus a no-op Tracing (the orchestrator traces every
 * turn now, and no test should be exporting spans anywhere). A test that wants to assert on what
 * was traced provides `RecordingTracing().layer` over the top.
 */
export const makeInfraLayer = (overrides: Partial<AppConfigShape> = {}) =>
  Layer.unwrapEffect(
    ensureTestDatabase.pipe(
      Effect.map(() =>
        Layer.mergeAll(DatabaseLive, NoopTracingLive).pipe(Layer.provideMerge(AppConfigTest({ databaseUrl: Redacted.make(testUrl), ...overrides }))),
      ),
    ),
  );

export const truncateAll = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`TRUNCATE TABLE
    conversation_scores, conversation_turns, conversation_events, outbox_jobs, scheduled_actions, conversations, call_attempts,
    workflow_executions, loans, borrower_contact_points, contact_points, borrowers, agent_versions, agent_heartbeats
    RESTART IDENTITY CASCADE`;
});

export const makeRuntime = <R, E>(layer: Layer.Layer<R, E, never>) => ManagedRuntime.make(layer);
