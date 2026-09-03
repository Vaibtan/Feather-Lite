/**
 * `@langfuse/client`'s `ScoreManager.handleFlush` only logs `res.errors` and resolves cleanly
 * whatever happened, and `@langfuse/core`'s `LoggerConfig` exposes no sink to intercept, so the
 * batch response has to be inspected by hand.
 */
import { describe, expect, it } from "vitest";
import { langfuseIngestionProblems } from "../../src/services/Tracing.js";

describe("langfuseIngestionProblems", () => {
  it("says nothing about a batch Langfuse accepted", () => {
    expect(langfuseIngestionProblems({}, null)).toEqual([]);
    expect(langfuseIngestionProblems({ errors: [] }, null)).toEqual([]);
    expect(langfuseIngestionProblems(null, null)).toEqual([]);
  });

  it("reports a rejected score with its status and reason", () => {
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
    const problems = langfuseIngestionProblems(
      { errors: [{ id: "a", status: 400 }, { id: "b", status: 400 }, { id: "c", status: 500 }] },
      null,
    );
    expect(problems).toHaveLength(3);
  });

  it("reports a transport failure, which carries no response at all", () => {
    const problems = langfuseIngestionProblems(null, new Error("fetch failed"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fetch failed");
  });

  it("prefers the thrown error over any partial response", () => {
    expect(langfuseIngestionProblems({ errors: [{ id: "a", status: 400 }] }, new Error("boom"))).toEqual(["score ingestion failed: Error: boom"]);
  });

  it("still reports a rejection that arrives without a status or message", () => {
    const problems = langfuseIngestionProblems({ errors: [{}] }, null);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rejected");
  });
});
