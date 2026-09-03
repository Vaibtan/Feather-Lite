import { Cause, Chunk, Duration, Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationCompleted } from "../../src/errors.js";
import { Orchestrator, type Emit, type TurnParams } from "../../src/services/Orchestrator.js";
import type { TurnResult } from "../../src/services/types.js";
import { Gauges } from "../../src/services/Gauges.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";

/** The delay is the point: it is the window in which a second client can attach. */
const failsInT1 = Layer.succeed(
  Orchestrator,
  Orchestrator.make({
    // This stub only ever fails, so the cast to the declared `TurnResult` success type goes
    // through `unknown` rather than pretending the two overlap.
    processTurn: (p: TurnParams, _emit: Emit): Effect.Effect<TurnResult> =>
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.zipRight(Effect.fail(new ConversationCompleted({ conversationId: p.conversationId }))),
      ) as unknown as Effect.Effect<TurnResult>,
    processNoInput: () => Effect.die("not exercised"),
    processSignal: () => Effect.die("not exercised"),
    // Nothing is playing, so the `held` phase is a no-op and these tests time exactly T1.
    unreportedNonInterruptible: () => Effect.succeed(null),
    releaseStrandedTurn: () => Effect.void,
  }),
);

const turn: TurnParams = { conversationId: "c-1", turnId: "t-1", userText: "yes" };

describe("a turn whose T1 fails after a second client attached", () => {
  it("ends the attached subscriber's stream instead of leaving it open forever", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* TurnRunner;

        const first = yield* Effect.fork(runner.run(turn));
        yield* TestClock.adjust(Duration.millis(1)); // let the daemon claim the entry

        const attached = yield* runner.run(turn);
        const drained = yield* Effect.fork(Stream.runCollect(attached));

        yield* TestClock.adjust(Duration.seconds(2));

        const firstResult = yield* Fiber.await(first);
        expect(Cause.isFailure(firstResult._tag === "Failure" ? firstResult.cause : Cause.empty)).toBe(true);

        // Without the fix this `Fiber.join` never returns and the test times out instead of failing.
        const frames = Chunk.toReadonlyArray(yield* Fiber.join(drained));
        expect(frames.some((f) => f.type === "error")).toBe(true);
      }).pipe(
        Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(failsInT1), Layer.provide(Gauges.Default))),
        Effect.provide(TestContext.TestContext),
        Effect.orDie,
      ),
    );
  }, 15_000);
});
