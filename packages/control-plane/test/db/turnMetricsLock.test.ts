/**
 * A `turn_metrics` signal does not queue behind the turn it is describing (C7).
 *
 * The worker posts this a few hundred milliseconds after a turn's audio finishes, carrying that
 * turn's EOU, transcription and TTS numbers. `processSignal` took the conversation's `FOR UPDATE`
 * lock and read the whole ledger before looking at what kind of signal it had — and this one needs
 * neither: it merges one idempotent patch into `conversation_turns` and hands the same numbers to
 * the tracer.
 *
 * On a barge-in it arrives exactly when the *next* turn's T1 holds that lock, so pure telemetry
 * waited on the live path, holding a pool connection while it waited.
 *
 * The seam is that contention, made deterministic: a transaction elsewhere holds the row lock, and
 * the signal has to complete anyway.
 */
import { DateTime, Effect, Fiber, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepo, IdGen, Orchestrator, Queries, ScriptedTurnDeciderLive, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(ScriptedTurnDeciderLive),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("a turn_metrics signal arriving while the conversation row is locked", () => {
  it("records the turn's latency numbers instead of waiting for the lock", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = yield* IdGen;
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550009001", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
        const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
        const orch = yield* Orchestrator;
        // One real turn, so there is a `conversation_turns` row for the metrics to merge into.
        yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);

        // Somebody else holds the row lock — a barge-in's T1, in the case this is about.
        const holder = yield* Effect.fork(
          sql.withTransaction(
            sql`SELECT id FROM conversations WHERE id = ${started.conversationId} FOR UPDATE`.pipe(Effect.zipRight(Effect.sleep("3 seconds"))),
          ),
        );
        yield* Effect.sleep("300 millis");

        // The signal, with a bound well under the lock's lifetime: before C7 this waits on the lock
        // and times out, because it takes `FOR UPDATE` on the same row.
        const signalled = yield* orch
          .processSignal(started.conversationId, { kind: "turn_metrics", turnId: "t1", eouDelayMs: 578, transcriptionDelayMs: 522, ttsTtfbMs: 385 })
          .pipe(Effect.timeout("1500 millis"), Effect.either);

        yield* Fiber.join(holder);
        const turns = yield* sql<{ readonly result: Record<string, unknown> }>`
          SELECT result FROM conversation_turns WHERE conversation_id = ${started.conversationId} AND turn_id = 't1'`;
        return { signalled, result: turns[0]?.result ?? {} };
      }),
    );

    expect(out.signalled._tag).toBe("Right");
    // And it recorded what it came to record.
    expect(out.result["eou_delay_ms"]).toBe(578);
    expect(out.result["transcription_delay_ms"]).toBe(522);
    expect(out.result["tts_ttfb_ms"]).toBe(385);
  }, 30_000);
});
