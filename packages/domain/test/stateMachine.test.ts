import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  ADJACENCY,
  CONVERSATION_STATES,
  FORCED_TARGETS,
  OVERRIDE_TARGETS,
  closingPath,
  forcedTransition,
  isTerminal,
  overrideTransition,
  transition,
  triggerFor,
  type ConversationState,
} from "../src/index.js";

describe("state machine — exhaustive adjacency table", () => {
  it("every (from, to) pair is classified exactly as the SPEC §8.1 graph says", () => {
    for (const from of CONVERSATION_STATES) {
      for (const to of CONVERSATION_STATES) {
        const result = transition(from, to);
        if (to === from) {
          expect(Either.isRight(result), `${from} -> ${from} (stay)`).toBe(true);
        } else if (isTerminal(from)) {
          expect(Either.isLeft(result) && result.left.reason === "TERMINAL", `${from} -> ${to}`).toBe(true);
        } else if (ADJACENCY[from].has(to)) {
          expect(Either.isRight(result), `${from} -> ${to} should be legal`).toBe(true);
        } else if (OVERRIDE_TARGETS.has(to)) {
          expect(Either.isLeft(result) && result.left.reason === "OVERRIDE_ONLY", `${from} -> ${to}`).toBe(true);
        } else {
          expect(Either.isLeft(result) && result.left.reason === "NOT_ADJACENT", `${from} -> ${to}`).toBe(true);
        }
      }
    }
  });

  it("null / undefined suggestion means stay", () => {
    expect(transition("GREETING", null)).toEqual(Either.right("GREETING"));
    expect(transition("GREETING", undefined)).toEqual(Either.right("GREETING"));
  });

  it("the LLM can never jump GREETING -> CONFIRMING_OUTCOME (PRD §11 risk table)", () => {
    const r = transition("GREETING", "CONFIRMING_OUTCOME");
    expect(Either.isLeft(r)).toBe(true);
  });

  it("the LLM cannot suggest override targets directly (ESCALATED/OPT_OUT/WRONG_NUMBER) from GREETING", () => {
    for (const to of ["ESCALATED", "OPT_OUT", "WRONG_NUMBER"] as const) {
      const r = transition("GREETING", to);
      expect(Either.isLeft(r) && r.left.reason === "OVERRIDE_ONLY").toBe(true);
    }
  });

  it("DISCUSSING_PAYMENT -> OPT_OUT / WRONG_NUMBER are ordinary edges (SPEC §8.1)", () => {
    expect(Either.isRight(transition("DISCUSSING_PAYMENT", "OPT_OUT"))).toBe(true);
    expect(Either.isRight(transition("DISCUSSING_PAYMENT", "WRONG_NUMBER"))).toBe(true);
  });

  it("borrower may decline the read-back: CONFIRMING_OUTCOME -> DISCUSSING_PAYMENT", () => {
    expect(Either.isRight(transition("CONFIRMING_OUTCOME", "DISCUSSING_PAYMENT"))).toBe(true);
    expect(triggerFor("CONFIRMING_OUTCOME", "DISCUSSING_PAYMENT", "llm")).toBe("USER_DECLINED");
  });
});

describe("override and forced transitions", () => {
  const nonTerminal = CONVERSATION_STATES.filter((s) => !isTerminal(s));

  it("override targets are reachable from every non-terminal state", () => {
    for (const from of nonTerminal) {
      for (const to of OVERRIDE_TARGETS) {
        expect(Either.isRight(overrideTransition(from, to)), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("override transitions cannot target non-override states", () => {
    const r = overrideTransition("GREETING", "DISCUSSING_PAYMENT");
    expect(Either.isLeft(r) && r.left.reason === "NOT_ADJACENT").toBe(true);
  });

  it("forced targets (ENDING, VOICEMAIL) are reachable from every non-terminal state", () => {
    for (const from of nonTerminal) {
      for (const to of FORCED_TARGETS) {
        expect(Either.isRight(forcedTransition(from, to)), `${from} -> ${to}`).toBe(true);
      }
    }
    expect(Either.isLeft(forcedTransition("COMPLETED", "ENDING"))).toBe(true);
    expect(Either.isLeft(forcedTransition("GREETING", "OPT_OUT"))).toBe(true);
  });
});

describe("triggers and closing path", () => {
  it("stamps the trigger both runtimes must agree on", () => {
    expect(triggerFor("VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "llm")).toBe("RIGHT_PARTY_CONFIRMED");
    expect(triggerFor("DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME", "llm")).toBe("PROPOSAL");
    expect(triggerFor("GREETING", "VERIFYING_IDENTITY", "llm")).toBe("LLM_INTENT");
    expect(triggerFor("GREETING", "OPT_OUT", "override")).toBe("OVERRIDE_RULE");
    expect(triggerFor("GREETING", "VOICEMAIL", "amd")).toBe("AMD");
  });

  it("closingPath always ends in COMPLETED and never repeats ENDING", () => {
    expect(closingPath("DISCUSSING_PAYMENT")).toEqual([
      ["DISCUSSING_PAYMENT", "ENDING"],
      ["ENDING", "COMPLETED"],
    ]);
    expect(closingPath("ENDING")).toEqual([["ENDING", "COMPLETED"]]);
    expect(closingPath("COMPLETED")).toEqual([]);
    const all: ConversationState[] = [...CONVERSATION_STATES];
    for (const s of all) {
      const path = closingPath(s);
      if (path.length > 0) expect(path[path.length - 1]?.[1]).toBe("COMPLETED");
    }
  });
});
