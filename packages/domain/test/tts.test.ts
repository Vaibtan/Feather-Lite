/**
 * TTS heuristics (spec 2026-08-26, D5). Two questions only: did the synthesis produce audio at all,
 * and was the speaking rate wildly unlike the rest of the run. Neither is a claim about how the
 * speech *sounded* — see the module doc for why there is no MOS model here.
 */
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeEventRecord, silentPlayoutTurnIds, ttsAggregate, ttsScores, type EventRecord } from "../src/index.js";

const playout = (payload: Record<string, unknown>): EventRecord => {
  const decoded = decodeEventRecord({ sequence_no: 1, created_at: "2026-08-26T10:00:00.000Z", type: "AGENT_TURN_PLAYOUT", payload });
  if (Either.isLeft(decoded)) throw new Error(`fixture invalid: ${JSON.stringify(payload)}`);
  return decoded.right;
};

const superseded = (turnId: string, by: string): EventRecord => {
  const decoded = decodeEventRecord({ sequence_no: 2, created_at: "2026-08-26T10:00:01.000Z", type: "TURN_SUPERSEDED", payload: { turn_id: turnId, superseded_by: by } });
  if (Either.isLeft(decoded)) throw new Error("fixture invalid");
  return decoded.right;
};

describe("silentPlayoutTurnIds", () => {
  const ids = (events: ReadonlyArray<EventRecord>) => [...silentPlayoutTurnIds(events)];

  it("finds a playout that reported nothing heard and was cut short", () => {
    expect(ids([playout({ turn_id: "t1", heard_text: "", interrupted: true })])).toEqual(["t1"]);
  });

  it("ignores a turn the borrower heard in full", () => {
    expect(ids([playout({ turn_id: "t1", heard_text: "Hello there.", interrupted: false })])).toEqual([]);
  });

  it("ignores a barge-in that cut real speech short", () => {
    // The borrower talking over the agent mid-sentence is a healthy call, not a broken voice.
    expect(ids([playout({ turn_id: "t1", heard_text: "Hello th", interrupted: true })])).toEqual([]);
  });

  it("ignores an empty playout that was never cut short", () => {
    // The voice runtime signals a zero-audio turn by reporting it interrupted (ADR 0008): the
    // framework force-closes the item, so "played in full and said nothing" is a different, and
    // much less alarming, shape than the failure this predicate exists to catch.
    expect(ids([playout({ turn_id: "t1", heard_text: "", interrupted: false })])).toEqual([]);
  });

  it("ignores a turn the borrower superseded before the agent ever replied", () => {
    // Measured on a fleet run: the scripted borrower says "Actually, wait." and then immediately
    // the real sentence, superseding the first turn before any reply exists. Nothing was heard
    // because nothing was synthesised. Counting it put the fleet's silent-playout rate at 22% when
    // one turn in eighteen had genuinely failed.
    expect(ids([playout({ turn_id: "t1", heard_text: "", interrupted: true }), superseded("t1", "t2")])).toEqual([]);
  });

  it("still finds a real failure on a call that also had a superseded turn", () => {
    const events = [
      playout({ turn_id: "t1", heard_text: "", interrupted: true }),
      superseded("t1", "t2"),
      playout({ turn_id: "t3", heard_text: "", interrupted: true }),
    ];
    expect(ids(events)).toEqual(["t3"]);
  });
});

describe("ttsScores", () => {
  it("scores a silent turn and derives chars-per-second from the audio it produced", () => {
    const s = ttsScores("c1", [
      { turnId: "t1", audioMs: 2000, chars: 30, silent: false },
      { turnId: "t2", audioMs: 0, chars: 40, silent: true },
    ]);
    expect(s.map((x) => [x.name, x.turnId, x.value])).toEqual([
      ["tts.silent_playout", "t1", 0],
      ["tts.chars_per_second", "t1", 15],
      ["tts.silent_playout", "t2", 1],
    ]);
  });

  it("does not derive a rate from a turn that produced no audio", () => {
    // Dividing by a zero duration is not "infinitely fast speech"; it is a turn that never played,
    // which the silent-playout score already reports.
    const s = ttsScores("c1", [{ turnId: "t1", audioMs: 0, chars: 40, silent: true }]);
    expect(s.filter((x) => x.name === "tts.chars_per_second")).toEqual([]);
  });

  it("scores nothing at all for a turn that had no voice runtime", () => {
    // A JSON simulation synthesises nothing, so "did the TTS play?" is unanswerable rather than
    // fine — reporting silent_playout: 0 would claim a synthesis that never happened went well.
    expect(ttsScores("c1", [{ turnId: "t1", audioMs: null, chars: null, silent: false }])).toEqual([]);
  });

  it("still scores a silent turn even with no TTS shape, because the playout is the evidence", () => {
    const s = ttsScores("c1", [{ turnId: "t1", audioMs: null, chars: null, silent: true }]);
    expect(s.map((x) => [x.name, x.value])).toEqual([["tts.silent_playout", 1]]);
  });
});

