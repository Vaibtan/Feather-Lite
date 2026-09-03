import { DateTime, Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationRepo,
  IdGen,
  Metrics,
  Orchestrator,
  Queries,
  SchedulingRepo,
  Scores,
  ScoresRepo,
  ScriptedTurnDeciderLive,
  StaticMediaPlaneLive,
  Sweeper,
  WorkflowService,
  withFrozenClock,
} from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const NOW = DateTime.unsafeMake("2026-08-16T14:00:00Z");
/** Long enough to be a candidate under the default 3 x 10 s staleness window. */
const LONG_AGO = DateTime.subtract(NOW, { minutes: 5 });

const services = Layer.mergeAll(Sweeper.Default, Orchestrator.Default, WorkflowService.Default, Queries.Default, Scores.Default, ScoresRepo.Default, ConversationRepo.Default, SchedulingRepo.Default, IdGen.Default);

const runtimeFor = (agentPresent: boolean | null) =>
  makeRuntime(services.pipe(Layer.provide(ScriptedTurnDeciderLive), Layer.provideMerge(StaticMediaPlaneLive(agentPresent)), Layer.provideMerge(makeInfraLayer())));

const gone = runtimeFor(false);
const present = runtimeFor(true);
const unreachable = runtimeFor(null);

/**
 * A conversation with a `conversation_liveness` row is one a worker had and lost; one without was
 * never served at all. The sweeper treats them differently and only times the first.
 */
