import { describe, expect, it } from "vitest";
import { scoreTarget } from "../../src/index.js";

describe("scoreTarget", () => {
  it("names the trace alongside the observation, because the API rejects one without the other", () => {
    const target = scoreTarget("conv-1", { traceId: "trace-1", observationId: "obs-1" });
    expect(target).toEqual({ traceId: "trace-1", observationId: "obs-1" });
  });

  it("falls back to the conversation's session when the turn's span is not known", () => {
    expect(scoreTarget("conv-1", undefined)).toEqual({ sessionId: "conv-1" });
  });

  it("never returns an observation without a trace, and never mixes a session with either", () => {
    for (const span of [undefined, { traceId: "t", observationId: "o" }]) {
      const keys = Object.keys(scoreTarget("conv-1", span)).sort();
      expect(keys).toEqual(span === undefined ? ["sessionId"] : ["observationId", "traceId"]);
      expect(keys).not.toEqual(["observationId"]);
      expect(keys).not.toContain("datasetRunId");
    }
  });
});
