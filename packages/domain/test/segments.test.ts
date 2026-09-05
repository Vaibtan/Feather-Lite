import { describe, expect, it } from "vitest";
import { playoutMatchesSegment, segmentsOf } from "../src/segments.js";

const say = (segmentId: string, mode: "interruptible" | "non_interruptible") => ({ segment_id: segmentId, text: `text ${segmentId}`, speak_mode: mode });

describe("segmentsOf", () => {
  it("reads the segments an agent turn names", () => {
    expect(segmentsOf({ text: "a b", state: "CONFIRMING_OUTCOME", turn_id: "t1", speak_mode: "non_interruptible", segments: [say("s1", "interruptible"), say("s2", "non_interruptible")] })).toEqual([
      { segmentId: "s1", text: "text s1", speakMode: "interruptible" },
      { segmentId: "s2", text: "text s2", speakMode: "non_interruptible" },
    ]);
  });

  it("treats a turn written before segment ids as its own single segment", () => {
    expect(segmentsOf({ text: "the whole turn", state: "CONFIRMING_OUTCOME", turn_id: "t1", speak_mode: "non_interruptible" })).toEqual([
      { segmentId: "t1", text: "the whole turn", speakMode: "non_interruptible" },
    ]);
  });

  it("defaults an unnamed speak mode to interruptible, as the schema does", () => {
    expect(segmentsOf({ text: "hello", state: "GREETING", turn_id: "t1" })).toEqual([{ segmentId: "t1", text: "hello", speakMode: "interruptible" }]);
  });

  it("has no segment to name when the turn had no id, and says so rather than inventing one", () => {
    expect(segmentsOf({ text: "Are you still there?", state: "GREETING" })).toEqual([]);
  });

  it("ignores an empty segment list, which is a turn that spoke through nothing else", () => {
    expect(segmentsOf({ text: "x", state: "GREETING", turn_id: "t1", segments: [] })).toEqual([{ segmentId: "t1", text: "x", speakMode: "interruptible" }]);
  });
});

describe("playoutMatchesSegment", () => {
  it("matches a playout to the segment it names", () => {
    expect(playoutMatchesSegment({ turn_id: "t1", segment_id: "s2", heard_text: "x", interrupted: false }, { segmentId: "s2", turnId: "t1" })).toBe(true);
  });

  it("does not match a playout naming another segment of the same turn", () => {
    expect(playoutMatchesSegment({ turn_id: "t1", segment_id: "s1", heard_text: "x", interrupted: false }, { segmentId: "s2", turnId: "t1" })).toBe(false);
  });

  it("treats a playout with no segment id as the turn's single segment, so old calls replay unchanged", () => {
    expect(playoutMatchesSegment({ turn_id: "t1", heard_text: "x", interrupted: false }, { segmentId: "t1", turnId: "t1" })).toBe(true);
  });

  it("still matches an old playout against a segment the turn has since named", () => {
    expect(playoutMatchesSegment({ turn_id: "t1", heard_text: "x", interrupted: false }, { segmentId: "s2", turnId: "t1" })).toBe(true);
  });

  it("does not match an old playout from a different turn", () => {
    expect(playoutMatchesSegment({ turn_id: "t0", heard_text: "x", interrupted: false }, { segmentId: "s2", turnId: "t1" })).toBe(false);
  });
});