describe("ttsAggregate", () => {
  const turn = (turnId: string, audioMs: number | null, chars: number | null, silent = false) => ({ turnId, audioMs, chars, silent, ttfbMs: null });
  /** `chars` for a given rate over a 1 s utterance, so the fixtures read as the rate they test. */
  const atRate = (turnId: string, cps: number, silent = false) => turn(turnId, 1000, cps, silent);

  it("reports nothing rather than zero when no turn had a voice runtime", () => {
    // A window of simulated calls has no synthesis in it. A silent-playout rate of 0 there would
    // read as "the voice worked on every turn", which is the opposite of "we never checked".
    const a = ttsAggregate([turn("t1", null, null)]);
    expect(a.turns).toBe(0);
    expect(a.silentPlayoutRate).toBeNull();
    expect(a.charsPerSecond.median).toBeNull();
    expect(a.outliers).toEqual([]);
  });

  it("rates silent playouts against the turns that actually tried to speak", () => {
    const a = ttsAggregate([atRate("t1", 15), atRate("t2", 15), turn("t3", 0, 20, true), turn("t4", null, null)]);
    expect(a.turns).toBe(3);
    expect(a.silentPlayouts).toBe(1);
    expect(a.silentPlayoutRate).toBeCloseTo(1 / 3, 6);
  });

  it("takes the median of the readings, not the mean, so one broken turn cannot move the baseline", () => {
    const a = ttsAggregate([atRate("t1", 14), atRate("t2", 15), atRate("t3", 16), atRate("t4", 400)]);
    expect(a.charsPerSecond.median).toBe(15.5);
  });

  it("flags a turn beyond ±40% of the median in either direction", () => {
    // 15 chars/s is a normal speaking rate for this voice. A turn at 30 is speech played at double
    // speed or a truncated synthesis; one at 5 is a stalled stream. Both deserve a human ear.
    const a = ttsAggregate([atRate("t1", 15), atRate("t2", 15), atRate("t3", 15), atRate("t4", 30), atRate("t5", 5)]);
    expect(a.outliers.map((o) => o.turnId).sort()).toEqual(["t4", "t5"]);
    expect(a.outliers.find((o) => o.turnId === "t4")?.deviation).toBeCloseTo(1, 6);
    expect(a.outliers.find((o) => o.turnId === "t5")?.deviation).toBeCloseTo(-2 / 3, 6);
  });

  it("leaves a turn just inside the band alone", () => {
    const a = ttsAggregate([atRate("t1", 15), atRate("t2", 15), atRate("t3", 15), atRate("t4", 20.9)]);
    expect(a.outliers).toEqual([]);
  });

  it("does not call anything an outlier until there are enough readings to have a baseline", () => {
    // With two readings the median sits exactly between them, so each is equally far from it and
    // "the outlier" is whichever one you name first. That is not a finding.
    const a = ttsAggregate([atRate("t1", 5), atRate("t2", 30)]);
    expect(a.charsPerSecond.n).toBe(2);
    expect(a.outliers).toEqual([]);
    expect(a.baselineReadings).toBe(3);
  });

  it("reports the worst outlier first, so a printed report can show one line", () => {
    const a = ttsAggregate([atRate("t1", 15), atRate("t2", 15), atRate("t3", 15), atRate("t4", 25), atRate("t5", 60)]);
    expect(a.outliers.map((o) => o.turnId)).toEqual(["t5", "t4"]);
  });

  it("reports how long the voice took to make its first sound, over the same turns", () => {
    // D5 asks for TTFB beside the rate. Same reading the SLO gates on, repeated here so the speech
    // block reads on its own: an operator looking at "the voice" should not have to cross-reference
    // the latency card to learn that it took two seconds to start talking.
    const withTtfb = (turnId: string, ttfbMs: number | null) => ({ turnId, audioMs: 1000, chars: 15, silent: false, ttfbMs });
    const a = ttsAggregate([withTtfb("t1", 300), withTtfb("t2", 400), withTtfb("t3", 2000), withTtfb("t4", null)]);
    expect(a.ttfbMs.n).toBe(3);
    expect(a.ttfbMs.p50).toBe(400);
    expect(a.ttfbMs.p95).toBe(2000);
  });

  it("has no TTFB to report when no turn measured one", () => {
    const a = ttsAggregate([turn("t1", 1000, 15)]);
    expect(a.ttfbMs).toEqual({ n: 0, p50: null, p95: null });
  });

  it("ignores a silent turn when computing the rate baseline", () => {
    // A zero-duration turn has no rate. Folding it in as 0 would drag the median toward zero and
    // then flag every healthy turn as a fast outlier.
    const a = ttsAggregate([atRate("t1", 15), atRate("t2", 15), atRate("t3", 15), turn("t4", 0, 40, true)]);
    expect(a.charsPerSecond.n).toBe(3);
    expect(a.charsPerSecond.median).toBe(15);
    expect(a.outliers).toEqual([]);
  });
});
