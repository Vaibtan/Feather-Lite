/**
 * The Quality report (spec 2026-08-26, D7 + D8): the funnel over a known history, promise ageing,
 * the SLO verdict, and judge/human agreement.
 *
 * Built on real conversations driven through the real orchestrator, so the funnel is counting the
 * same ledger the console shows rather than rows a fixture asserted into place. The known counts
 * come from the outcomes the scripted decider produces, which the scenario suite already pins.
 */
import { DateTime, Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { booleanScore, numericScore } from "@feather-lite/domain";
import {
  ConversationRepo,
  IdGen,
  Orchestrator,
  Quality,
  Queries,
  SchedulingRepo,
  Scores,
  ScoresRepo,
  ScriptedTurnDeciderLive,
  WorkflowService,
  withFrozenClock,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

const layer = Layer.mergeAll(Quality.Default, Queries.Default, Orchestrator.Default, WorkflowService.Default, Scores.Default, ScoresRepo.Default, ConversationRepo.Default, SchedulingRepo.Default, IdGen.Default).pipe(
  Layer.provide(ScriptedTurnDeciderLive),
  Layer.provideMerge(makeInfraLayer()),
);
const rt = makeRuntime(layer);

let phone = 6000;
const seedBorrower = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    phone += 1;
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555000${phone}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    return { borrowerId, cpId };
  });

/** Drive one call to a promise to pay, through the real three-phase turn. */
const promiseCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    const orch = yield* Orchestrator;
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is speaking" }, () => Effect.void);
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "yes" }, () => Effect.void);
    return started.conversationId;
  });

/** A call nobody ever answered. */
const noAnswerCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    yield* (yield* Orchestrator).processSignal(started.conversationId, { kind: "no_answer" });
    return started.conversationId;
  });

