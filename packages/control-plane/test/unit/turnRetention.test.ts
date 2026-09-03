import { Duration, Effect, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { Orchestrator, type Emit, type TurnParams } from "../../src/services/Orchestrator.js";
import type { TurnResult } from "../../src/services/types.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";
import { Gauges } from "../../src/services/Gauges.js";

const resultOf = (p: TurnParams): TurnResult => ({
  turnId: p.turnId,
  decider: "model",
  disposition: "respond",
  resolution: "spoke",
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
  Layer.succeed(Orchestrator, Orchestrator.make({ processTurn, processNoInput: () => Effect.die("not exercised"), processSignal: () => Effect.die("not exercised"), unreportedNonInterruptible: () => Effect.succeed(null), releaseStrandedTurn: () => Effect.void }));

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

const neverFinishes = orchestratorThat((p, emit) => emit({ type: "turn_start", turn_id: p.turnId, state: "CONFIRMING_OUTCOME" }).pipe(Effect.zipRight(Effect.never)));

const turn = (turnId: string): TurnParams => ({ conversationId: "c-1", turnId, userText: "yes" });

const withRunner = (orchestrator: Layer.Layer<Orchestrator>, body: Effect.Effect<void, never, TurnRunner | Gauges>) =>
  Effect.runPromise(
    body.pipe(
      // `provideMerge`, so the body reads the same registry the runner registered into.
      Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(orchestrator), Layer.provideMerge(Gauges.Default))),
      Effect.provide(TestContext.TestContext),
    ),
  );

const liveTurns = Effect.gen(function* () {
  return (yield* Gauges).read("live_turns");
});

describe("the turn-retention map at idle", () => {
  it("returns to zero after the retention window with no further turns", async () => {
    await withRunner(
      completes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        yield* Stream.runDrain(yield* runner.run(turn("t-1")));
        expect(yield* liveTurns).toBe(1);

        yield* TestClock.adjust(Duration.seconds(90));
        expect(yield* liveTurns).toBe(0);
      }).pipe(Effect.orDie),
    );
  });

  it("holds a finished turn for the whole window, so a reconnect still re-attaches", async () => {
    await withRunner(
      completes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        yield* Stream.runDrain(yield* runner.run(turn("t-2")));
        yield* TestClock.adjust(Duration.seconds(30));
        expect(yield* liveTurns).toBe(1);
      }).pipe(Effect.orDie),
    );
  });

  it("bounds a turn whose fibre never finishes", async () => {
    await withRunner(
      neverFinishes,
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        yield* runner.run(turn("t-3"));
        expect(yield* liveTurns).toBe(1);

        // Past the retention window but far short of the lifetime ceiling; the entry has no
        // `finishedAt`, so the window cannot apply to it.
        yield* TestClock.adjust(Duration.seconds(90));
        expect(yield* liveTurns).toBe(1);

        yield* TestClock.adjust(Duration.seconds(300));
        expect(yield* liveTurns).toBe(0);
      }).pipe(Effect.orDie),
    );
  });
});
