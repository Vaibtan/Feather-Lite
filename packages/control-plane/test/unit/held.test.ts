/**
 * The `held` phase: a turn waits for a non-interruptible segment before it claims (issue #1 D1, F2).
 *
 * Driven through `TurnRunner.run` against a fake orchestrator under `TestClock`, so the wait is
 * exact and the test is instant. The seam is what `processTurn` receives — a turn that was held
 * carries `heldMs`, and the ledger keeps it because `TurnResult` is serialised whole.
 */
import { Duration, Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { HOLD_DEFAULT_MS, HOLD_MARGIN_MS } from "@feather-lite/domain";
import { Orchestrator, type TurnParams } from "../../src/services/Orchestrator.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";
import { Gauges } from "../../src/services/Gauges.js";

type Segment = { turnId: string; channel: string; startedAtMs: number; ttsAudioMs: number | null } | null;

/** A fake orchestrator that records what `processTurn` was handed and what the runner asked for. */
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
    // Without this guard every non-voice turn would pay the full budget for a segment that finished
    // the instant it was written, because no worker will ever report it.
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
    // The common case, and the one that decides whether this is worth having: the segment finishes
    // long before the ceiling and the borrower is not made to wait for a timer.
    const seen: TurnParams[] = [];
    let playing: Segment = { turnId: "rb-1", channel: "voice", startedAtMs: 0, ttsAudioMs: null };
    await withRunner(
      fakeOrchestrator(() => playing, seen),
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.flatMap((yield* TurnRunner).run(turn("t1")), Stream.runDrain));
        yield* TestClock.adjust("450 millis");
        playing = null; // the worker's report arrives
        yield* TestClock.adjust("300 millis");
        yield* Fiber.join(fiber);
      }),
    );
    expect(seen).toHaveLength(1);
    // Held, and for far less than the default budget.
    expect(seen[0]?.heldMs).toBeGreaterThan(0);
    expect(seen[0]?.heldMs ?? 0).toBeLessThan(HOLD_DEFAULT_MS);
  });

  it("gives up at the budget rather than holding the turn open forever", async () => {
    /**
     * A wedged or unreported segment must not wedge the call. A turn that starts a little early is a
     * repeated read-back; a turn that never starts is a dead call, which is strictly worse.
     */
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
