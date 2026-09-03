import { describe, expect, it } from "vitest";
import { holdRequest } from "../src/holdRequest.js";
import { NUDGE_WINDOW_MS, SILENCE_WINDOW_MS, WAIT_WINDOW_BARE_MS, WAIT_WINDOW_ERRAND_MS, waitWindowMs } from "../src/waitPolicy.js";

describe("waitWindowMs", () => {
  it("gives a bare hold the short window", () => expect(waitWindowMs("bare")).toBe(WAIT_WINDOW_BARE_MS));
  it("gives an errand hold the long window", () => expect(waitWindowMs("errand")).toBe(WAIT_WINDOW_ERRAND_MS));

  it("nudges a bare hold sooner than an errand hold", () => expect(waitWindowMs("bare")).toBeLessThan(waitWindowMs("errand")));

  it("closes a bare hold at the twenty seconds the policy claims", () => expect(waitWindowMs("bare") + NUDGE_WINDOW_MS).toBe(20_000));

  it("never nudges an errand sooner than an ordinary silence", () => expect(waitWindowMs("errand")).toBeGreaterThanOrEqual(SILENCE_WINDOW_MS));
});

describe("the window an utterance earns", () => {
  const windowFor = (text: string) => {
    const hold = holdRequest(text);
    return hold === null ? null : waitWindowMs(hold.kind);
  };

  const short = ["wait", "Actually, wait.", "hold on", "one second", "just a moment", "hang on", "bear with me"];
  for (const t of short) it(`nudges after ${JSON.stringify(t)} in ${String(WAIT_WINDOW_BARE_MS)}ms`, () => expect(windowFor(t)).toBe(WAIT_WINDOW_BARE_MS));

  const long = ["hold on, let me get my card", "let me check", "give me a minute", "hang on a minute", "one second, let me find my wallet"];
  for (const t of long) it(`waits ${String(WAIT_WINDOW_ERRAND_MS)}ms after ${JSON.stringify(t)}`, () => expect(windowFor(t)).toBe(WAIT_WINDOW_ERRAND_MS));

  it("has no window for something that is not a hold", () => expect(windowFor("I can pay 550 on Friday")).toBeNull());
});
