/**
 * The score key is `(conversation_id, turn_id, name, source)` with `NULLS NOT DISTINCT` and an
 * upsert, so two per-turn scores that both carry a null turn id collapse onto one row.
 */
import { describe, expect, it } from "vitest";
import { buildHarnessScores, matchLedgerTurns } from "../src/tracer/harness-scores.js";

const turn = (id: string, startedAtMs: number) => ({ turn_id: id, startedAtMs });

describe("matchLedgerTurns", () => {
  it("joins each measurement to the turn the control plane opened after it", () => {
    // The measurement is anchored to the borrower falling silent, and the turn row is written when
    // the worker posts the committed turn, which is always afterwards.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }, { atMs: 9_000 }];
    const turns = [turn("t1", 1_400), turn("t2", 5_600), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t2", "t3"]);
  });

  it("does not let a NaN instant permute the join", () => {
    // A comparator that returns NaN makes `sort` reorder unpredictably, so every measurement could
    // land under a different turn without any null to count.
    const measurements = [{ atMs: 1_000 }, { atMs: Number.NaN }, { atMs: 5_000 }, { atMs: 9_000 }];
    const turns = [turn("t1", 1_400), turn("t2", 5_600), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", null, "t2", "t3"]);
  });

  it("drops any non-finite instant rather than trying to order it", () => {
    const turns = [turn("t1", 1_400)];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(matchLedgerTurns([{ atMs: bad }, { atMs: 1_000 }], turns)).toEqual([null, "t1"]);
    }
  });

  it("bounds the last measurement's window by the end of the call", () => {
    // Without an upper bound the final line reaches forward forever and claims a post-call turn.
    const measurements = [{ atMs: 1_000 }];
    const turns = [turn("t-late", 60_000)];
    expect(matchLedgerTurns(measurements, turns, 5_000)).toEqual([null]);
    expect(matchLedgerTurns(measurements, [turn("t1", 1_400)], 5_000)).toEqual(["t1"]);
  });

  it("survives a turn row the harness never measured — the barge-in case", () => {
    const measurements = [{ atMs: 1_000 }, { atMs: 9_000 }];
    const turns = [turn("t1", 1_400), turn("barge-in", 4_000), turn("t3", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t3"]);
  });

  it("claims each turn once, so two measurements cannot land on one row", () => {
    // WER and response latency are matched in separate passes, so the claim is per pass.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }];
    const turns = [turn("t1", 1_400), turn("t2", 5_400)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t1", "t2"]);
  });

  it("returns null where there is no turn left to claim", () => {
    const measurements = [{ atMs: 1_000 }, { atMs: 9_000 }];
    expect(matchLedgerTurns(measurements, [turn("t1", 1_400)])).toEqual(["t1", null]);
    expect(matchLedgerTurns(measurements, [])).toEqual([null, null]);
  });

  it("does not let a line with no turn reach forward and steal the next line's", () => {
    // Without bounding B's window by C's instant, B claims C's turn and C is dropped — a score
    // posted under someone else's turn id, with no absence to count.
    const measurements = [{ atMs: 1_000 }, { atMs: 5_000 }, { atMs: 9_000 }];
    const turns = [turn("t_for_A", 1_400), turn("t_for_C", 9_300)];
    expect(matchLedgerTurns(measurements, turns)).toEqual(["t_for_A", null, "t_for_C"]);
  });

  it("absorbs clock skew between the harness and the server", () => {
    // The two clocks are read independently, so a turn stamped a little before the line is still
    // that line's.
    expect(matchLedgerTurns([{ atMs: 5_000 }], [turn("t1", 4_900)])).toEqual(["t1"]);
    expect(matchLedgerTurns([{ atMs: 5_000 }], [turn("t1", 4_000)])).toEqual([null]);
  });

  it("joins nothing for a line that was never finished", () => {
    expect(matchLedgerTurns([{ atMs: Number.NaN }], [turn("t1", 1_400)])).toEqual([null]);
  });

  it("does not let measurement order in the array decide the join", () => {
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
