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
import { makeInfraLayer, makeRuntime, playoutOfAgentTurn, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

const services = Layer.mergeAll(Quality.Default, Queries.Default, Orchestrator.Default, WorkflowService.Default, Scores.Default, ScoresRepo.Default, ConversationRepo.Default, SchedulingRepo.Default, IdGen.Default);
const layer = services.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

// These fixtures are a handful of calls, so the production minimum sample of 20 would report `insufficient_sample` everywhere; this runtime lowers it to 1 so a breach is assertable.
const SLO_TARGETS = { turnP95Ms: 2500, eouP95Ms: 700, transcriptionP95Ms: 600, ttftP95Ms: 1500, ttsTtfbP95Ms: 600 };
const smallSampleRt = makeRuntime(
  services.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer({ slo: { ...SLO_TARGETS, minSample: 1 } }))),
);

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

const promiseCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    const orch = yield* Orchestrator;
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is speaking" }, () => Effect.void);
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
    // Without a reported read-back the fully-heard guard refuses to record a promise on a voice call.
    const playout = yield* playoutOfAgentTurn(started.conversationId, "t2");
    yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "yes", playout }, () => Effect.void);
    return started.conversationId;
  });

const noAnswerCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    yield* (yield* Orchestrator).processSignal(started.conversationId, { kind: "no_answer" });
    return started.conversationId;
  });

