/**
 * Finding a non-interruptible segment that is still playing, from the ledger alone (issue #1 D1, F2).
 *
 * The read the `held` phase does before T1. It takes no lock and joins no transaction, deliberately:
 * the thing being waited for is reported by a *different process* — the voice worker — so the ledger
 * is the only place every replica can observe it, and holding a row lock for the length of a spoken
 * sentence is not a thing a claim transaction may do.
 */
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
    // An earlier unreported segment is not what the borrower is talking over now.
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

  it("never holds on the opening, which is reported by a different signal and so never looks finished", async () => {
    /**
     * The defect this test exists for, found by running it (2026-09-02). The opening is written with
     * `speak_mode: "non_interruptible"` and `turn_id: "opening"`, and the worker reports it with the
     * `opening_played` signal — **not** an `AGENT_TURN_PLAYOUT`. So it is permanently "unreported",
     * and the first real turn of every voice call was held waiting for evidence that would never
     * arrive: `heldMs: 4257` on a live call, whose payment offer was then superseded and which ended
     * `NO_ANSWER` with no promise recorded.
     */
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

