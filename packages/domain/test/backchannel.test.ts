/**
 * "mm-hm" — the borrower listening, not interrupting (issue #1, D1's `resume`).
 *
 * Same lexicon family as `holdRequest`, and the same rule about content (user story 24: the
 * classifiers are pure domain functions with table tests, so their lexicons are reviewable and their
 * misses reproducible). This one runs on the **interim** transcript, so it must be decisive on very
 * little text and must never claim a partial sentence is a backchannel.
 */
import { describe, expect, it } from "vitest";
import { backchannel } from "../src/backchannel.js";

describe("backchannel", () => {
  const yes = ["yeah", "Yeah.", "okay", "OK", "ok", "right", "mm-hm", "mmhm", "mhm", "uh-huh", "uhhuh", "sure", "got it", "gotcha", "yep", "yup", "I see", "right right", "okay okay", "mm"];
  for (const t of yes) it(`treats ${JSON.stringify(t)} as a backchannel`, () => expect(backchannel(t)).toBe(true));

  const no = [
    // The failure that matters: a real interruption must never be mistaken for listening, because
    // resuming over a borrower who is actually speaking is worse than pausing for one who is not.
    "okay but I can't pay that",
    "yeah, that's wrong",
    "right, so when is it due",
    "sure, but hold on",
    "no",
    "stop",
    "wait",
    "I can pay 550 on Friday",
    "yes",
    "yes that's correct",
    "",
    "   ",
  ];
  for (const t of no) it(`does not treat ${JSON.stringify(t)} as a backchannel`, () => expect(backchannel(t)).toBe(false));

  it("refuses anything long enough to carry content, whatever the words", () => {
    // The interim grows as the borrower keeps talking; length alone must be able to cancel a resume.
    expect(backchannel("okay okay okay okay okay okay")).toBe(false);
  });

  it("does not treat a bare yes or no as a backchannel", () => {
    /**
     * Both are answers. "yes" during the promise read-back is the confirmation the whole call is
     * for, and resuming over it would be the exact defect D1 exists to fix, one layer down.
     */
    expect(backchannel("yes")).toBe(false);
    expect(backchannel("no")).toBe(false);
  });
});
