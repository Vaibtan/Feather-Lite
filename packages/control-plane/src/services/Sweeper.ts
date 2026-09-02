/**
 * The orphaned-call sweeper (spec 2026-08-26, D6).
 *
 * The 2026-08-23 chaos probe found that killing the voice worker mid-call leaves the conversation
 * open forever: no Close handler runs, no hangup signal is sent, `final_outcome` stays NULL — and
 * the "one live conversation per borrower" pre-call rule then blocks that borrower permanently. The
 * recovery machinery already existed (a hangup signal finalizes the call cleanly); the missing
 * piece was a detector.
 *
 * **Detection is worker-liveness-based, not event-silence-based.** Silence is normal on a call — a
 * 50 s read-back, a borrower thinking — while a worker that has stopped heartbeating is not. Every
 * worker reports the conversations it is serving on its existing 10 s heartbeat, and a conversation
 * becomes a candidate when nobody has claimed it for `ORPHAN_MISSED_HEARTBEATS` intervals.
 *
 * **A candidate is confirmed against the media plane before anything is finalized.** Missed
 * heartbeats and a blocked-but-alive worker look identical from the control plane; LiveKit can tell
 * them apart. Only a definite "no agent in that room" finalizes. That second opinion is what lets
 * the window be ~35 s rather than minutes. When the media plane cannot answer at all, the much
 * longer `ORPHAN_UNCONFIRMED_MS` applies, so a LiveKit outage becomes a slower sweep instead of a
 * fleet-wide hangup.
 *
 * The finalization itself is not special: it is the same hangup signal the worker would have sent,
 * carrying reason `ORPHANED`, so it lands in the ledger as an ordinary `CALL_CONTROL` event and
 * replays like any other close.
 */
import { DateTime, Effect } from "effect";
import { NEVER_SERVED_REASON, numericScore, ORPHANED_REASON } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { MediaPlane } from "./MediaPlane.js";
import { Metrics } from "./Metrics.js";
import { Orchestrator } from "./Orchestrator.js";
import { Scores } from "./Scores.js";
import { roomNameFor } from "./VoiceSessions.js";

/** Matches the SCREAMING_SNAKE per-tick status vocabulary of the other two workers. */
export type SweepAction = "FINALIZED" | "NEVER_SERVED" | "AGENT_PRESENT" | "UNCONFIRMED" | "ALREADY_CLOSED";

export interface SweepResult {
  readonly conversationId: string;
  readonly action: SweepAction;
  /** How long the conversation had been unclaimed when the sweeper looked at it. */
  readonly staleForMs: number;
}