const seedVoiceCall = (name: string, phone: string, startedAt: DateTime.Utc, opts: { readonly claimedAt?: DateTime.Utc } = {}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const ids = yield* IdGen;
    const borrowerId = yield* ids.next();
    const cpId = yield* ids.next();
    yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: "America/New_York", status: "ACTIVE" })}`;
    yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
    yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
    yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
    const started = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: startedAt });
    yield* sql`UPDATE conversations SET started_at = ${DateTime.toDateUtc(startedAt)} WHERE id = ${started.conversationId}`;
    if (opts.claimedAt !== undefined) {
      yield* sql`INSERT INTO conversation_liveness ${sql.insert({ conversationId: started.conversationId, lastSeenAt: DateTime.toDateUtc(opts.claimedAt), agentName: "feather-lite-agent" })}`;
    }
    return { borrowerId, cpId, conversationId: started.conversationId };
  });

beforeAll(async () => {
  await gone.runPromise(truncateAll);
});
afterAll(async () => {
  await Promise.all([gone.dispose(), present.dispose(), unreachable.dispose()]);
});

describe("orphaned-call sweeper", () => {
  it("finalizes a call whose worker vanished as FAILED / ORPHANED, exactly once", async () => {
    const out = await gone.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { borrowerId, cpId, conversationId } = yield* seedVoiceCall("Abandoned Person", "+15550005001", LONG_AGO, { claimedAt: LONG_AGO });
          const sweeper = yield* Sweeper;
          const q = yield* Queries;
          const wf = yield* WorkflowService;
          const first = yield* sweeper.runOnce(20, NOW);
          const second = yield* sweeper.runOnce(20, NOW);
          const detail = yield* q.conversationDetail(conversationId);
          const scores = yield* (yield* Scores).listForConversation(conversationId);
          const canCallAgain = yield* wf.startCall({ borrowerId, contactPointId: cpId, channel: "voice", now: NOW }).pipe(Effect.either);
          return { conversationId, first, second, detail, scores, canCallAgain };
        }),
      ),
    );
    // Scoped to this call: the suite shares one database, so other tests' open conversations are
    // legitimately in the same sweep.
    expect(out.first.filter((r) => r.conversationId === out.conversationId).map((r) => r.action)).toEqual(["FINALIZED"]);
    expect(out.second.map((r) => r.conversationId)).not.toContain(out.conversationId);
    // FAILED, not NO_ANSWER: NO_ANSWER would schedule a polite retry for a system failure.
    expect(out.detail.conversation.final_outcome).toBe("FAILED");
    expect(out.detail.conversation.ended_at).not.toBeNull();
    const hangup = out.detail.events.find((e) => e.type === "CALL_CONTROL" && e.payload.action === "HANGUP");
    expect(hangup && hangup.type === "CALL_CONTROL" && hangup.payload.reason).toBe("ORPHANED");
    const detect = out.scores.find((s) => s.name === "system.orphan_detect_ms");
    expect(detect?.source).toBe("SYSTEM");
    expect(detect?.value).toBe(5 * 60_000);
    expect(out.canCallAgain._tag).toBe("Right");
  });

  it("counts a call no worker ever claimed, and does not time it, because timing it would measure the unconfirmed window rather than detection latency", async () => {
    const out = await gone.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { conversationId } = yield* seedVoiceCall("Never Dispatched", "+15550005006", LONG_AGO);
          const swept = yield* (yield* Sweeper).runOnce(20, NOW);
          const detail = yield* (yield* Queries).conversationDetail(conversationId);
          const scores = yield* (yield* Scores).listForConversation(conversationId);
          return { conversationId, swept, detail, scores };
        }),
      ),
    );

    expect(out.swept.filter((r) => r.conversationId === out.conversationId).map((r) => r.action)).toEqual(["NEVER_SERVED"]);
    expect(out.detail.conversation.final_outcome).toBe("FAILED");
    const hangup = out.detail.events.find((e) => e.type === "CALL_CONTROL" && e.payload.action === "HANGUP");
    expect(hangup && hangup.type === "CALL_CONTROL" && hangup.payload.reason).toBe("NEVER_SERVED");
    expect(out.scores.find((s) => s.name === "system.orphan_detect_ms")).toBeUndefined();
  });

  it("leaves a call alone when the agent is still in the room", async () => {
    const out = await present.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const { conversationId } = yield* seedVoiceCall("Slow Worker Person", "+15550005002", LONG_AGO, { claimedAt: LONG_AGO });
          const before = ((yield* (yield* Metrics).snapshot()) as { counters: Record<string, number> }).counters["sweeper_deferred"] ?? 0;
          const swept = yield* (yield* Sweeper).runOnce(20, NOW);
          const after = ((yield* (yield* Metrics).snapshot()) as { counters: Record<string, number> }).counters["sweeper_deferred"] ?? 0;
          const detail = yield* (yield* Queries).conversationDetail(conversationId);
          return { conversationId, swept, detail, deferredDelta: after - before };
        }),
      ),
    );
    // Missed heartbeats and a blocked-but-alive worker look identical from the control plane, so
    // the media-plane confirmation is what keeps a short window from hanging up a live call.
    expect(out.swept.filter((r) => r.conversationId === out.conversationId).map((r) => r.action)).toEqual(["AGENT_PRESENT"]);
    expect(out.detail.conversation.final_outcome).toBeNull();
    // Deferring writes no ledger event, so without this counter a starving fleet looks identical to
    // one with nothing to sweep.
    expect(out.deferredDelta).toBeGreaterThanOrEqual(1);
  });

  it("waits out the long window when the media plane cannot answer", async () => {
    const out = await unreachable.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          // Past the 30 s staleness window, well inside the 5-minute unconfirmed one.
          const twoMinutesAgo = DateTime.subtract(NOW, { minutes: 2 });
          const recent = yield* seedVoiceCall("Unconfirmable Person", "+15550005003", twoMinutesAgo, { claimedAt: twoMinutesAgo });
          const sweeper = yield* Sweeper;
          const q = yield* Queries;
          const held = yield* sweeper.runOnce(20, NOW);
          const stillOpen = yield* q.conversationDetail(recent.conversationId);
          const later = DateTime.add(NOW, { minutes: 10 });
          const swept = yield* sweeper.runOnce(20, later);
          const closed = yield* q.conversationDetail(recent.conversationId);
          return { id: recent.conversationId, held, stillOpen, swept, closed };
        }),
      ),
    );
    expect(out.held.filter((r) => r.conversationId === out.id).map((r) => r.action)).toEqual(["UNCONFIRMED"]);
    expect(out.stillOpen.conversation.final_outcome).toBeNull();
    expect(out.swept.filter((r) => r.conversationId === out.id).map((r) => r.action)).toEqual(["FINALIZED"]);
    expect(out.closed.conversation.final_outcome).toBe("FAILED");
  });

  it("ignores a conversation a worker is still heartbeating, and simulated calls entirely", async () => {
    const out = await gone.runPromise(
      withFrozenClock(NOW)(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const ids = yield* IdGen;
          const sched = yield* SchedulingRepo;
          const live = yield* seedVoiceCall("Live Person", "+15550005004", LONG_AGO);
          yield* sched.touchLiveness([live.conversationId], "feather-lite-agent", DateTime.toDateUtc(DateTime.subtract(NOW, { seconds: 10 })));
          // A simulated conversation has no worker to lose; an abandoned console simulation is a
          // separate, longer rule.
          const borrowerId = yield* ids.next();
          const cpId = yield* ids.next();
          yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Simulated Person", timezone: "America/New_York", status: "ACTIVE" })}`;
          yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: "+15550005005", isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
          yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
          yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "1000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 10 })}`;
          const sim = yield* (yield* WorkflowService).startCall({ borrowerId, contactPointId: cpId, channel: "simulated", now: LONG_AGO });
          yield* sql`UPDATE conversations SET started_at = ${DateTime.toDateUtc(LONG_AGO)} WHERE id = ${sim.conversationId}`;

          const swept = yield* (yield* Sweeper).runOnce(20, NOW);
          return { live: live.conversationId, sim: sim.conversationId, swept };
        }),
      ),
    );
    const touched = out.swept.map((r) => r.conversationId);
    expect(touched).not.toContain(out.live);
    expect(touched).not.toContain(out.sim);
  });
});
