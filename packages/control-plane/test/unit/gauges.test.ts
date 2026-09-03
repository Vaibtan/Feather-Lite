import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Gauges } from "../../src/services/Gauges.js";

const run = <A>(e: Effect.Effect<A, never, Gauges>) => Effect.runPromise(e.pipe(Effect.provide(Gauges.Default)));

describe("Gauges", () => {
  it("reads zero for a gauge nothing has registered", async () => {
    expect(await run(Effect.gen(function* () { return (yield* Gauges).read("live_turns"); }))).toBe(0);
  });

  it("reads the supplier's current value, not a snapshot taken when it was registered", async () => {
    const out = await run(
      Effect.gen(function* () {
        const g = yield* Gauges;
        let n = 0;
        g.set("live_turns", () => n);
        n = 3;
        return g.read("live_turns");
      }),
    );
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
