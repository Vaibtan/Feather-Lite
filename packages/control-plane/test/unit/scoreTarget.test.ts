/**
 * Where a score attaches in Langfuse.
 *
 * This exists because of a silent bug, not a hypothetical one. The first version sent a turn-level
 * score as `{ observationId }` alone; Langfuse's ingestion API answers that with
 *
 *   400 "Provide exactly one of the following: traceId (with optional observationId), sessionId or
 *        datasetRunId. ObservationId requires traceId."
 *
 * and the SDK reports it on its own logger rather than through the promise the caller awaits. So
 * every per-turn score was dropped, and dropped *precisely* in the case the code was written for —
 * a turn whose span was still known. The ones that reached Langfuse were the ones whose span had
 * aged out and taken the session fallback, which is why the symptom looked like a flush problem.
 *
 * The real oracle is Langfuse itself, and there is no seam that reaches it without a running
 * server. What can be pinned here is the request shape: exactly one target, and never an
 * observation without its trace.
 */
import { describe, expect, it } from "vitest";
import { scoreTarget } from "../../src/index.js";

describe("scoreTarget", () => {
  it("names the trace alongside the observation, because the API rejects one without the other", () => {
    const target = scoreTarget("conv-1", { traceId: "trace-1", observationId: "obs-1" });
    expect(target).toEqual({ traceId: "trace-1", observationId: "obs-1" });
  });

  it("falls back to the conversation's session when the turn's span is not known", () => {
    // Degraded placement — the score lands on the call rather than the turn — but never a dropped
    // measurement. The turn id travels in the comment, which the caller adds.
    expect(scoreTarget("conv-1", undefined)).toEqual({ sessionId: "conv-1" });
  });

  it("never returns an observation without a trace, and never mixes a session with either", () => {
    // The invariant the ingestion API enforces, stated here so a future edit trips over it.
    for (const span of [undefined, { traceId: "t", observationId: "o" }]) {
      const keys = Object.keys(scoreTarget("conv-1", span)).sort();
      expect(keys).toEqual(span === undefined ? ["sessionId"] : ["observationId", "traceId"]);
      // The two failure shapes the API rejects outright.
      expect(keys).not.toEqual(["observationId"]);
      expect(keys).not.toContain("datasetRunId");
    }
  });
});
