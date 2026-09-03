import { Effect, Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
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

describe("deterministic scenario suite against the real orchestrator + Postgres", () => {
  for (const def of SCENARIOS) {
    it(def.id, async () => {
      const result = await rt.runPromise(Effect.flatMap(ScenarioRunner, (r) => r.run(def.id)));
      if (!result.passed) {
        console.log(`\n--- ${def.id} ---\n${result.assertion_failures.join("\n")}\nstate path: ${result.actual_state_path.join(" > ")}\nframes:\n${result.frames.map((f) => JSON.stringify(f)).join("\n")}`);
      }
      expect(result.assertion_failures).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }

  it("records the suite's pass rate as a score, against a fresh synthetic id each run", async () => {
    // The suite is a test run, not a call, so it is scored against an id that has no `conversations` row.
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const runner = yield* ScenarioRunner;
        // Counted as a delta, because the DB suite shares one database with another file that writes this score.
        const before = yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversation_scores WHERE name = 'scenario.pass_rate'`;
        const first = yield* runner.runAll();
        const second = yield* runner.runAll();
        const rows = yield* sql<{ conversationId: string; value: number; comment: string | null; source: string; evidence: Record<string, unknown> | null }>`
          SELECT conversation_id, value, comment, source, evidence FROM conversation_scores
          WHERE name = 'scenario.pass_rate' ORDER BY created_at DESC LIMIT 2`;
        return { first, second, rows, before: Number(before[0]?.n ?? 0), after: Number((yield* sql<{ n: string }>`SELECT count(*)::text AS n FROM conversation_scores WHERE name = 'scenario.pass_rate'`)[0]?.n ?? 0) };
      }),
    );
    expect(out.first.every((r) => r.passed)).toBe(true);
    expect(out.after - out.before).toBe(2);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.value)).toEqual([1, 1]);
    expect(out.rows[0]!.source).toBe("SCENARIO");
    expect(out.rows[0]!.comment).toBe(`${SCENARIOS.length}/${SCENARIOS.length} scenarios passed`);
    expect(out.rows[0]!.evidence).toMatchObject({ failed: [], total: SCENARIOS.length });
    expect(out.rows[0]!.conversationId).not.toBe(out.rows[1]!.conversationId);
  });
});
