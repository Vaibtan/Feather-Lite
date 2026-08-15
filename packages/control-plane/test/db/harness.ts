/**
 * DB test harness: one ManagedRuntime per test file over the real Postgres (docker-compose,
 * DATABASE_URL). Migrations run on first use; `truncateAll` resets data between files.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { PgClient } from "@effect/sql-pg";
import { AppConfigTest, DatabaseLive } from "../../src/index.js";
import type { AppConfigShape } from "../../src/index.js";

export const makeInfraLayer = (overrides: Partial<AppConfigShape> = {}) =>
  DatabaseLive.pipe(Layer.provideMerge(AppConfigTest(overrides)));

export const truncateAll = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`TRUNCATE TABLE
    conversation_turns, conversation_events, outbox_jobs, scheduled_actions, conversations, call_attempts,
    workflow_executions, loans, borrower_contact_points, contact_points, borrowers, agent_versions, agent_heartbeats
    RESTART IDENTITY CASCADE`;
});

export const makeRuntime = <R, E>(layer: Layer.Layer<R, E, never>) => ManagedRuntime.make(layer);
