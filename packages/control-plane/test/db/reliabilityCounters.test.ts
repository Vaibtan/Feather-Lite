/**
 * Reliability counts and provider events (spec 2026-08-26, D6).
 *
 * The five conversation-loop counts are derived from committed events, so what is worth asserting
 * is that driving the real orchestrator down each failure path moves the right count — and that the
 * count agrees with the ledger it is derived from, rather than with a constant in this file. The
 * provider-event ring is in-process (a retried vendor socket is not a ledger event) and is asserted
 * through the `Metrics` seam, which is what `/api/system/status` reads.
 */
import { DateTime, Effect, Layer, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppConfigTest,
  ConversationRepo,
  FailingTurnDeciderLive,
  IdGen,
  LlmClient,
  Metrics,
  NoopTracingLive,
  OpenAITurnDeciderLive,
  Orchestrator,
  Queries,
  ScriptedTurnDeciderLive,
  TurnDecider,
  TurnDeciderUnavailable,
  WorkflowService,
  withFrozenClock,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");

const baseServices = Layer.mergeAll(Orchestrator.Default, WorkflowService.Default, Queries.Default, ConversationRepo.Default, IdGen.Default);
const rt = makeRuntime(baseServices.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(makeInfraLayer())));
/** A second runtime whose decider always fails, for the DECIDER_UNAVAILABLE path. */
const failingRt = makeRuntime(
  baseServices.pipe(Layer.provide(FailingTurnDeciderLive(new TurnDeciderUnavailable({ detail: "provider down" }))), Layer.provideMerge(makeInfraLayer())),
);

const seedBorrower = (name: string, phone: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    return { borrowerId, cpId };
  });

const reliability = Effect.gen(function* () {
  return (yield* (yield* Queries).ledgerCounts()).reliability as Readonly<Record<string, number>>;
});

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
  await failingRt.dispose();
});

describe("reliability counts (from the ledger)", () => {
  it("counts a TTS-silent playout and a no-input close", async () => {
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const before = yield* reliability;
          const { borrowerId, cpId } = yield* seedBorrower("Silent Person", "+15550004001");
          const wf = yield* WorkflowService;
          const orch = yield* Orchestrator;
          const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
          // Exactly how the worker reports a TTS stream that produced no frames (ADR 0008): the
          // borrower heard nothing, whatever the chat item claimed.
          yield* orch.processSignal(started.conversationId, { kind: "playout", turnId: "t1", heardText: "", interrupted: true });
          // A turn the borrower superseded before the agent replied reports the very same shape and
          // is NOT a TTS failure -- nothing was heard because nothing was synthesised. Measured on a
          // fleet run, where counting these put the silent-playout rate at 22% against one real
          // failure in eighteen turns. The supersession is written straight to the ledger rather
          // than raced into existence: what needs proving here is that the SQL agrees with the
          // domain predicate, and the race itself is already covered by concurrency.test.ts.
          const conv = yield* ConversationRepo;
          yield* orch.processSignal(started.conversationId, { kind: "playout", turnId: "t2", heardText: "", interrupted: true });
          yield* conv.lockConversation(started.conversationId);
          yield* conv.appendEvent({
            id: yield* (yield* IdGen).next(),
            conversationId: started.conversationId,
            event: { type: "TURN_SUPERSEDED", payload: { turn_id: "t2", superseded_by: "t3" } },
            createdAt: DateTime.toDateUtc(NOW),
          });
          // Two strikes close the call.
          yield* orch.processNoInput(started.conversationId);
          yield* orch.processNoInput(started.conversationId);
          return { before, after: yield* reliability };
        }),
      ),
    );
    const delta = (k: string) => (out.after[k] ?? 0) - (out.before[k] ?? 0);
    expect(delta("tts_silent_playouts")).toBe(1);
    expect(delta("no_input_closes")).toBe(1);
  });

  it("counts a read-back repeated because the borrower heard silence", async () => {
    // The ADR 0008 failure mode: the read-back's playout says it was not heard in full, the
    // fully-heard guard refuses the promise, and the agent repeats itself. The same event type and
    // reason is also raised when the model asks to record a promise that was never proposed — the
    // opposite situation — which is why the count keys off the rejection detail.
    const out = await rt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const before = yield* reliability;
          const { borrowerId, cpId } = yield* seedBorrower("Unheard Person", "+15550004003");
          const wf = yield* WorkflowService;
          const orch = yield* Orchestrator;
          const q = yield* Queries;
          const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
          yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is speaking" }, () => Effect.void);
          // t2 proposes and speaks the read-back...
          yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t2", userText: "I can pay 550 on Friday" }, () => Effect.void);
          // ...which the borrower did not hear in full.
          yield* orch.processSignal(started.conversationId, { kind: "playout", turnId: "t2", heardText: "To confirm: you will pay", interrupted: true });
          yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t3", userText: "yes" }, () => Effect.void);
          const detail = yield* q.conversationDetail(started.conversationId);
          return {
            before,
            after: yield* reliability,
            rejections: detail.events.filter(
              (e) => e.type === "TOOL_REJECTED" && e.payload.name === "record_promise_to_pay" && e.payload.reason === "INVALID_ARGS" && e.payload.detail.startsWith("read-back"),
            ).length,
          };
        }),
      ),
    );
    // Tied to the ledger rather than to a constant: the count's only job is to agree with the
    // events it is derived from, and an assertion that cannot fail would not check that.
    expect(out.rejections).toBe(1);
    expect((out.after["readbacks_repeated_unheard"] ?? 0) - (out.before["readbacks_repeated_unheard"] ?? 0)).toBe(out.rejections);
  });

  it("counts a decider outage", async () => {
    const out = await failingRt.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const before = yield* reliability;
          const { borrowerId, cpId } = yield* seedBorrower("Unlucky Person", "+15550004004");
          const wf = yield* WorkflowService;
          const orch = yield* Orchestrator;
          const q = yield* Queries;
          const started = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW });
          // The decider is down, so the turn degrades to the safe fallback and the ledger records why.
          yield* orch.processTurn({ conversationId: started.conversationId, turnId: "t1", userText: "yes this is speaking" }, () => Effect.void);
          const detail = yield* q.conversationDetail(started.conversationId);
          return {
            before,
            after: yield* reliability,
            rejected: detail.events.filter((e) => e.type === "TURN_DECISION_REJECTED" && e.payload.reason === "DECIDER_UNAVAILABLE").length,
          };
        }),
      ),
    );
    expect(out.rejected).toBe(1);
    expect((out.after["decider_unavailable"] ?? 0) - (out.before["decider_unavailable"] ?? 0)).toBe(out.rejected);
  });
});

