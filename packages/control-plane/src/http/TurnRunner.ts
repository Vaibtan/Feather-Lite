import { Cause, Chunk, Clock, Deferred, Duration, Effect, Fiber, Queue, Schedule, Stream } from "effect";
import type { TurnFrame } from "@feather-lite/contracts";
import { turnStartErrorOf, type TurnStartError } from "../errors.js";
import { Gauges } from "../services/Gauges.js";
import { holdBudgetMs } from "@feather-lite/domain";
import { Orchestrator, type TurnParams } from "../services/Orchestrator.js";

type StartError = TurnStartError;

interface LiveTurn {
  frames: TurnFrame[];
  readonly subscribers: Set<Queue.Queue<TurnFrame | typeof END>>;
  done: boolean;
  readonly startedAt: number;
  finishedAt: number | null;
}

const END = Symbol.for("feather-lite/turn-end");
// An optimisation, not a correctness requirement: a `turn_id` re-sent after the entry has gone
// replays the recorded turn from the ledger rather than re-executing it.
const RETENTION_MS = Math.max(1, Number(process.env["TURN_RETENTION_SECONDS"] ?? 60)) * 1000;

// `finishedAt` is stamped by `finish`, so a turn that never reaches it would have no expiry at all.
// Eviction is from the index only: a dropped turn still streams to whoever is already attached.
const MAX_LIFETIME_MS = Math.max(1, Number(process.env["TURN_MAX_LIFETIME_SECONDS"] ?? 300)) * 1000;

const SWEEP_INTERVAL = Duration.seconds(10);

// A tenth of the shortest segment worth waiting for, at one indexed read per tick.
const HOLD_POLL_MS = 150;

