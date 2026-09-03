import { Effect } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, describe, expect, it } from "vitest";
import { makeInfraLayer, makeRuntime } from "./harness.js";

const rt = makeRuntime(makeInfraLayer());

/** No such extension on any Postgres, so this is the "not available" case everywhere. */
const MISSING = "feather_lite_no_such_extension";

afterAll(async () => {
  await rt.dispose();
});

describe("migration 0005 on a Postgres without pg_stat_statements", () => {
  it("keeps migrating after the extension is refused", async () => {
    const ok = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE EXTENSION IF NOT EXISTS ${sql.unsafe(MISSING)}`.pipe(
                sql.withTransaction,
                Effect.catchAll(() => Effect.logWarning("pg_stat_statements is not available")),
              );
              yield* sql`ALTER TABLE conversations SET (fillfactor = 80)`;
              const rows = yield* sql<{ ok: number }>`SELECT 1 AS ok`;
              return rows[0]?.ok;
            }),
          )
          .pipe(Effect.provideService(PgClient.PgClient, sql));
      }),
    );
    expect(ok).toBe(1);
  });

  it("is poisoned without the savepoint, which is why the savepoint is there", async () => {
    const outcome = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // The shape before the fix: the Effect error is caught, the session is not.
              yield* sql`CREATE EXTENSION IF NOT EXISTS ${sql.unsafe(MISSING)}`.pipe(Effect.catchAll(() => Effect.void));
              yield* sql`ALTER TABLE conversations SET (fillfactor = 80)`;
            }),
          )
          .pipe(
            Effect.as("boots" as const),
            // `SqlError`'s own message is generic; the Postgres one is on its cause.
            Effect.catchAll((e: { cause?: unknown }) => Effect.succeed(String(e.cause ?? e))),
            Effect.provideService(PgClient.PgClient, sql),
          );
      }),
    );
    expect(outcome).not.toBe("boots");
    expect(String(outcome)).toMatch(/current transaction is aborted/i);
  });
});
