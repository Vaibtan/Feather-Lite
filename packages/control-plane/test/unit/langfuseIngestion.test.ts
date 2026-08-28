/**
 * Reading Langfuse's answer to a batch of scores (O7).
 *
 * The defect this exists for: every per-turn score was rejected 400 for weeks and nothing showed
 * it. `@langfuse/client`'s `ScoreManager.handleFlush` wraps each batch in
 * `.catch(err => this.logger.error(...))` and inspects `res.errors` only to log them, so `flush()`
 * resolves cleanly whatever happened — and `LoggerConfig` in `@langfuse/core` 5.10.1 takes a level,
 * a prefix and a timestamp flag, with no sink to intercept. Verified against the installed package,
 * not assumed: the spec had expected a logger hook to exist.
 *
 * So the call is made here and the answer read here, and this is the part that reads it.
 */
import { describe, expect, it } from "vitest";
import { langfuseIngestionProblems } from "../../src/services/Tracing.js";

describe("langfuseIngestionProblems", () => {
  it("says nothing about a batch Langfuse accepted", () => {
    expect(langfuseIngestionProblems({}, null)).toEqual([]);
    expect(langfuseIngestionProblems({ errors: [] }, null)).toEqual([]);
    expect(langfuseIngestionProblems(null, null)).toEqual([]);
  });

  it("reports a rejected score with its status and reason — the ADR 0009 failure", () => {
    // The exact shape that hid: a score naming an observation without its trace is a 400, the
    // batch as a whole resolves, and the SDK logs it to a console nobody was reading.
    const problems = langfuseIngestionProblems(
      { errors: [{ id: "abc123", status: 400, message: "observationId requires traceId" }] },
      null,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc123");
    expect(problems[0]).toContain("400");
    expect(problems[0]).toContain("observationId requires traceId");
  });

  it("reports every rejected score, not just the first", () => {
    // The count is what tells "one bad score" from "every per-turn score in the system".
    const problems = langfuseIngestionProblems(
      { errors: [{ id: "a", status: 400 }, { id: "b", status: 400 }, { id: "c", status: 500 }] },
      null,
    );
    expect(problems).toHaveLength(3);
  });

  it("reports a transport failure, which carries no response at all", () => {
    // `fetch failed` — a self-hosted Langfuse that is not running. Different from a 400 and worth
    // telling apart: one is our payload, the other is their availability.
    const problems = langfuseIngestionProblems(null, new Error("fetch failed"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fetch failed");
  });

  it("prefers the thrown error over any partial response", () => {
    // If the call threw, whatever half-response came back is not the story.
    expect(langfuseIngestionProblems({ errors: [{ id: "a", status: 400 }] }, new Error("boom"))).toEqual(["score ingestion failed: Error: boom"]);
  });

  it("still reports a rejection that arrives without a status or message", () => {
    // Langfuse is not obliged to fill either, and an unexplained rejection is still a rejection.
    const problems = langfuseIngestionProblems({ errors: [{}] }, null);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rejected");
  });
});
