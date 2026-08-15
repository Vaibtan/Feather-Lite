/**
 * Runs turns in detached fibers and exposes each as a stream of frames (plan rev.2 R7):
 * durability never depends on the HTTP connection. Frames are cached per turn for a short
 * while so a reconnect (same turn_id) re-attaches instead of re-executing.
 *
 * T1 failures (NotFound / ConversationCompleted / TurnInProgress) surface as Effect errors
 * BEFORE any frame is streamed, so the API can answer 404/409 with a normal body.
 */
import { Cause, Chunk, Deferred, Effect, Queue, Stream } from "effect";
import type { TurnFrame } from "@feather-lite/contracts";
import { ConversationCompleted, NotFound, TurnInProgress } from "../errors.js";
import { Orchestrator, type TurnParams } from "../services/Orchestrator.js";

type StartError = NotFound | ConversationCompleted | TurnInProgress;

interface LiveTurn {
  readonly frames: TurnFrame[];
  readonly subscribers: Set<Queue.Queue<TurnFrame | typeof END>>;
  done: boolean;
  finishedAt: number | null;
}

const END = Symbol.for("feather-lite/turn-end");
const RETENTION_MS = 5 * 60_000;

const startError = (cause: Cause.Cause<unknown>): StartError | null => {
  for (const f of Chunk.toReadonlyArray(Cause.failures(cause))) {
    if (f instanceof NotFound || f instanceof ConversationCompleted || f instanceof TurnInProgress) return f;
  }
  return null;
};

export class TurnRunner extends Effect.Service<TurnRunner>()("@feather-lite/TurnRunner", {
  effect: Effect.gen(function* () {
    const orch = yield* Orchestrator;
    const live = new Map<string, LiveTurn>();
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

    const gc = () => {
      const now = Date.now();
      for (const [k, t] of live) if (t.done && t.finishedAt !== null && now - t.finishedAt > RETENTION_MS) live.delete(k);
    };

    /** Start (or attach to) a turn. Fails with the T1 error if the turn cannot start. */
    const run = (params: TurnParams): Effect.Effect<Stream.Stream<TurnFrame>, StartError> =>
      Effect.gen(function* () {
        gc();
        const key = keyOf(params);
        const existing = live.get(key);
        if (existing) return yield* subscribe(existing);

        const turn: LiveTurn = { frames: [], subscribers: new Set(), done: false, finishedAt: null };
        live.set(key, turn);
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
            turn.finishedAt = Date.now();
            yield* broadcast(turn, END);
            turn.subscribers.clear();
          });

        yield* Effect.forkDaemon(
          orch.processTurn(params, emit).pipe(
            Effect.matchCauseEffect({
              onSuccess: () => finish(null),
              onFailure: (cause) =>
                Effect.gen(function* () {
                  const startedAlready = turn.frames.some((f) => f.type === "turn_start");
                  const err = startError(cause);
                  if (!startedAlready && err) {
                    // Belongs to the caller: 404 / 409 with a normal body.
                    live.delete(key);
                    yield* Deferred.fail(started, err);
                    return;
                  }
                  if (!startedAlready) yield* Deferred.succeed(started, void 0);
                  yield* Effect.logError("turn failed after start", cause);
                  yield* finish({ type: "error", turn_id: params.turnId, code: err?._tag ?? "INTERNAL", message: Cause.pretty(cause).slice(0, 500) });
                }),
            }),
          ),
        );
        yield* Deferred.await(started);
        return yield* subscribe(turn);
      });

    return { run } as const;
  }),
  dependencies: [Orchestrator.Default],
}) {}