const voicemailCall = (name: string) =>
  Effect.gen(function* () {
    const { borrowerId, cpId } = yield* seedBorrower(name);
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
    // AMD reporting a machine finalizes the call by itself, so there is nothing left to signal after.
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
    expect(f.connected).toBe(2);
    expect(f.voicemail).toBe(1);
    expect(f.right_party).toBe(2);
    expect(f.promise_to_pay).toBe(2);
    expect(f.rates.contact).toBe(0.5);
    expect(f.rates.right_party).toBe(1);
    expect(f.rates.promise).toBe(1);
    expect(f.rates.voicemail).toBe(0.25);
    expect(f.finished).toBe(4);
    expect(f.in_progress).toBe(0);
    expect(out.report.window.conversations).toBe(4);
  });

  it("does not count a call that is still running as one a person answered", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* promiseCall("Finished And Answered");
          yield* noAnswerCall("Finished And Not Answered");
          const before = yield* (yield* Quality).report({ calls: 50 });
          for (const name of ["Still Ringing One", "Still Ringing Two", "Still Ringing Three"]) {
            const id = yield* promiseCall(name);
            yield* sql`UPDATE conversations SET final_outcome = NULL, ended_at = NULL WHERE id = ${id}`;
          }
          const after = yield* (yield* Quality).report({ calls: 50 });
          return { before, after };
        }),
      ),
    );
    // Deltas, not absolutes: this suite shares one database and earlier tests leave calls in the window.
    expect(out.after.funnel.attempts).toBe(out.before.funnel.attempts + 3);
    expect(out.after.funnel.in_progress).toBe(out.before.funnel.in_progress + 3);
    expect(out.after.funnel.finished).toBe(out.before.funnel.finished);
    expect(out.after.funnel.connected).toBe(out.before.funnel.connected);
    expect(out.after.funnel.rates.contact).toBe(out.before.funnel.rates.contact);
    expect(out.after.funnel.finished + out.after.funnel.in_progress).toBe(out.after.funnel.attempts);
  });

  it("ages each promise against the clock and names the missing input", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = yield* promiseCall("Overdue Person");
          // Backdated because the scripted decider always promises the same near date.
          yield* sql`UPDATE conversations SET final_outcome_metadata = jsonb_set(final_outcome_metadata, '{promised_date}', '"2026-08-01"') WHERE id = ${id}`;
          const report = yield* (yield* Quality).report({ calls: 50 });
          return { id, report };
        }),
      ),
    );
    const row = out.report.promises.find((p) => p.conversation_id === out.id);
    expect(row?.status).toBe("OVERDUE");
    expect(row?.amount).toBe("550.00");
    expect(Object.keys(row ?? {})).not.toContain("kept");
  });

  it("passes the SLO when a window has no voice turns to measure, and names the breach when it does", async () => {
    const out = await smallSampleRt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const quality = yield* Quality;
          const clean = yield* quality.report({ calls: 50 });
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
    expect(out.clean.slo.components["eou_delay_ms"]?.status).toBe("not_measured");
    expect(out.breached.slo.pass).toBe(false);
    expect(out.breached.slo.breaches).toContain("eou_delay_ms");
    expect(out.breached.slo.measured["eou_delay_ms"]).toBe(9000);
    expect(out.breached.slo.components["eou_delay_ms"]?.status).toBe("breach");
  });

  it("withholds a verdict, and the p95, below the minimum sample", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const quality = yield* Quality;
          const id = yield* promiseCall("Barely Sampled");
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000}'::jsonb WHERE conversation_id = ${id}`;
          return yield* quality.report({ calls: 50 });
        }),
      ),
    );
    const eou = out.slo.components["eou_delay_ms"];
    expect(out.slo.min_sample).toBe(20);
    expect(eou?.n).toBeGreaterThan(0);
    expect(eou?.n).toBeLessThan(20);
    expect(eou?.status).toBe("insufficient_sample");
    expect(eou?.measured_ms).toBeNull();
    expect(out.slo.insufficient).toContain("eou_delay_ms");
    expect(out.slo.breaches).not.toContain("eou_delay_ms");
  });

  it("keeps a simulator call out of the real-call SLO window", async () => {
    // Asserted against `latencyAggregateForSegment` with two rows differing only in `harness`: driving it through `sloStatus` would exclude the simulator row for a different reason and still pass with the filter removed.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const queries = yield* Queries;
          const real = yield* seedBorrower("Real Caller");
          const simulated = yield* seedBorrower("Sim Caller");
          const wf = yield* WorkflowService;
          const a = yield* wf.startCall({ borrowerId: real.borrowerId, contactPointId: real.cpId, channel: "voice", now: NOW });
          const b = yield* wf.startCall({ borrowerId: simulated.borrowerId, contactPointId: simulated.cpId, channel: "voice", harness: "sim", now: NOW });
          yield* sql`UPDATE conversations SET decider = 'openai' WHERE id IN (${a.conversationId}, ${b.conversationId})`;

          const def = yield* queries.latencyAggregateForSegment({ channel: "voice", decider: "openai" }, 50);
          const sim = yield* queries.latencyAggregateForSegment({ channel: "voice", decider: "openai", harness: "sim" }, 50);
          // Reverted before leaving: these rows are `voice` + `openai`, which the next test asserts is empty, and the file shares one database.
          yield* sql`UPDATE conversations SET decider = 'scripted' WHERE id IN (${a.conversationId}, ${b.conversationId})`;
          return { def: def.found, sim: sim.found };
        }),
      ),
    );
    expect(out.def).toBe(1);
    expect(out.sim).toBe(1);
  });

  it("keeps a scripted load run out of the voice segment's SLO window", async () => {
    const out = await smallSampleRt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const quality = yield* Quality;
          yield* promiseCall("Scripted Noise");
          const voice = yield* quality.sloStatus(50);
          const unsegmented = yield* quality.sloStatus(50, { channel: null, decider: null });
          return { voice, unsegmented };
        }),
      ),
    );
    expect(out.voice.segment).toMatchObject({ channel: "voice", decider: "openai", calls_requested: 50 });
    expect(out.voice.segment.calls_found).toBe(0);
    expect(out.voice.components["ttft_ms"]?.status).toBe("not_measured");
    expect(out.unsegmented.segment.calls_found).toBeGreaterThan(0);
    expect(out.unsegmented.components["ttft_ms"]?.n).toBeGreaterThan(0);
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
    expect(out.judge_agreement.judged).toBe(2);
    expect(out.judge_agreement.human_labelled).toBe(1);
    expect(out.judge_agreement.both).toBe(1);
    expect(out.judge_agreement.agreed).toBe(1);
    expect(out.judge_agreement.rate).toBe(1);
    expect(out.stt_wer.n).toBe(2);
    expect(out.stt_wer.p50).toBeGreaterThan(0);
    const judge = out.scores.find((s) => s.name === "judge.overall_pass");
    expect(judge?.n).toBe(2);
    expect(judge?.pass_rate).toBe(0.5);
    expect(out.scores.find((s) => s.name === "stt.wer")?.pass_rate).toBeNull();
  });

  it("measures the SLO over the report's own window, not over the last N calls", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const slow = yield* promiseCall("Outside The Range");
          yield* sql`UPDATE conversation_turns SET result = COALESCE(result, '{}'::jsonb) ||
                       '{"eou_delay_ms": 9000, "transcription_delay_ms": 400, "tts_ttfb_ms": 300}'::jsonb
                     WHERE conversation_id = ${slow}`;
          yield* sql`UPDATE conversations SET started_at = '2026-08-16T14:00:00Z' WHERE id = ${slow}`;
          return yield* (yield* Quality).report({ from: "2026-08-14T00:00:00Z", to: "2026-08-15T00:00:00Z" });
        }),
      ),
    );
    expect(out.window.conversations).toBe(0);
    expect(out.slo.measured["eou_delay_ms"]).toBeNull();
    expect(out.slo.breaches).toEqual([]);
    // A window with nothing in it has no verdict to give, so not a pass; this assertion used to pin the opposite.
    expect(out.slo.verdict).toBe("insufficient");
    expect(out.slo.pass).toBe(false);
  });

  it("answers an empty window without inventing rates", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(Effect.gen(function* () {
        return yield* (yield* Quality).report({ from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z" });
      })),
    );
    expect(out.window.conversations).toBe(0);
    expect(out.funnel.attempts).toBe(0);
    expect(out.funnel.rates.contact).toBeNull();
    expect(out.judge_agreement.rate).toBeNull();
    expect(out.stt_wer.p50).toBeNull();
    expect(out.tts.turns).toBe(0);
    expect(out.tts.silent_playout_rate).toBeNull();
    expect(out.tts.chars_per_second.median).toBeNull();
  });

  it("flags a speaking rate far from the window's own median, without claiming the speech was bad", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = yield* promiseCall("Spoken At Speed");
          // Applied to the turn rows directly: what is under test is the aggregation, not the worker signal path.
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
    expect(out.tts.silent_playout_rate).toBe(0);
  });
});