export class TurnRunner extends Effect.Service<TurnRunner>()("@feather-lite/TurnRunner", {
  scoped: Effect.gen(function* () {
    const orch = yield* Orchestrator;
    const gauges = yield* Gauges;
    const live = new Map<string, LiveTurn>();
    gauges.set("live_turns", () => live.size);
    gauges.set("sse_streams", () => [...live.values()].reduce((n, t) => n + t.subscribers.size, 0));
    const keyOf = (p: { conversationId: string; turnId: string }) => `${p.conversationId}:${p.turnId}`;

    const broadcast = (turn: LiveTurn, item: TurnFrame | typeof END) =>
      Effect.forEach([...turn.subscribers], (q) => Queue.offer(q, item), { discard: true });

    const subscribe = (turn: LiveTurn): Effect.Effect<Stream.Stream<TurnFrame>> =>
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<TurnFrame | typeof END>();
        for (const f of turn.frames) yield* Queue.offer(q, f); // replay, then live
        if (turn.done) yield* Queue.offer(q, END);
        else turn.subscribers.add(q);
        return Stream.fromQueue(q).pipe(
          Stream.takeWhile((x): x is TurnFrame => x !== END),
          Stream.ensuring(Effect.sync(() => turn.subscribers.delete(q))),
        );
      });

    const gc = (now: number) => {
      for (const [k, t] of live) {
        const expired = t.done && t.finishedAt !== null ? now - t.finishedAt > RETENTION_MS : now - t.startedAt > MAX_LIFETIME_MS;
        if (expired) live.delete(k);
      }
    };

    yield* Effect.forkScoped(Clock.currentTimeMillis.pipe(Effect.map(gc), Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

    const claimed = new Map<string, { conversationId: string; turnId: string; fiber: Fiber.RuntimeFiber<unknown, unknown> | null }>();

    /**
     * On shutdown, interrupt every claimed turn and release its slot. There is no grace wait: a turn
     * that was going to commit already released itself in T2, and anything still claimed would
     * otherwise hold `active_turn_id` forever on a simulated call.
     */
    const releaseClaimedAtShutdown: Effect.Effect<void> = Effect.gen(function* () {
      if (claimed.size === 0) return;
      const outstanding = [...claimed.values()];
      yield* Effect.logWarning(`releasing ${String(outstanding.length)} turn(s) still claimed at shutdown`);
      /**
       * Interrupted first, then released, and in that order for a reason.
       *
       * These fibres are daemons, so closing the scope does not stop them — they would run on into a
       * process that is going away. Clearing `active_turn_id` underneath one that was about to commit
       * would have T2 find the slot no longer its own and discard the turn, which is a silently lost
       * turn rather than an interrupted one. Interruption unwinds the transaction it is in, so
       * nothing half-commits, and only then is the slot safe to clear.
       *
       * Deterministic rather than timed: no sleep, so this behaves the same under a test clock as
       * under a real one, and a shutdown cannot hang waiting on a turn that was never going to
       * finish.
       */
      yield* Effect.forEach(outstanding, (t) => (t.fiber === null ? Effect.void : Fiber.interrupt(t.fiber).pipe(Effect.ignore)), { discard: true });
      yield* Effect.forEach(outstanding, (t) => orch.releaseStrandedTurn(t.conversationId, t.turnId), { discard: true });
    });
    yield* Effect.addFinalizer(() => releaseClaimedAtShutdown);

    // Waits before the claim transaction, never inside it: that transaction may not hold a row lock
    // for the length of a spoken sentence. A poll rather than an in-process `Deferred` because the
    // segment is reported by the voice worker, the only place every replica can observe it.
    const holdForPlayout = (conversationId: string): Effect.Effect<number> =>
      Effect.gen(function* () {
        const segment = yield* orch.unreportedNonInterruptible(conversationId);
        if (segment === null) return 0;
        const startedMs = yield* Clock.currentTimeMillis;
        const budget = holdBudgetMs({
          ttsAudioMs: segment.ttsAudioMs,
          elapsedMs: startedMs - segment.startedAtMs,
          channel: segment.channel,
        });
        if (budget === 0) return 0;
        let waited = 0;
        while (waited < budget) {
          yield* Effect.sleep(Duration.millis(HOLD_POLL_MS));
          waited = (yield* Clock.currentTimeMillis) - startedMs;
          const still = yield* orch.unreportedNonInterruptible(conversationId);
          if (still === null || still.turnId !== segment.turnId) break;
        }
        return waited;
      });

    const run = (params: TurnParams): Effect.Effect<Stream.Stream<TurnFrame>, StartError> =>
      Effect.gen(function* () {
        const key = keyOf(params);
        const existing = live.get(key);
        if (existing) return yield* subscribe(existing);

        const turn: LiveTurn = { frames: [], subscribers: new Set(), done: false, startedAt: yield* Clock.currentTimeMillis, finishedAt: null };
        live.set(key, turn);
        claimed.set(key, { conversationId: params.conversationId, turnId: params.turnId, fiber: null });
        const started = yield* Deferred.make<void, StartError>();

        const emit = (frame: TurnFrame) =>
          Effect.gen(function* () {
            turn.frames.push(frame);
            if (frame.type === "turn_start") yield* Deferred.succeed(started, void 0);
            yield* broadcast(turn, frame);
          });

        const finish = (extra: TurnFrame | null) =>
          Effect.gen(function* () {
            if (extra) {
              turn.frames.push(extra);
              yield* broadcast(turn, extra);
            }
            turn.done = true;
            turn.finishedAt = yield* Clock.currentTimeMillis;
            claimed.delete(key);
            // Only after the turn ends: while it is live the deltas must stay, so a mid-turn
            // reconnect still receives the text it missed in order.
            turn.frames = turn.frames.filter((f) => f.type !== "delta");
            yield* broadcast(turn, END);
            turn.subscribers.clear();
          });

        // `forkDaemon` deliberately: `forkScoped` would attach the turn to the caller's scope,
        // which for an HTTP request ties the turn's life to its connection.
        const fiber = yield* Effect.forkDaemon(
          holdForPlayout(params.conversationId).pipe(
            Effect.flatMap((heldMs) => orch.processTurn(heldMs === 0 ? params : { ...params, heldMs }, emit)),
          ).pipe(
            Effect.matchCauseEffect({
              onSuccess: () => finish(null),
              onFailure: (cause) =>
                Effect.gen(function* () {
                  const startedAlready = turn.frames.some((f) => f.type === "turn_start");
                  const err = turnStartErrorOf(cause);
                  if (!startedAlready && err) {
                    // A second client may have attached by turn id while T1 was still running, so
                    // subscribers are told what happened before the entry is dropped.
                    yield* broadcast(turn, { type: "error", turn_id: params.turnId, code: err._tag, message: err.message });
                    yield* broadcast(turn, END);
                    turn.subscribers.clear();
                    live.delete(key);
                    claimed.delete(key);
                    yield* Deferred.fail(started, err);
                    return;
                  }
                  if (!startedAlready) yield* Deferred.succeed(started, void 0);
                  yield* Effect.logError("turn failed after start", cause);
                  yield* finish({ type: "error", turn_id: params.turnId, code: err?._tag ?? "INTERNAL", message: Cause.pretty(cause).slice(0, 500) });
                }),
            }),
            Effect.annotateLogs({ conversation_id: params.conversationId, turn_id: params.turnId }),
          ),
        );
        const entry = claimed.get(key);
        if (entry) entry.fiber = fiber;
        yield* Deferred.await(started);
        return yield* subscribe(turn);
      });

    return { run } as const;
  }),
  dependencies: [Orchestrator.Default, Gauges.Default],
}) {}
