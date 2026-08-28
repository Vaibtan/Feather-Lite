/**
 * `POST /scores` must not accept a turn id that names no turn of the conversation (O8).
 *
 * The defect this pins: the handler validated the conversation and not the turn, so the voice
 * harness posted the line it had spoken — `"BARGE-IN: I can pay 550 dollars on Friday"` — as a
 * `turn_id` for weeks. Every row landed, joined nothing, and took the session-level fallback in
 * `Tracing.score`. Nothing was lost and nothing complained.
 */
import { describe, expect, it } from "vitest";
import { unknownTurnIdMessage, unknownTurnIds } from "../../src/http/scoreTargets.js";

describe("unknownTurnIds", () => {
  const known = ["t1", "t2", "t3"];

  it("accepts turn ids the conversation actually has", () => {
    expect(unknownTurnIds(known, ["t1", "t3"])).toEqual([]);
  });

  it("accepts a call-level score, which names no turn", () => {
    // `harness.equivalence_pass` and the WER summary are about the call, not a turn.
    expect(unknownTurnIds(known, [null, undefined, "t2"])).toEqual([]);
  });

  it("rejects the scripted label the harness used to post", () => {
    const posted = ["BARGE-IN: I can pay 550 dollars on Friday", "yes this is the borrower"];
    expect(unknownTurnIds(known, posted)).toEqual(posted);
  });

  it("names each bad id once, however many scores carried it", () => {
    // Ten scores against one bad turn is one mistake. A caller reading ten copies of the same id
    // learns nothing it did not know from the first.
    expect(unknownTurnIds(known, ["nope", "nope", "nope", "t1"])).toEqual(["nope"]);
  });

  it("rejects everything when the conversation has no turns at all", () => {
    expect(unknownTurnIds([], ["t1"])).toEqual(["t1"]);
    // ...but a call-level score against a turnless conversation is still fine.
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
