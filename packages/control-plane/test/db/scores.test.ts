/**
 * The score store (spec 2026-08-26, D1): identity, upsert-on-re-run, the Langfuse mirror, and the
 * refusal to store a record that contradicts its own name's data type.
 *
 * Asserted on the external seams, not the SQL: what comes back out of `listForConversation`, and
 * what the recording `Tracing` was handed. A score reaching Postgres but not Langfuse (or the other
 * way round) is exactly the drift the one-writer design exists to prevent, so both are checked
 * together on every write.
 */
import { Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { booleanScore, numericScore } from "@feather-lite/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepo, IdGen, Orchestrator, Queries, ScoresRepo, Scores, ScriptedTurnDeciderLive, WorkflowService, FROZEN_NOW, RecordingTracing } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const recording = RecordingTracing();

const layer = Layer.mergeAll(Scores.Default, ScoresRepo.Default, WorkflowService.Default, Orchestrator.Default, Queries.Default, ConversationRepo.Default, IdGen.Default).pipe(
  Layer.provide(ScriptedTurnDeciderLive),
  // Over the top of the infra layer's Noop, so every score written below is also captured.
  Layer.provideMerge(recording.layer),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

const seedConversation = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Score Subject", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555000${Math.floor(Math.random() * 9000 + 1000)}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  const wf = yield* WorkflowService;
  const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: FROZEN_NOW });
  return started.conversationId;
});

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("conversation scores", () => {
  it("writes a score to the ledger and hands the same values to Tracing", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const conversationId = yield* seedConversation;
        const scores = yield* Scores;
        const written = yield* scores.recordMany([
          booleanScore(conversationId, "compliance.mini_miranda_first", true, "EVALUATOR", { comment: "first agent line carries the disclosure" }),
          numericScore(conversationId, "stt.wer", 0.042, "HARNESS", { turnId: "turn-1" }),
        ]);
        const rows = yield* scores.listForConversation(conversationId);
        return { conversationId, written, rows };
      }),
    );

    expect(out.written).toBe(2);
    expect(out.rows.map((r) => [r.name, r.value, r.dataType, r.source, r.turnId])).toEqual([
      ["compliance.mini_miranda_first", 1, "BOOLEAN", "EVALUATOR", null],
      ["stt.wer", 0.042, "NUMERIC", "HARNESS", "turn-1"],
    ]);
    expect(out.rows[0]!.comment).toBe("first agent line carries the disclosure");

    const mirrored = recording.scores.filter((s) => s.conversationId === out.conversationId);
    expect(mirrored.map((s) => [s.name, s.value, s.dataType, s.turnId])).toEqual([
      ["compliance.mini_miranda_first", 1, "BOOLEAN", null],
      ["stt.wer", 0.042, "NUMERIC", "turn-1"],
    ]);
  });

  it("upserts on a re-run instead of appending a second opinion", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const conversationId = yield* seedConversation;
        const scores = yield* Scores;
        yield* scores.record(booleanScore(conversationId, "judge.overall_pass", false, "JUDGE", { comment: "no read-back" }));
        // Same (conversation, turn, name, source): a re-judge corrects the verdict in place.
        yield* scores.record(booleanScore(conversationId, "judge.overall_pass", true, "JUDGE", { comment: "read-back was heard in full" }));
        // A different source on the same name is a different score — this is what agreement compares.
        yield* scores.record(booleanScore(conversationId, "human.overall_pass", true, "HUMAN"));
        const rows = yield* scores.listForConversation(conversationId);
        return rows;
      }),
    );

    const judge = out.filter((r) => r.name === "judge.overall_pass");
    expect(judge).toHaveLength(1);
    expect(judge[0]!.value).toBe(1);
    expect(judge[0]!.comment).toBe("read-back was heard in full");
    expect(out.filter((r) => r.name === "human.overall_pass")).toHaveLength(1);
  });

  it("keeps a call-level and a turn-level score of the same name apart", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const conversationId = yield* seedConversation;
        const scores = yield* Scores;
        yield* scores.recordMany([
          numericScore(conversationId, "stt.wer", 0.1, "HARNESS"),
          numericScore(conversationId, "stt.wer", 0.2, "HARNESS", { turnId: "turn-1" }),
          numericScore(conversationId, "stt.wer", 0.3, "HARNESS", { turnId: "turn-2" }),
        ]);
        return yield* scores.listForConversation(conversationId);
      }),
    );
    // NULLS NOT DISTINCT on the identity index: the call-level row is one row, not merged with the
    // turn-level ones and not duplicated by them.
    expect(out.map((r) => [r.turnId, r.value])).toEqual([
      [null, 0.1],
      ["turn-1", 0.2],
      ["turn-2", 0.3],
    ]);
  });

  it("rejects a value that contradicts its name's data type, and keeps the rest of the batch", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const conversationId = yield* seedConversation;
        const scores = yield* Scores;
        const written = yield* scores.recordMany([
          // BOOLEAN scores must be 1 or 0 — Langfuse drops anything else silently, so it is caught here.
          { conversationId, turnId: null, name: "judge.overall_pass", value: 0.7, source: "JUDGE" },
          numericScore(conversationId, "scenario.pass_rate", 0.95, "SCENARIO"),
        ]);
        const rows = yield* scores.listForConversation(conversationId);
        return { written, rows };
      }),
    );
    expect(out.written).toBe(1);
    expect(out.rows.map((r) => r.name)).toEqual(["scenario.pass_rate"]);
  });
});