export class Sweeper extends Effect.Service<Sweeper>()("@feather-lite/Sweeper", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const sched = yield* SchedulingRepo;
    const orch = yield* Orchestrator;
    const media = yield* MediaPlane;
    const metrics = yield* Metrics;
    const scores = yield* Scores;

    const stalenessMs = cfg.orphanMissedHeartbeats * cfg.orphanHeartbeatIntervalMs;

    const runOnce = (limit = 20, nowOverride?: DateTime.Utc) =>
      Effect.gen(function* () {
        if (!cfg.sweeperEnabled) return [] as ReadonlyArray<SweepResult>;
        const now = DateTime.toDateUtc(nowOverride ?? (yield* DateTime.now));
        const candidates = yield* sched.staleConversations({ staleBefore: new Date(now.getTime() - stalenessMs), limit });
        const out: SweepResult[] = [];
        for (const c of candidates) {
          // Measured from the last sign of life — a heartbeat if there ever was one, otherwise the
          // start of the call, which is the last moment anything was known to be working it.
          const lastSeen = c.lastSeenAt ?? c.startedAt;
          const staleForMs = now.getTime() - lastSeen.getTime();
          const present = yield* media.agentPresent(roomNameFor(c.id));

          if (present === true) {
            // A slow or blocked worker, not a dead one. Leaving it alone is the whole reason the
            // confirmation exists; sweeping it would hang up a live call. Counted, not silent: a
            // rising deferral count is the signal that workers are starving, which is a real
            // finding (the N=10 fleet run hit exactly that) and invisible from the ledger, because
            // deferring writes no event.
            yield* metrics.increment("sweeper_deferred");
            out.push({ conversationId: c.id, action: "AGENT_PRESENT", staleForMs });
            continue;
          }
          if (present === null && staleForMs < cfg.orphanUnconfirmedMs) {
            yield* metrics.increment("sweeper_unconfirmed");
            out.push({ conversationId: c.id, action: "UNCONFIRMED", staleForMs });
            continue;
          }

          /**
           * Did any worker ever claim this call? `lastSeenAt` is the newest heartbeat that named
           * this conversation, and null means there has never been one (O4).
           *
           * An orphan is a call that *lost* a worker. A call that never had one is a different
           * failure — a dispatch that did not happen — and timing it produces a number about the
           * unconfirmed window rather than about detection. Measured: one such call moved the
           * fleet's `orphan_detect_ms` p95 from 38 902 ms to 308 860 ms.
           */
          const neverServed = c.lastSeenAt === null;
          const reason = neverServed ? NEVER_SERVED_REASON : ORPHANED_REASON;

          // The finalisation can legitimately lose a race — the worker's own hangup, or another
          // server process sweeping the same call — in which case this returns ConversationCompleted
          // and the detect score belongs to whoever got there first, not to us.
          const finalized = yield* orch.processSignal(c.id, { kind: "hangup", reason }).pipe(
            Effect.as(true),
            Effect.catchAll((e) => Effect.logDebug(`sweeper did not finalize ${c.id}: ${String(e)}`).pipe(Effect.as(false))),
          );
          if (!finalized) {
            out.push({ conversationId: c.id, action: "ALREADY_CLOSED", staleForMs });
            continue;
          }
          if (neverServed) {
            // Counted, not timed. The count is the signal worth watching: a rising number of calls
            // that no worker ever claimed means dispatch is broken, which is a different alarm from
            // workers dying mid-call.
            yield* metrics.increment("sweeper_never_served");
            out.push({ conversationId: c.id, action: "NEVER_SERVED", staleForMs });
            continue;
          }
          // Time-to-detect, so "the chaos scenario is measurable" is a number and not a claim.
          yield* scores.record(
            numericScore(c.id, "system.orphan_detect_ms", staleForMs, "SYSTEM", {
              comment: present === false ? "no agent in the LiveKit room" : "media plane could not confirm; swept on the long window",
            }),
          );
          out.push({ conversationId: c.id, action: "FINALIZED", staleForMs });
        }
        return out as ReadonlyArray<SweepResult>;
      });

    return { runOnce, stalenessMs } as const;
  }),
  // Listing `Orchestrator.Default` here does **not** construct a second one (F1, measured).
  //
  // The comment this replaces said it did, and that a single instance could not be threaded through
  // `Layer.mergeAll` because it does not satisfy siblings. The first half is wrong: Effect memoizes
  // layers **by reference** within one build, and `Orchestrator.Default` is one layer value, so the
  // three services that list it and `ServicesLive`'s own `mergeAll` share the instance. Counted on
  // 2026-09-02 by instrumenting the constructor and building `ServicesLive` once: **1**. The server
  // builds `ServicesLive` exactly once (`main.ts`, `Layer.provide(ServicesLive)`), so the process
  // has one orchestrator, which is what D1's `held` waiter needs.
  //
  // What the second half describes is a typing inconvenience, not a duplication: a sibling that
  // omits the dependency exports `Orchestrator` in its `RIn` and the merge no longer typechecks.
  // Leaving the dependency listed is how each service states what it needs without that cost.
  dependencies: [SchedulingRepo.Default, Scores.Default, Orchestrator.Default],
}) {}
