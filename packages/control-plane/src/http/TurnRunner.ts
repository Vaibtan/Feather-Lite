/**
 * Runs turns in detached fibers and exposes each as a stream of frames (plan rev.2 R7):
 * durability never depends on the HTTP connection. Frames are cached per turn for a short
 * while so a reconnect (same turn_id) re-attaches instead of re-executing.
 *
 * T1 failures (NotFound / ConversationCompleted / TurnInProgress) surface as Effect errors
 * BEFORE any frame is streamed, so the API can answer 404/409 with a normal body.
 */
import { Cause, Chunk, Clock, Deferred, Duration, Effect, Queue, Schedule, Stream } from "effect";
import type { TurnFrame } from "@feather-lite/contracts";
import { ConversationCompleted, NotFound, TurnInProgress } from "../errors.js";
import { Orchestrator, type TurnParams } from "../services/Orchestrator.js";

type StartError = NotFound | ConversationCompleted | TurnInProgress;

interface LiveTurn {
  /** Not readonly: `finish` replaces it with the frames worth keeping. */
  frames: TurnFrame[];
  readonly subscribers: Set<Queue.Queue<TurnFrame | typeof END>>;
  done: boolean;
  /** When the turn was claimed. The only bound on an entry whose fiber never finishes (review #16). */
  readonly startedAt: number;
  finishedAt: number | null;
}

const END = Symbol.for("feather-lite/turn-end");
/**
 * How long a finished turn's frames are kept for a reconnect (C1).
 *
 * Was five minutes, and at 30 turns/s that is nine thousand turns held at once — the soak's whole
 * run, never collected. Sixty seconds instead, because this map is an **optimisation, not a
 * correctness requirement**: a client that re-sends a `turn_id` after the entry has gone does not
 * re-execute the turn. T1's idempotency check finds the recorded `DONE` row and replays its result
 * from the ledger. What the map saves is a database round trip, and a reconnect that takes longer
 * than a minute can afford one.
 */
const RETENTION_MS = Math.max(1, Number(process.env["TURN_RETENTION_SECONDS"] ?? 60)) * 1000;

/**
 * The bound on an entry whose fiber never finishes (review #16).
 *
 * `finishedAt` is stamped by `finish`, so a turn that never reaches it has no expiry at all: a
 * wedged decider stream held its deltas for the life of the process, and the soak's RSS slope could
 * not tell that from real growth. Five minutes is far past any turn this system produces — the
 * whole waterfall is under four seconds at p95, and the orphan sweeper gives up on a *call* in
 * forty — so nothing legitimate is evicted, and what is evicted was never going to finish.
 *
 * Eviction is from the index only. The fiber keeps its reference and its subscribers keep theirs,
 * so a turn dropped here still streams to whoever is already attached; what it loses is the ability
 * to be re-attached to by turn id, which is an optimisation (see `RETENTION_MS`) and not
 * correctness — T1 replays a recorded turn from the ledger.
 */
const MAX_LIFETIME_MS = Math.max(1, Number(process.env["TURN_MAX_LIFETIME_SECONDS"] ?? 300)) * 1000;

/**
 * How often the map is swept.
 *
 * Ten seconds is a tenth of the shortest thing being expired and costs one walk of a map that holds
 * at most a minute of turns. The number that matters is not the interval but that a sweep happens
 * **at all when nothing is running** — which is the defect: expiry used to be driven from `run()`,
 * so the last turns of a run were retained until the next run, and `feather_lite_live_turns` never
 * came back to zero on an idle process.
 */
const SWEEP_INTERVAL = Duration.seconds(10);

const startError = (cause: Cause.Cause<unknown>): StartError | null => {
  for (const f of Chunk.toReadonlyArray(Cause.failures(cause))) {
    if (f instanceof NotFound || f instanceof ConversationCompleted || f instanceof TurnInProgress) return f;
  }
  return null;
};

/**
 * Gauges for the process metrics, set when the service is built (D3).
 *
 * Module-level rather than on the service because `/status` is answered by a handler that already
 * has enough dependencies, and because a process that never built a `TurnRunner` should report
 * zero rather than fail to answer.
 */
export let liveTurnCount: () => number = () => 0;
export let subscriberCount: () => number = () => 0;

