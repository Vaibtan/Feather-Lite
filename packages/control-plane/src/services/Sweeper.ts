/**
 * Detection is worker-liveness-based, not event-silence-based, and every candidate is confirmed
 * against the media plane first: missed heartbeats and a blocked-but-alive worker look identical
 * from here, and sweeping the second hangs up a live call.
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

export type SweepAction = "FINALIZED" | "NEVER_SERVED" | "AGENT_PRESENT" | "UNCONFIRMED" | "ALREADY_CLOSED";

export interface SweepResult {
  readonly conversationId: string;
  readonly action: SweepAction;
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
          const lastSeen = c.lastSeenAt ?? c.startedAt;
          const staleForMs = now.getTime() - lastSeen.getTime();
          const present = yield* media.agentPresent(roomNameFor(c.id));

          if (present === true) {
            yield* metrics.increment("sweeper_deferred");
            out.push({ conversationId: c.id, action: "AGENT_PRESENT", staleForMs });
            continue;
          }
          if (present === null && staleForMs < cfg.orphanUnconfirmedMs) {
            yield* metrics.increment("sweeper_unconfirmed");
            out.push({ conversationId: c.id, action: "UNCONFIRMED", staleForMs });
            continue;
          }

          const neverServed = c.lastSeenAt === null;
          const reason = neverServed ? NEVER_SERVED_REASON : ORPHANED_REASON;

          // The finalisation can lose a race with the worker's own hangup or another server process
          // sweeping the same call, in which case the detect score belongs to whoever got there first.
          const finalized = yield* orch.processSignal(c.id, { kind: "hangup", reason }).pipe(
            Effect.as(true),
            Effect.catchAll((e) => Effect.logDebug(`sweeper did not finalize ${c.id}: ${String(e)}`).pipe(Effect.as(false))),
          );
          if (!finalized) {
            out.push({ conversationId: c.id, action: "ALREADY_CLOSED", staleForMs });
            continue;
          }
          if (neverServed) {
            yield* metrics.increment("sweeper_never_served");
            out.push({ conversationId: c.id, action: "NEVER_SERVED", staleForMs });
            continue;
          }
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
  // Listing `Orchestrator.Default` here does not construct a second orchestrator: Effect memoizes
  // layers by reference within one build, so every sibling that lists it shares the instance.
  dependencies: [SchedulingRepo.Default, Scores.Default, Orchestrator.Default],
}) {}
