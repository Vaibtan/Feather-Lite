/**
 * The process's gauges are a service with a zero default, not module-level `let`s (F5).
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Gauges } from "../../src/services/Gauges.js";

const run = <A>(e: Effect.Effect<A, never, Gauges>) => Effect.runPromise(e.pipe(Effect.provide(Gauges.Default)));

describe("Gauges", () => {
  it("reads zero for a gauge nothing has registered", async () => {
    // The property the module-level `let` was there to provide: a process that never built a
    // TurnRunner answers /status with zero rather than failing to answer at all.
    expect(await run(Effect.gen(function* () { return (yield* Gauges).read("live_turns"); }))).toBe(0);
  });

  it("reads what the owner registered", async () => {
    const out = await run(
      Effect.gen(function* () {
        const g = yield* Gauges;
        let n = 0;
        g.set("live_turns", () => n);
        n = 3;
        return g.read("live_turns");
      }),
    );
    // A supplier, not a snapshot: the owner keeps the state and the gauge asks for it.
    expect(out).toBe(3);
  });

  it("survives a supplier that throws, because /status must still answer", async () => {
    const out = await run(
      Effect.gen(function* () {
        const g = yield* Gauges;
        g.set("sse_streams", () => {
          throw new Error("map disposed");
        });
        return g.read("sse_streams");
      }),
    );
    expect(out).toBe(0);
  });

  it("gives each instance its own registry, so one build cannot clobber another", async () => {
    // The defect in `export let`: two TurnRunners in one process shared one slot, and the second
    // silently replaced the first's closure — which is every test file that builds one.
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Effect.provide(Effect.gen(function* () {
          const g = yield* Gauges;
          g.set("live_turns", () => 7);
          return g.read("live_turns");
        }), Gauges.Default);
        const b = yield* Effect.provide(Effect.gen(function* () { return (yield* Gauges).read("live_turns"); }), Gauges.Default);
        return { a, b };
      }),
    );
    expect(out).toEqual({ a: 7, b: 0 });
  });
});
