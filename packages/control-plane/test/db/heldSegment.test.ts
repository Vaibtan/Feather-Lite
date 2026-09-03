import { Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepo, IdGen, WorkflowService, FROZEN_NOW } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = Layer.mergeAll(ConversationRepo.Default, WorkflowService.Default, IdGen.Default).pipe(Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

let phone = 88000;
const startVoiceCall = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ids = yield* IdGen;
  phone += 1;
  const borrowerId = yield* ids.next();
  const cpId = yield* ids.next();
  yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
  yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: `+1555${String(phone).padStart(7, "0")}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
  yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
  yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
  return yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: FROZEN_NOW });
});

const append = (conversationId: string, event: { type: string; payload: Record<string, unknown> }) =>
  Effect.gen(function* () {
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;
    yield* conv.appendEvent({ id: yield* ids.next(), conversationId, event: event as never, createdAt: new Date() });
  });

const say = (conversationId: string, turnId: string, mode: "interruptible" | "non_interruptible") =>
  append(conversationId, { type: "AGENT_TURN", payload: { text: "To confirm...", state: "CONFIRMING_OUTCOME", turn_id: turnId, speak_mode: mode } });

const playout = (conversationId: string, turnId: string) =>
  append(conversationId, { type: "AGENT_TURN_PLAYOUT", payload: { turn_id: turnId, heard_text: "To confirm...", interrupted: false } });

describe("unreportedNonInterruptible", () => {
  it("finds a non-interruptible segment with no playout behind it", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "rb-1", "non_interruptible");
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out?.turnId).toBe("rb-1");
    expect(out?.channel).toBe("voice");
    // Not known while it is still playing: it arrives on the later `turn_metrics` signal.
    expect(out?.ttsAudioMs).toBeNull();
  });

  it("finds nothing once the playout report lands", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "rb-1", "non_interruptible");
        yield* playout(started.conversationId, "rb-1");
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out).toBeNull();
  });

  it("ignores an interruptible segment, which the borrower is free to talk over", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "chat-1", "interruptible");
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out).toBeNull();
  });

  it("takes the latest one, not the first", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "rb-1", "non_interruptible");
        yield* say(started.conversationId, "rb-2", "non_interruptible");
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out?.turnId).toBe("rb-2");
  });

  it("reports the segment's audio length once the metrics signal has recorded it", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "rb-1", "non_interruptible");
        yield* sql`INSERT INTO conversation_turns ${sql.insert({ conversationId: started.conversationId, turnId: "rb-1", status: "DONE", userText: "", startedAt: new Date(), result: sql.json({ tts_audio_ms: 8100 }) })}`;
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out?.ttsAudioMs).toBe(8100);
  });

  it("finds the promise read-back, which is the segment this whole mechanism exists for", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* append(started.conversationId, {
          type: "AGENT_TURN",
          payload: { text: "To confirm: you will pay 550 dollars by Friday. Say yes to confirm.", state: "CONFIRMING_OUTCOME", turn_id: "rb", speak_mode: "non_interruptible" },
        });
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out?.turnId).toBe("rb");
  });

  it("never holds on the opening, which is reported by a different signal and so never looks finished", async () => {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const started = yield* startVoiceCall;
        yield* say(started.conversationId, "opening", "non_interruptible");
        return yield* (yield* ConversationRepo).unreportedNonInterruptible(started.conversationId);
      }),
    );
    expect(out).toBeNull();
  });
});

