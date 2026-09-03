import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import pg from "pg";
import { AppConfigTest, DatabaseLive, Metrics, NoLlmClientLive, NoopTracingLive, Queries } from "../../src/index.js";
import type { AppConfigShape } from "../../src/index.js";

/** Tests use their own `<db>_test` database so a run never wipes dev or demo data. */
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
 * Metrics is merged once so every service under test writes to the same instance; the counters only
 * add up if the decider and the orchestrator share one. The LLM client refuses by default so a test
 * that has not explicitly asked for a model cannot reach one.
 */
export const makeInfraLayer = (overrides: Partial<AppConfigShape> = {}) =>
  Layer.unwrapEffect(
    ensureTestDatabase.pipe(
      Effect.map(() =>
        Layer.mergeAll(DatabaseLive, NoopTracingLive, NoLlmClientLive, Metrics.Default).pipe(Layer.provideMerge(AppConfigTest({ databaseUrl: Redacted.make(testUrl), ...overrides }))),
      ),
    ),
  );

export const truncateAll = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`TRUNCATE TABLE
    conversation_scores, conversation_liveness, conversation_turns, conversation_events, outbox_jobs, scheduled_actions, conversations, call_attempts,
    workflow_executions, loans, borrower_contact_points, contact_points, borrowers, agent_versions, agent_heartbeats
    RESTART IDENTITY CASCADE`;
});

export const makeRuntime = <R, E>(layer: Layer.Layer<R, E, never>) => ManagedRuntime.make(layer);

/**
 * The fully-heard guard refuses to record a promise nothing reports as heard, so a fixture driving
 * one must report playout. The text is read back out of the ledger rather than written into the
 * fixture, so the report says what the agent actually said.
 */
export const playoutOfAgentTurn = (conversationId: string, turnId: string) =>
  Effect.gen(function* () {
    const detail = yield* (yield* Queries).conversationDetail(conversationId);
    const agentTurn = detail.events.find((e) => e.type === "AGENT_TURN" && e.payload.turn_id === turnId);
    return { turnId, heardText: agentTurn?.type === "AGENT_TURN" ? agentTurn.payload.text : "", interrupted: false } as const;
  });