export class TurnRunner extends Effect.Service<TurnRunner>()("@feather-lite/TurnRunner", {
  scoped: Effect.gen(function* () {
    const orch = yield* Orchestrator;
    const live = new Map<string, LiveTurn>();
    // Published for the process gauges (D3). C1 in the audit is that this map retains every turn
    // including delta frames for five minutes and is walked on every run; its size is the first
    // thing worth watching, and the soak's +3.1 MB/min of growth is what makes it worth watching.
    liveTurnCount = () => live.size;
    subscriberCount = () => [...live.values()].reduce((n, t) => n + t.subscribers.size, 0);
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

    /**
     * Expire what the map is no longer keeping for anyone (C1, review #16).
     *
     * Two rules, because there are two ways an entry stops being worth holding. A **finished** turn
     * is held for `RETENTION_MS` so a reconnect re-attaches instead of asking the database. A turn
     * that never finished has no such moment, so it is held no longer than `MAX_LIFETIME_MS` from
     * when it was claimed — otherwise a wedged decider stream keeps its deltas for the life of the
     * process, which is exactly what the soak measured and could not attribute.
     */
    const gc = (now: number) => {
      for (const [k, t] of live) {
        const expired = t.done && t.finishedAt !== null ? now - t.finishedAt > RETENTION_MS : now - t.startedAt > MAX_LIFETIME_MS;
        if (expired) live.delete(k);
      }
    };

    /**
     * And it runs on its own fibre, scoped to the service (review #16).
     *
     * It used to run from `run()`, throttled to once a second — which meant the map was only ever
     * swept while turns were arriving. **At idle nothing swept at all**, so the last turns of a
     * fleet run stayed until the next run began, `feather_lite_live_turns` never returned to zero,
     * and the one gauge that would show a retention leak showed a plateau instead.
     *
     * `forkScoped`, not `forkDaemon`: the fibre belongs to the layer that built this service, so a
     * test or a shutdown that closes the scope takes the sweeper with it rather than leaving it
     * running against a map nobody reads.
     */
    yield* Effect.forkScoped(Clock.currentTimeMillis.pipe(Effect.map(gc), Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

    /** Start (or attach to) a turn. Fails with the T1 error if the turn cannot start. */
    const run = (params: TurnParams): Effect.Effect<Stream.Stream<TurnFrame>, StartError> =>
      Effect.gen(function* () {
        const key = keyOf(params);
        const existing = live.get(key);
        if (existing) return yield* subscribe(existing);

        const turn: LiveTurn = { frames: [], subscribers: new Set(), done: false, startedAt: yield* Clock.currentTimeMillis, finishedAt: null };
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
            turn.finishedAt = yield* Clock.currentTimeMillis;
            /**
             * Deltas are dropped the moment the turn is over (C1).
             *
             * They exist to be streamed, and after `turn_end` there is nothing left to stream them
             * to: a client attaching to a finished turn gets the replay and then the end, and
             * `turn_end` already carries `agent_text` — the whole reply, deltas and says together.
             * So the retained copy of every token was five minutes of memory holding a string the
             * next frame also holds.
             *
             * **Only after the turn ends.** While it is live the deltas stay, so a reconnect
             * mid-turn still receives the text it missed in order — which is the case the retention
             * map exists for, and the one thing that would have broken if this were done at emit
             * time.
             */
            turn.frames = turn.frames.filter((f) => f.type !== "delta");
            yield* broadcast(turn, END);
            turn.subscribers.clear();
          });

        yield* Effect.forkDaemon(
          /**
           * The annotation is applied out here rather than inside `processTurn`, which carries its
           * own: the failure branch below logs from the *handler*, outside that effect, and that
           * line — "turn failed after start" — is precisely the one an operator needs joined to a
           * call (D3).
           *
           * **And it has to wrap `matchCauseEffect`, not sit inside it** (review #5). Piped before
           * it, the annotation applied only to `processTurn` — which already annotates itself — and
           * the one line this comment exists for logged with `annotations: []`. Under load, on the
           * failure of one of a hundred interleaved calls, that line said nothing about which call.
           */
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
            Effect.annotateLogs({ conversation_id: params.conversationId, turn_id: params.turnId }),
          ),
        );
        yield* Deferred.await(started);
        return yield* subscribe(turn);
      });

    return { run } as const;
  }),
  dependencies: [Orchestrator.Default],
}) {}
