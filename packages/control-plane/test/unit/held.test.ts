import { Duration, Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { HOLD_DEFAULT_MS, HOLD_MARGIN_MS } from "@feather-lite/domain";
import { Orchestrator, type TurnParams } from "../../src/services/Orchestrator.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";
import { Gauges } from "../../src/services/Gauges.js";

type Segment = { turnId: string; channel: string; startedAtMs: number; ttsAudioMs: number | null } | null;

const fakeOrchestrator = (segments: () => Segment, seen: TurnParams[]) =>
  Layer.succeed(
    Orchestrator,
    Orchestrator.make({
      processTurn: (params, emit) =>
        Effect.gen(function* () {
          seen.push(params);
          yield* emit({ type: "turn_start", turn_id: params.turnId, state: "CONFIRMING_OUTCOME" });
          return {
            turnId: params.turnId,
            decider: "model" as const,
            disposition: params.heldMs === undefined ? ("respond" as const) : ("held" as const),
            resolution: "spoke" as const,
            ...(params.heldMs === undefined ? {} : { heldMs: params.heldMs }),
            agentText: "ok",
            newState: "CONFIRMING_OUTCOME" as const,
            toolCalled: null,
            callControlAction: null,
            outcome: null,
            endCall: false,
            degraded: false,
            ttftMs: 10,
          };
        }),
      processNoInput: () => Effect.die("not exercised"),
      processSignal: () => Effect.die("not exercised"),
      unreportedNonInterruptible: () => Effect.sync(segments),
      releaseStrandedTurn: () => Effect.void,
    }),
  );

const turn = (turnId: string): TurnParams => ({ conversationId: "c-1", turnId, userText: "yes" });

const withRunner = (orchestrator: Layer.Layer<Orchestrator>, body: Effect.Effect<void, unknown, TurnRunner>) =>
  Effect.runPromise(
    body.pipe(
      Effect.orDie,Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(orchestrator), Layer.provide(Gauges.Default))), Effect.provide(TestContext.TestContext)),
  );

describe("the held phase", () => {
  it("does not hold when nothing is playing", async () => {
    const seen: TurnParams[] = [];
    await withRunner(
      fakeOrchestrator(() => null, seen),
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* (yield* TurnRunner).run(turn("t1")));
        yield* TestClock.adjust("1 second");
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.heldMs).toBeUndefined();
  });

  it("does not hold a simulated call, which never reports playout", async () => {
    const seen: TurnParams[] = [];
    await withRunner(
      fakeOrchestrator(() => ({ turnId: "rb-1", channel: "simulated", startedAtMs: 0, ttsAudioMs: 8000 }), seen),
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* (yield* TurnRunner).run(turn("t1")));
        yield* TestClock.adjust("1 second");
      }),
    );
    expect(seen[0]?.heldMs).toBeUndefined();
  });

  it("stops the moment the playout report lands, rather than waiting out the budget", async () => {
    const seen: TurnParams[] = [];
    let playing: Segment = { turnId: "rb-1", channel: "voice", startedAtMs: 0, ttsAudioMs: null };
    await withRunner(
      fakeOrchestrator(() => playing, seen),
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.flatMap((yield* TurnRunner).run(turn("t1")), Stream.runDrain));
        yield* TestClock.adjust("450 millis");
        playing = null;
        yield* TestClock.adjust("300 millis");
        yield* Fiber.join(fiber);
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.heldMs).toBeGreaterThan(0);
    expect(seen[0]?.heldMs ?? 0).toBeLessThan(HOLD_DEFAULT_MS);
  });

  it("gives up at the budget rather than holding the turn open forever", async () => {
    const seen: TurnParams[] = [];
    await withRunner(
      fakeOrchestrator(() => ({ turnId: "rb-1", channel: "voice", startedAtMs: 0, ttsAudioMs: 1000 }), seen),
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.flatMap((yield* TurnRunner).run(turn("t1")), Stream.runDrain));
        yield* TestClock.adjust(Duration.millis(1000 + HOLD_MARGIN_MS + 1000));
        yield* Fiber.join(fiber);
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.heldMs ?? 0).toBeGreaterThanOrEqual(1000);
  });
});
