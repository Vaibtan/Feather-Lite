import { describe, expect, it } from "vitest";
import { backchannel } from "../src/backchannel.js";

describe("backchannel", () => {
  const yes = ["yeah", "Yeah.", "okay", "OK", "ok", "right", "mm-hm", "mmhm", "mhm", "uh-huh", "uhhuh", "sure", "got it", "gotcha", "yep", "yup", "I see", "right right", "okay okay", "mm"];

  /** Observed from nova-3 with `filler_words` on: it returns "Mhmm.", not the "Mm-hm." a lexicon author would write. */
  const asDeepgramSpellsThem = ["Mhmm.", "mhmm", "Mm-hmm.", "mmhmm", "Uh-huh.", "Mm.", "Hm."];
  for (const t of asDeepgramSpellsThem) it(`treats the transcriber's own spelling ${JSON.stringify(t)} as a backchannel`, () => expect(backchannel(t)).toBe(true));
  for (const t of yes) it(`treats ${JSON.stringify(t)} as a backchannel`, () => expect(backchannel(t)).toBe(true));

  const no = [
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

  it("refuses anything long enough to carry content, whatever the words, because the interim grows as the borrower keeps talking", () => {
    expect(backchannel("okay okay okay okay okay okay")).toBe(false);
  });

  it("does not treat a bare yes or no as a backchannel, because a bare yes is the read-back confirmation the call exists for", () => {
    expect(backchannel("yes")).toBe(false);
    expect(backchannel("no")).toBe(false);
  });
});
