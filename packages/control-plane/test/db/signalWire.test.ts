/**
 * The signal endpoint end to end: JSON in, `conversation_turns.result` out. The worker's unit tests
 * assert the body it posts and the orchestrator's assert what it stores, and neither would notice a
 * decoder that mapped one field onto another's name.
 */
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiLive,
  AppConfigTest,
  ConversationRepo,
  IdGen,
  LiveKitMediaPlaneLive,
  Metrics,
  Orchestrator,
  ProcessMetricsLive,
  ScriptedTurnDeciderLive,
  securityMiddleware,
  ServicesLive,
  WorkflowService,
  FROZEN_NOW,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const scope = Effect.runSync(Scope.make());
const middlewareContext = Effect.runSync(Scope.extend(Layer.build(Layer.mergeAll(AppConfigTest(), Metrics.Default)), scope));

const web = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
    Layer.provide(ProcessMetricsLive({ pgPool: () => null, sseStreams: () => 0, liveTurns: () => 0, rateLimitBuckets: () => 0 })),
    Layer.provideMerge(ServicesLive.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(LiveKitMediaPlaneLive))),
    Layer.provideMerge(makeInfraLayer()),
  ),
  { middleware: (app) => securityMiddleware(app).pipe(Effect.provide(middlewareContext)) },
);

const layer = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(ScriptedTurnDeciderLive),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await web.dispose();
  await rt.dispose();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const aVoiceCallWithOneTurn = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550007701", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
  yield* (yield* Orchestrator).processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is Jordan" }, () => Effect.void);
  return started.conversationId;
});

const resultOf = (conversationId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly result: Record<string, unknown> }>`
      SELECT result FROM conversation_turns WHERE conversation_id = ${conversationId} AND turn_id = 't1'`;
    return rows[0]?.result ?? {};
  });

describe("the signal endpoint's turn_metrics body", () => {
  it("lands each field on the turn under its own name", async () => {
    const conversationId = await rt.runPromise(aVoiceCallWithOneTurn);
    const res = await web.handler(
      new Request(`http://localhost/api/conversations/${conversationId}/signal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn_metrics",
          turn_id: "t1",
          eou_delay_ms: 578,
          transcription_delay_ms: 522,
          tts_ttfb_ms: 385,
          tts_audio_ms: 8100,
          tts_chars: 111,
          // Deliberately all different, so a decoder that crossed two of them shows up as a value in
          // the wrong column rather than as a passing test.
          eou_probability: 0.87,
          eou_threshold: 0.36,
          eou_inference_ms: 21,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const result = await rt.runPromise(resultOf(conversationId));
    expect(result["eou_delay_ms"]).toBe(578);
    expect(result["transcription_delay_ms"]).toBe(522);
    expect(result["tts_ttfb_ms"]).toBe(385);
    expect(result["tts_audio_ms"]).toBe(8100);
    expect(result["tts_chars"]).toBe(111);
    expect(result["eou_probability"]).toBe(0.87);
    expect(result["eou_threshold"]).toBe(0.36);
    expect(result["eou_inference_ms"]).toBe(21);
  }, 30_000);
});
