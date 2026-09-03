import { describe, expect, it } from "vitest";
import { unknownTurnIdMessage, unknownTurnIds } from "../../src/http/scoreTargets.js";

describe("unknownTurnIds", () => {
  const known = ["t1", "t2", "t3"];

  it("accepts turn ids the conversation actually has", () => {
    expect(unknownTurnIds(known, ["t1", "t3"])).toEqual([]);
  });

  it("accepts a call-level score, which names no turn", () => {
    expect(unknownTurnIds(known, [null, undefined, "t2"])).toEqual([]);
  });

  it("rejects the scripted label the harness used to post", () => {
    const posted = ["BARGE-IN: I can pay 550 dollars on Friday", "yes this is the borrower"];
    expect(unknownTurnIds(known, posted)).toEqual(posted);
  });

  it("names each bad id once, however many scores carried it", () => {
    expect(unknownTurnIds(known, ["nope", "nope", "nope", "t1"])).toEqual(["nope"]);
  });

  it("rejects everything when the conversation has no turns at all, bar a call-level score", () => {
    expect(unknownTurnIds([], ["t1"])).toEqual(["t1"]);
    expect(unknownTurnIds([], [null])).toEqual([]);
  });

  it("says which ids were wrong, and stops short of listing every one", () => {
    const message = unknownTurnIdMessage(["a", "b", "c", "d", "e"]);
    expect(message).toContain('"a"');
    expect(message).toContain('"c"');
    expect(message).not.toContain('"d"');
    expect(message).toContain("+2 more");
  });
});