describe("provider events (in process)", () => {
  it("counts a failure by vendor and by stage, and keeps it in the recent ring", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const metrics = yield* Metrics;
        yield* metrics.providerEvent({ provider: "deepgram.STT", kind: "retry", stage: "stt", message: "websocket closed", conversationId: "c1" });
        yield* metrics.providerEvent({ provider: "deepgram.STT", kind: "retry", stage: "stt", message: "websocket closed again", conversationId: "c1" });
        yield* metrics.providerEvent({ provider: "openai:gpt-4.1", kind: "error", stage: "llm", message: "502", conversationId: "c2" });
        return yield* metrics.providerEvents();
      }),
    );
    // By vendor answers "who is degrading"; by stage answers "what broke". One number cannot.
    expect(out.counters["provider_deepgram.STT_retry"]).toBe(2);
    expect(out.counters["provider_stage_stt_retry"]).toBe(2);
    expect(out.counters["provider_openai:gpt-4.1_error"]).toBe(1);
    expect(out.counters["provider_stage_llm_error"]).toBe(1);
    // Newest first, so the status page leads with what just broke.
    expect(out.recent[0]?.message).toBe("502");
    expect(out.recent.map((e) => e.provider)).toEqual(["openai:gpt-4.1", "deepgram.STT", "deepgram.STT"]);
  });

  it("labels an OpenAI transport failure a retry exactly when the decider will retry it", async () => {
    // D6: "Control plane counts its own OpenAI retries/failures the same way." The decider retries
    // once, but only before any output has reached the caller, so the same predicate that decides
    // the retry decides the label — a failure counted as a retry is one that actually gets retried.
    const alwaysFails = Layer.succeed(LlmClient, {
      name: "gpt-test",
      stream: () => Stream.fail(new TurnDeciderUnavailable({ detail: "connection reset" })),
      complete: () => Effect.die("this test never takes the non-streaming path"),
    });
    // `provideMerge`, not two separate `provide`s: the decider and this test must read the same
    // Metrics instance, and two builds of `Metrics.Default` are two different maps.
    const deciderLayer = OpenAITurnDeciderLive.pipe(
      Layer.provide(alwaysFails),
      Layer.provide(NoopTracingLive),
      Layer.provide(AppConfigTest()),
      Layer.provideMerge(Metrics.Default),
    );
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const decider = yield* TurnDecider;
        yield* Stream.runCollect(
          decider.decide({
            conversationId: "c-openai",
            turnId: "t1",
            state: "GREETING",
            model: "gpt-test",
            userText: "hello",
            heardAgentText: null,
            context: {
              publicContext: {
                agent_name: "Ava",
                company: "Feather-Lite Collections",
                callback_number: "+1 800 555 0100",
                workflow_type: "PAYMENT_REMINDER",
                attempt_no: 1,
                local_time_description: "Friday, 21 August 2026, 2:05 PM",
                borrower_first_name: "Jordan",
              },
              protectedContext: null,
              memory: null,
            },
            allowedTools: [],
            pendingProposal: null,
            recentTranscript: [],
            borrowerLocalDate: "2026-08-16",
            borrowerTimeZone: "America/New_York",
            borrowerFirstName: "Jordan",
          }),
        ).pipe(Effect.either);
        return yield* (yield* Metrics).providerEvents();
      }).pipe(Effect.provide(deciderLayer)),
    );
    // Two attempts — the original and the one retry — both before any output reached the caller.
    expect(out.counters["provider_openai:gpt-test_retry"]).toBe(2);
    expect(out.counters["provider_stage_llm_retry"]).toBe(2);
    expect(out.recent[0]?.message).toContain("connection reset");
  });
});