/** A call that reached an answering machine. */
const voicemailCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    // AMD reporting a machine finalizes the call by itself (VOICEMAIL_LEFT); there is nothing left
    // to signal afterwards.
    yield* (yield* Orchestrator).processSignal(started.conversationId, { kind: "amd_result", result: "MACHINE" });
    return started.conversationId;
  });

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("quality report", () => {
  it("counts the funnel over a known history and rates each stage against the previous one", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const promises = yield* Effect.all([promiseCall("Promise One"), promiseCall("Promise Two")]);
          yield* noAnswerCall("No Answer One");
          yield* voicemailCall("Voicemail One");
          const report = yield* (yield* Quality).report({ calls: 50 });
          return { promises, report };
        }),
      ),
    );

    const f = out.report.funnel;
    expect(f.attempts).toBe(4);
    // Connected is a human picking up: not the no-answer, not the machine.
    expect(f.connected).toBe(2);
    expect(f.voicemail).toBe(1);
    expect(f.right_party).toBe(2);
    expect(f.promise_to_pay).toBe(2);
    // Rates are of the previous stage, which is how the industry reads a collections funnel.
    expect(f.rates.contact).toBe(0.5);
    expect(f.rates.right_party).toBe(1);
    expect(f.rates.promise).toBe(1);
    expect(f.rates.voicemail).toBe(0.25);
    expect(out.report.window.conversations).toBe(4);
  });

  it("ages each promise against the clock and names the missing input", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = yield* promiseCall("Overdue Person");
          // Backdate the promise: the scripted decider always promises the same near date, and what
          // is under test is the ageing, not the decider.
          yield* sql`UPDATE conversations SET final_outcome_metadata = jsonb_set(final_outcome_metadata, '{promised_date}', '"2026-08-01"') WHERE id = ${id}`;
          const report = yield* (yield* Quality).report({ calls: 50 });
          return { id, report };
        }),
      ),
    );
    const row = out.report.promises.find((p) => p.conversation_id === out.id);
    expect(row?.status).toBe("OVERDUE");
    expect(row?.amount).toBe("550.00");
    // Promise-kept would need payment data this system does not have; the report says what the
    // ledger knows and no more.
    expect(Object.keys(row ?? {})).not.toContain("kept");
  });

  it("passes the SLO when a window has no voice turns to measure, and names the breach when it does", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const quality = yield* Quality;
          const clean = yield* quality.report({ calls: 50 });
          // A component with no measurements cannot breach: these calls recorded only a decide
          // TTFT, so reporting an end-of-utterance SLO failure would be noise.
          const id = yield* promiseCall("Slow Person");
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000, "transcription_delay_ms": 400, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${id}`;
          const breached = yield* quality.report({ calls: 50 });
          return { clean, breached };
        }),
      ),
    );
    expect(out.clean.slo.pass).toBe(true);
    expect(out.clean.slo.measured["eou_delay_ms"]).toBeNull();
    // The per-stage targets exist so a regression names its own cause instead of moving one number.
    expect(out.breached.slo.pass).toBe(false);
    expect(out.breached.slo.breaches).toContain("eou_delay_ms");
    expect(out.breached.slo.measured["eou_delay_ms"]).toBe(9000);
  });

  it("reports judge/human agreement only over calls that have both labels", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const a = yield* promiseCall("Judged And Labelled");
          const b = yield* promiseCall("Judged Only");
          const scores = yield* Scores;
          yield* scores.recordMany([
            booleanScore(a, "judge.overall_pass", true, "JUDGE"),
            booleanScore(a, "human.overall_pass", true, "HUMAN"),
            booleanScore(b, "judge.overall_pass", false, "JUDGE"),
            numericScore(a, "stt.wer", 0.04, "HARNESS"),
            numericScore(b, "stt.wer", 0.06, "HARNESS"),
          ]);
          return yield* (yield* Quality).report({ calls: 50 });
        }),
      ),
    );
    // Only the call with both labels is in the denominator: an agreement number computed over
    // calls a human never looked at is not a calibration.
    expect(out.judge_agreement.judged).toBe(2);
    expect(out.judge_agreement.human_labelled).toBe(1);
    expect(out.judge_agreement.both).toBe(1);
    expect(out.judge_agreement.agreed).toBe(1);
    expect(out.judge_agreement.rate).toBe(1);
    expect(out.stt_wer.n).toBe(2);
    expect(out.stt_wer.p50).toBeGreaterThan(0);
    // Boolean scores carry a pass rate; numeric ones do not.
    const judge = out.scores.find((s) => s.name === "judge.overall_pass");
    expect(judge?.n).toBe(2);
    expect(judge?.pass_rate).toBe(0.5);
    expect(out.scores.find((s) => s.name === "stt.wer")?.pass_rate).toBeNull();
  });

  it("measures the SLO over the report's own window, not over the last N calls", async () => {
    // The regression this guards: computing the SLO from "the most recent N conversations" while
    // the funnel beside it counts a from/to range gives a page whose two halves describe different
    // calls. The slow call below is deliberately outside the range being asked about.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const slow = yield* promiseCall("Outside The Range");
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000, "transcription_delay_ms": 400, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${slow}`;
          yield* sql`UPDATE conversations SET started_at = '2026-08-16T14:00:00Z' WHERE id = ${slow}`;
          // A range that contains no calls at all: the slow one must not leak into its SLO.
          return yield* (yield* Quality).report({ from: "2026-08-14T00:00:00Z", to: "2026-08-15T00:00:00Z" });
        }),
      ),
    );
    expect(out.window.conversations).toBe(0);
    expect(out.slo.measured["eou_delay_ms"]).toBeNull();
    expect(out.slo.breaches).toEqual([]);
    expect(out.slo.pass).toBe(true);
  });

  it("answers an empty window without inventing rates", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(Effect.gen(function* () {
        return yield* (yield* Quality).report({ from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z" });
      })),
    );
    expect(out.window.conversations).toBe(0);
    expect(out.funnel.attempts).toBe(0);
    // Null, not 0: "no calls were made" and "no call reached a person" are different findings.
    expect(out.funnel.rates.contact).toBeNull();
    expect(out.judge_agreement.rate).toBeNull();
    expect(out.stt_wer.p50).toBeNull();
    // A window of no calls has no speech to describe. Reporting a silent-playout rate of 0 there
    // would read as "the voice worked on every turn", which is not what "we never checked" means.
    expect(out.tts.turns).toBe(0);
    expect(out.tts.silent_playout_rate).toBeNull();
    expect(out.tts.chars_per_second.median).toBeNull();
  });

  it("flags a speaking rate far from the window's own median, without claiming the speech was bad", async () => {
    // Spec D5. The band is measured against the window's median rather than a configured constant,
    // so this asserts the whole path: turn rows in, median out, one turn flagged.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = yield* promiseCall("Spoken At Speed");
          // Three turns at ~15 chars/s and one at 60: a truncated synthesis or a stream that
          // played out at speed. Applied to the turn rows directly — what is under test is the
          // aggregation, and the worker's signal path is already covered in evaluationJob.test.ts.
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"tts_audio_ms": 4000, "tts_chars": 60}'::jsonb
                     WHERE conversation_id = ${id}`;
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"tts_audio_ms": 1000, "tts_chars": 60}'::jsonb
                     WHERE conversation_id = ${id} AND turn_id = 't3'`;
          return yield* (yield* Quality).report({ calls: 50 });
        }),
      ),
    );
    expect(out.tts.turns).toBe(3);
    expect(out.tts.chars_per_second.median).toBe(15);
    expect(out.tts.outlier_count).toBe(1);
    expect(out.tts.outliers[0]?.turn_id).toBe("t3");
    expect(out.tts.outliers[0]?.chars_per_second).toBe(60);
    expect(out.tts.outliers[0]?.deviation).toBe(3);
    // Every turn produced audio, so nothing is silent — and the rate is 0 rather than null,
    // because here there genuinely was speech to check.
    expect(out.tts.silent_playout_rate).toBe(0);
  });
});
