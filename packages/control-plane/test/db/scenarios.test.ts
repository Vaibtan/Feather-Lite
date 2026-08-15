import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIOS, ScenarioRunner } from "../../src/index.js";
import { makeInfraLayer, makeRuntime, truncateAll } from "./harness.js";

const layer = ScenarioRunner.Default.pipe(Layer.provideMerge(makeInfraLayer()));
const rt = makeRuntime(layer);

beforeAll(async () => {
  await rt.runPromise(truncateAll);
});
afterAll(async () => {
  await rt.dispose();
});

describe("deterministic scenario suite (SPEC §18) against the real orchestrator + Postgres", () => {
  for (const def of SCENARIOS) {
    it(def.id, async () => {
      const result = await rt.runPromise(Effect.flatMap(ScenarioRunner, (r) => r.run(def.id)));
      if (!result.passed) {
        // Print the timeline to make failures diagnosable from the test output alone.
        console.log(`\n--- ${def.id} ---\n${result.assertion_failures.join("\n")}\nstate path: ${result.actual_state_path.join(" > ")}\nframes:\n${result.frames.map((f) => JSON.stringify(f)).join("\n")}`);
      }
      expect(result.assertion_failures).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }
});
