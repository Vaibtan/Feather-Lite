/**
 * T1's failure is a type the orchestrator owns, not a shape its caller re-derives (F6).
 */
import { describe, expect, it } from "vitest";
import { Cause } from "effect";
import { ConversationCompleted, NotFound, TURN_START_ERROR_TAGS, TurnInProgress, TurnSuperseded, turnStartErrorOf } from "../../src/errors.js";

describe("turnStartErrorOf", () => {
  it("finds each of the four T1 failures in a cause", () => {
    const errs = [
      new NotFound({ entity: "conversation", id: "c1" }),
      new ConversationCompleted({ conversationId: "c1" }),
      new TurnInProgress({ conversationId: "c1", activeTurnId: "t0" }),
      new TurnSuperseded({ conversationId: "c1", turnId: "t1" }),
    ];
    for (const e of errs) expect(turnStartErrorOf(Cause.fail(e))?._tag).toBe(e._tag);
  });

  it("returns null for a failure that is not one of them", () => {
    // A defect in T1 is not a start error: the caller must report INTERNAL, not a 409.
    expect(turnStartErrorOf(Cause.fail(new Error("pool exhausted")))).toBeNull();
    expect(turnStartErrorOf(Cause.die(new Error("boom")))).toBeNull();
  });

  it("finds one inside a parallel cause, where a bare failureOption would not", () => {
    const wanted = new TurnInProgress({ conversationId: "c1", activeTurnId: "t0" });
    const cause = Cause.parallel(Cause.fail(new Error("unrelated")), Cause.fail(wanted));
    expect(turnStartErrorOf(cause)?._tag).toBe("TurnInProgress");
  });

  it("lists exactly the four tags, so adding a fifth failure updates one place", () => {
    expect([...TURN_START_ERROR_TAGS].sort()).toEqual(["ConversationCompleted", "NotFound", "TurnInProgress", "TurnSuperseded"]);
  });
});
