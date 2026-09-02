/**
 * A subscriber attached during T1 is told when T1 fails (C6).
 *
 * Two clients can be on one turn: the voice worker opens the turn, and a reconnect — or the console
 * watching the same call — attaches to it by turn id while T1 is still running. `run` hands the
 * second one a stream fed from the live turn's queue.
 *
 * When T1 then failed *before* `turn_start`, the failure branch deleted the map entry and failed the
 * deferred the first caller was waiting on, and never told the queue. The first caller got its 404
 * or 409; the second caller's SSE stream simply never ended, and the connection stayed open until
 * something else closed it.
 *
 * The seam is the subscriber's stream: it must terminate, and it must say why.
 */
import { Cause, Chunk, Duration, Effect, Fiber, Layer, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationCompleted } from "../../src/errors.js";
import { Orchestrator, type Emit, type TurnParams } from "../../src/services/Orchestrator.js";
import type { TurnResult } from "../../src/services/types.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";

/**
 * A T1 that takes a moment and then refuses the turn. The delay is the point: it is the window in
 * which a second client can attach, which is the whole of this failure.
 */
const failsInT1 = Layer.succeed(
  Orchestrator,
  Orchestrator.make({
    // The stub's declared success type is `TurnResult`, like `turnRetention.test.ts`'s; this one
    // only ever fails, so the cast is through `unknown` rather than pretending the two overlap.
    processTurn: (p: TurnParams, _emit: Emit): Effect.Effect<TurnResult> =>
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.zipRight(Effect.fail(new ConversationCompleted({ conversationId: p.conversationId }))),
      ) as unknown as Effect.Effect<TurnResult>,
    processNoInput: () => Effect.die("not exercised"),
    processSignal: () => Effect.die("not exercised"),
  }),
);

const turn: TurnParams = { conversationId: "c-1", turnId: "t-1", userText: "yes" };

describe("a turn whose T1 fails after a second client attached", () => {
  it("ends the attached subscriber's stream instead of leaving it open forever", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* TurnRunner;

        // The first caller. `run` blocks until T1 either starts the turn or fails, so it is forked.
        const first = yield* Effect.fork(runner.run(turn));
        yield* TestClock.adjust(Duration.millis(1)); // let the daemon claim the entry

        // The second caller attaches to the turn already in the map, and gets a stream.
        const attached = yield* runner.run(turn);
        const drained = yield* Effect.fork(Stream.runCollect(attached));

        // T1 fails.
        yield* TestClock.adjust(Duration.seconds(2));

        const firstResult = yield* Fiber.await(first);
        // The first caller still gets its own error, unchanged.
        expect(Cause.isFailure(firstResult._tag === "Failure" ? firstResult.cause : Cause.empty)).toBe(true);

        // And the second caller's stream terminates rather than hanging. Without the fix this
        // `Fiber.join` never returns and the test times out.
        const frames = Chunk.toReadonlyArray(yield* Fiber.join(drained));
        // It is told what happened, rather than just being cut off.
        expect(frames.some((f) => f.type === "error")).toBe(true);
      }).pipe(
        Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(failsInT1))),
        Effect.provide(TestContext.TestContext),
        Effect.orDie,
      ),
    );
  }, 15_000);
});
