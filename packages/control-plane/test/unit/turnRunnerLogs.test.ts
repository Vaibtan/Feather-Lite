import { Effect, Layer, Logger, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationCompleted, NotFound } from "../../src/errors.js";
import { Orchestrator, type Emit, type TurnParams } from "../../src/services/Orchestrator.js";
import { Gauges } from "../../src/services/Gauges.js";
import { TurnRunner } from "../../src/http/TurnRunner.js";

interface Captured {
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

const capturing = (into: Captured[]) =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message, annotations }) => {
      into.push({ message, annotations: Object.fromEntries(annotations) });
    }),
  );

const orchestratorThat = (processTurn: (params: TurnParams, emit: Emit) => Effect.Effect<never, ConversationCompleted | NotFound>) =>
  Layer.succeed(Orchestrator, Orchestrator.make({ processTurn, processNoInput: () => Effect.die("not exercised"), processSignal: () => Effect.die("not exercised"), unreportedNonInterruptible: () => Effect.succeed(null), releaseStrandedTurn: () => Effect.void }));

const params = { conversationId: "c-9f2a", turnId: "t-4b71", userText: "yes" } satisfies TurnParams;

describe("TurnRunner failure logging", () => {
  it("carries the conversation and turn ids on the after-start failure line", async () => {
    const captured: Captured[] = [];
    const failsAfterStart = orchestratorThat((p, emit) =>
      emit({ type: "turn_start", turn_id: p.turnId, state: "CONFIRMING_OUTCOME" }).pipe(Effect.zipRight(Effect.fail(new ConversationCompleted({ conversationId: p.conversationId })))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        const frames = yield* runner.run(params);
        // Draining the stream waits for the turn to finish, which is when the line is logged.
        yield* Stream.runDrain(frames);
      }).pipe(Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(failsAfterStart), Layer.provide(Gauges.Default))), Effect.provide(capturing(captured)), Effect.orDie),
    );

    const line = captured.find((c) => String(c.message).includes("turn failed after start"));
    expect(line).toBeDefined();
    expect(line?.annotations["conversation_id"]).toBe(params.conversationId);
    expect(line?.annotations["turn_id"]).toBe(params.turnId);
  });

  it("does not log the after-start line for a failure that belongs to the caller", async () => {
    const captured: Captured[] = [];
    const failsAtStart = orchestratorThat(() => Effect.fail(new NotFound({ entity: "conversation", id: params.conversationId })));

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* TurnRunner;
        return yield* runner.run(params);
      }).pipe(Effect.provide(TurnRunner.DefaultWithoutDependencies.pipe(Layer.provide(failsAtStart), Layer.provide(Gauges.Default))), Effect.provide(capturing(captured))),
    );

    expect(exit._tag).toBe("Failure");
    expect(captured.some((c) => String(c.message).includes("turn failed after start"))).toBe(false);
  });
});
