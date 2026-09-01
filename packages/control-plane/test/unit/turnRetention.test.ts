/**
 * The turn-retention map comes back to zero on an idle process (review #16).
 *
 * Expiry used to be driven from `run()`: the map was swept only while turns were arriving, so the
 * last turns of a fleet run stayed until the *next* run began. `feather_lite_live_turns` — the one
 * gauge that would show a retention leak — showed a plateau instead, and the soak's RSS slope could
 * not separate that from real growth.
 *
 * The seam is `liveTurnCount`, which is what the gauge reads (`prometheus.ts`), driven through the
 * real `TurnRunner` with a stub orchestrator. The clock is Effect's, so the sweeper's schedule and
 * the retention window are both advanced by `TestClock` rather than waited on.
 */
import { Duration, Effect, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { Orchestrator, type Emit, type TurnParams } from "../../src/services/Orchestrator.js";
import type { TurnResult } from "../../src/services/types.js";
import { TurnRunner, liveTurnCount } from "../../src/http/TurnRunner.js";

const resultOf = (p: TurnParams): TurnResult => ({
  turnId: p.turnId,
  agentText: "one moment",
  newState: "CONFIRMING_OUTCOME",
  toolCalled: null,
  callControlAction: null,
  outcome: null,
  endCall: false,
  degraded: false,
  ttftMs: 12,
});

const orchestratorThat = (processTurn: (params: TurnParams, emit: Emit) => Effect.Effect<TurnResult>) =>
  Layer.succeed(Orchestrator, Orchestrator.make({ processTurn, processNoInput: () => Effect.die("not exercised"), processSignal: () => Effect.die("not exercised") }));

/** A turn that starts, streams one delta and ends — the ordinary shape. */
const completes = orchestratorThat((p, emit) =>
  emit({ type: "turn_start", turn_id: p.turnId, state: "CONFIRMING_OUTCOME" }).pipe(
    Effect.zipRight(emit({ type: "delta", text: "one moment" })),
    Effect.zipRight(
      emit({
        type: "turn_end",
        turn_id: p.turnId,
        new_state: "CONFIRMING_OUTCOME",
        agent_text: "one moment",
        tool_called: null,
        call_control_action: null,
        outcome: null,
        end_call: false,
        degraded: false,
        ttft_ms: 12,
      }),
    ),
    Effect.as(resultOf(p)),
  ),
);

/** A turn whose fibre never returns: the wedged decider stream the ceiling exists for. */
const neverFinishes = orchestratorThat((p, emit) => emit({ type: "turn_start", turn_id: p.turnId, state: "CONFIRMING_OUTCOME" }).pipe(Effect.zipRight(Effect.never)));

const turn = (turnId: string): TurnParams => ({ conversationId: "c-1", turnId, userText: "yes" });

const withRunner = (orchestrator: Layer.Layer<Orchestrator>, body: Effect.Effect<void, never, TurnRunner>) =>
  Effect.runPromise(body.pipe(Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(orchestrator))), Effect.provide(TestContext.TestContext)));

describe("the turn-retention map at idle", () => {
  it("returns to zero after the retention window with no further turns", async () => {
    await withRunner(
      completes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        yield* Stream.runDrain(yield* runner.run(turn("t-1")));
        // Still held: a reconnect on the same turn id must re-attach rather than ask the database.
        expect(liveTurnCount()).toBe(1);

        // Nothing else happens on this process. Under the old expiry this is where the entry stayed
        // until the next run — which on an idle box is never.
        yield* TestClock.adjust(Duration.seconds(90));
        expect(liveTurnCount()).toBe(0);
      }).pipe(Effect.orDie),
    );
  });

  it("holds a finished turn for the whole window, so a reconnect still re-attaches", async () => {
    await withRunner(
      completes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        yield* Stream.runDrain(yield* runner.run(turn("t-2")));
        // Swept three times inside the window, and the entry survives all of them: the sweeper must
        // not become an eviction that defeats the reconnect the map exists for.
        yield* TestClock.adjust(Duration.seconds(30));
        expect(liveTurnCount()).toBe(1);
      }).pipe(Effect.orDie),
    );
  });

  it("bounds a turn whose fibre never finishes", async () => {
    await withRunner(
      neverFinishes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        // `run` returns once `turn_start` is emitted; the fibre behind it never returns.
        yield* runner.run(turn("t-3"));
        expect(liveTurnCount()).toBe(1);

        // A minute and a half is past the retention window and nowhere near the lifetime ceiling.
        // The entry has no `finishedAt`, so the window cannot apply to it and it is still held.
        yield* TestClock.adjust(Duration.seconds(90));
        expect(liveTurnCount()).toBe(1);

        // Past the ceiling it goes, deltas and all — which is the difference between a wedged turn
        // costing five minutes of memory and costing the life of the process.
        yield* TestClock.adjust(Duration.seconds(300));
        expect(liveTurnCount()).toBe(0);
      }).pipe(Effect.orDie),
    );
  });
});
