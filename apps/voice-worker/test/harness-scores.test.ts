/**
 * Which ledger turn a harness measurement belongs to, and what happens when the answer is "none"
 * (review #10).
 *
 * The defect: per-turn scores that could not be joined were posted with `turn_id: null`, and the
 * score key is `(conversation_id, turn_id, name, source)` with `NULLS NOT DISTINCT` and an upsert
 * (`migrations/0002_scores.ts:44`). So N per-line `stt.wer` rows were never N rows — they collapsed
 * onto each other and onto the call-level mean posted under the same name, last write winning,
 * while the harness reported having written N+1.
 *
 * Positional pairing was the reason they could not be joined: it holds only while the two lists
 * describe the same turns, and a barge-in adds a turn row the harness never measured.
 */
import { describe, expect, it } from "vitest";
import { buildHarnessScores, matchLedgerTurns } from "../src/tracer/harness-scores.js";

const turn = (id: string, startedAtMs: number) => ({ turn_id: id, startedAtMs });

describe("matchLedgerTurns", () => {
  it("joins each measurement to the turn the control plane opened after it", () => {
    // The measurement is anchored to the borrower falling silent; the turn row is created when the
    // worker posts the committed turn, which is always afterwards.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }, { atMs: 9_000 }];
    const turns = [turn("t1", 1_400), turn("t2", 5_600), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t2", "t3"]);
  });

  it("survives a turn row the harness never measured — the barge-in case", () => {
    // This is what positional pairing could not do: an extra row in the middle shifted every
    // later measurement onto the wrong turn, so the old code refused to join anything at all.
    const measurements = [{ atMs: 1_000 }, { atMs: 9_000 }];
    const turns = [turn("t1", 1_400), turn("barge-in", 4_000), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t3"]);
  });

  it("claims each turn once, so two measurements cannot land on one row", () => {
    // The two measurements a single line produces - its WER and its response latency - are matched
    // in separate passes, but within one pass two lines must never share a turn.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }];
    const turns = [turn("t1", 1_400), turn("t2", 5_400)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t2"]);
  });

  it("returns null where there is no turn left to claim", () => {
    // A line the agent never answered leaves a measurement with no row behind it.
    const measurements = [{ atMs: 1_000 }, { atMs: 9_000 }];
    expect(matchLedgerTurns(measurements, [turn("t1", 1_400)])).toEqual(["t1", null]);
    expect(matchLedgerTurns(measurements, [])).toEqual([null, null]);
  });

  it("does not let a line with no turn reach forward and steal the next line's", () => {
    // The bug the upper bound exists for. B was never answered, so there is no turn between B and
    // C; without bounding B's window by C's instant, B claims t_for_C and C is dropped - a score
    // posted under someone else's turn id, on a page an operator reads, with no signal at all,
    // because only the absences are counted.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }, { atMs: 9_000 }];
    const turns = [turn("t_for_A", 1_400), turn("t_for_C", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t_for_A", null, "t_for_C"]);
  });

  it("absorbs clock skew between the harness and the server", () => {
    // Both are on one box for every run this harness produces, but the two clocks are read
    // independently and a turn stamped a little "before" the line is still that line's.
    expect(matchLedgerTurns([{ atMs: 5_000 }], [turn("t1", 4_900)])).toEqual(["t1"]);
    // ...and a turn a full second early belongs to something else.
    expect(matchLedgerTurns([{ atMs: 5_000 }], [turn("t1", 4_000)])).toEqual([null]);
  });

  it("joins nothing for a line that was never finished", () => {
    // An abandoned line has no instant; `NaN` compares false against every bound, which is the
    // honest answer rather than a join to whichever turn happened to be nearby.
    expect(matchLedgerTurns([{ atMs: Number.NaN }], [turn("t1", 1_400)])).toEqual([null]);
  });

  it("does not let measurement order in the array decide the join", () => {
    // The list is in scripted order today; the join is by time either way.
    const measurements = [{ atMs: 9_000 }, { atMs: 1_000 }];
    const turns = [turn("t1", 1_400), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t3", "t1"]);
  });
});

const werLine = (turnLabel: string, atMs: number, wer: number) => ({ turn: turnLabel, atMs, reference: "i can pay 550 on friday", hypothesis: "i can pay 550 on friday", wer });

describe("buildHarnessScores", () => {
  const base = { equivalent: true, equivalenceComment: "matches scenario happy-path" };

  it("posts one per-turn score per joined measurement", () => {
    const scores = buildHarnessScores({
      ...base,
      werLines: [werLine("line 1", 1_000, 0), werLine("line 2", 5_000, 0.1)],
      turnLatencies: [
        { turn: "line 1", atMs: 1_000, ms: 900 },
        { turn: "line 2", atMs: 5_000, ms: 1_100 },
      ],
      ledgerTurns: [turn("t1", 1_400), turn("t2", 5_600)],
    });
    expect(scores.filter((s) => s.name === "stt.wer" && s.turn_id).map((s) => s.turn_id)).toEqual(["t1", "t2"]);
    expect(scores.filter((s) => s.name === "latency.response_ms").map((s) => s.turn_id)).toEqual(["t1", "t2"]);
  });

  it("never posts two scores that share a null key under one name", () => {
    // The collapse itself: with no ledger turns to join to, the per-line rows would all have keyed
    // on (conversation, null, "stt.wer", "HARNESS") — one row, holding whichever was written last.
    const scores = buildHarnessScores({
      ...base,
      werLines: [werLine("line 1", 1_000, 0), werLine("line 2", 5_000, 0.1)],
      turnLatencies: [
        { turn: "line 1", atMs: 1_000, ms: 900 },
        { turn: "line 2", atMs: 5_000, ms: 1_100 },
      ],
      ledgerTurns: [],
    });
    const keys = scores.map((s) => `${s.name}|${s.turn_id ?? "null"}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The call-level summary survives, because it is honestly about the call.
    expect(scores.map((s) => s.name).sort()).toEqual(["harness.equivalence_pass", "stt.wer", "stt.wer_worst_line"]);
  });

  it("says how many measurements it could not join", () => {
    const said: string[] = [];
    buildHarnessScores({
      ...base,
      werLines: [werLine("line 1", 1_000, 0), werLine("line 2", 5_000, 0.1)],
      turnLatencies: [{ turn: "line 1", atMs: 1_000, ms: 900 }],
      ledgerTurns: [turn("t1", 1_400)],
      log: (m) => said.push(m),
    });
    // One WER line had no turn left; the single latency joined t1.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("1 per-turn score(s) could not be joined");
  });

  it("says nothing when everything joined", () => {
    const said: string[] = [];
    buildHarnessScores({
      ...base,
      werLines: [werLine("line 1", 1_000, 0)],
      turnLatencies: [{ turn: "line 1", atMs: 1_000, ms: 900 }],
      ledgerTurns: [turn("t1", 1_400)],
      log: (m) => said.push(m),
    });
    expect(said).toEqual([]);
  });
});
