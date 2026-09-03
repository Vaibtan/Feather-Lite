import { entityErrors } from "@feather-lite/domain";
import { harnessHeaders, harnessJsonHeaders } from "@feather-lite/load-test/harness-http";

export interface LedgerTurn {
  readonly turn_id: string;
  readonly startedAtMs: number;
}

export interface HarnessScore {
  readonly name: string;
  readonly value: number;
  readonly source: "HARNESS";
  readonly turn_id?: string | null;
  readonly comment?: string | null;
  readonly evidence?: Record<string, unknown> | null;
}

export const postHarnessScores = async (
  controlPlaneUrl: string,
  conversationId: string,
  scores: ReadonlyArray<HarnessScore>,
  log?: (m: string) => void,
): Promise<void> => {
  if (scores.length === 0) return;
  try {
    const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/scores`, {
      method: "POST",
      headers: harnessJsonHeaders(),
      body: JSON.stringify({ scores }),
    });
    if (!res.ok) {
      // Logged, never thrown: a run that measured correctly must not be failed by the reporting.
      log?.(`posting scores failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return;
    }
    log?.(`posted ${scores.length} score(s)`);
  } catch (e) {
    log?.(`posting scores failed: ${String(e)}`);
  }
};

/** Per-turn rows as well as the mean: a mean cannot tell many slightly-wrong lines from one bad one. */
export const buildHarnessScores = (params: {
  readonly equivalent: boolean;
  readonly equivalenceComment: string;
  readonly werLines: ReadonlyArray<{ readonly turn: string; readonly atMs: number; readonly reference: string; readonly hypothesis: string; readonly wer: number | null }>;
  readonly turnLatencies: ReadonlyArray<{ readonly turn: string; readonly atMs: number; readonly ms: number }>;
  /**
   * In `started_at` order. The ledger's ids are the only real ones — a harness names its
   * measurements after the line it spoke, and those join no row in `conversation_turns`.
   */
  readonly ledgerTurns: ReadonlyArray<LedgerTurn>;
  /** Closes the last measurement's join window; without it the final line reaches forward forever. */
  readonly callEndedAtMs?: number;
  readonly log?: (message: string) => void;
}): ReadonlyArray<HarnessScore> => {
  const wer = summariseWer(params.werLines);
  const measuredLines = params.werLines.filter((l): l is (typeof params.werLines)[number] & { wer: number } => l.wer !== null);
  const werTurnIds = matchLedgerTurns(measuredLines, params.ledgerTurns, params.callEndedAtMs);
  const latencyTurnIds = matchLedgerTurns(params.turnLatencies, params.ledgerTurns, params.callEndedAtMs);
  /**
   * A measurement that could not be joined is dropped, not posted with a null turn id: the score
   * key is `(conversation_id, turn_id, name, source)` with `NULLS NOT DISTINCT` behind an upsert,
   * so N per-line rows at `turn_id: null` collapse onto each other and onto the call-level mean.
   */
  const unjoined = werTurnIds.filter((id) => id === null).length + latencyTurnIds.filter((id) => id === null).length;
  if (unjoined > 0) {
    params.log?.(
      `${String(unjoined)} per-turn score(s) could not be joined to a ledger turn ` +
        `(${String(params.ledgerTurns.length)} turn row(s), ${String(measuredLines.length)} measured line(s), ` +
        `${String(params.turnLatencies.length)} measured replies); posting the call-level summary only, ` +
        `because null-keyed per-turn scores collapse onto one row.`,
    );
  }
  return [
    { name: "harness.equivalence_pass", value: params.equivalent ? 1 : 0, source: "HARNESS", comment: params.equivalenceComment },
    ...measuredLines.flatMap((l, i): ReadonlyArray<HarnessScore> => {
      const turnId = werTurnIds[i];
      if (turnId === null || turnId === undefined) return [];
      return [{ name: "stt.wer", value: l.wer, source: "HARNESS", turn_id: turnId, comment: l.turn, evidence: { reference: l.reference, hypothesis: l.hypothesis } }];
    }),
    ...(wer === null
      ? []
      : [
          { name: "stt.wer", value: wer.mean, source: "HARNESS", comment: `mean over ${wer.n} borrower line(s)` } as HarnessScore,
          { name: "stt.wer_worst_line", value: wer.worst.wer, source: "HARNESS", comment: wer.worst.turn, evidence: { reference: wer.worst.reference, hypothesis: wer.worst.hypothesis } } as HarnessScore,
        ]),
    ...params.turnLatencies.flatMap((t, i): ReadonlyArray<HarnessScore> => {
      const turnId = latencyTurnIds[i];
      if (turnId === null || turnId === undefined) return [];
      return [{ name: "latency.response_ms", value: t.ms, source: "HARNESS", turn_id: turnId, comment: t.turn }];
    }),
  ];
};

/**
 * Joined by time, not by position: a barge-in adds a turn row the harness never measured, and from
 * there on every positional join is one place out. A measurement's turn is one that started after
 * it and before the next line was spoken — that upper bound is what keeps an unanswered line from
 * reaching forward and claiming the next line's turn, which is worse than not joining at all.
 */
/**
 * Clock skew only, not a budget for how long a turn may take to be claimed — that direction is
 * bounded by the next line. 250 ms is an order of magnitude above any same-box skew and an order
 * of magnitude below the gap between two scripted lines.
 */
const CLOCK_GRACE_MS = 250;
/**
 * A null is not posted: it means there was no denominator, and a 0 would read as "it never
 * yielded", which is a different and worse claim than silence.
 */
export const turnTakingScores = (
  metrics: {
    readonly response_rate: number | null;
    readonly yield_rate: number | null;
    readonly yield_latency_ms: number | null;
    readonly false_interrupt_rate: number | null;
    readonly agent_interrupt_rate: number | null;
    readonly selectivity: number | null;
    readonly counts: Record<string, number>;
  },
  evidence: Record<string, unknown>,
): ReadonlyArray<HarnessScore> => {
  const named = {
    "turn.response_rate": metrics.response_rate,
    "turn.yield_rate": metrics.yield_rate,
    "turn.yield_latency_ms": metrics.yield_latency_ms,
    "turn.false_interrupt_rate": metrics.false_interrupt_rate,
    "turn.agent_interrupt_rate": metrics.agent_interrupt_rate,
    "turn.selectivity": metrics.selectivity,
  } as const;
  return Object.entries(named)
    .filter((e): e is [string, number] => e[1] !== null)
    .map(([name, value]) => ({
      name,
      value,
      source: "HARNESS" as const,
      comment: `${String(metrics.counts["unknown_truncation"] ?? 0)} stretch(es) excluded for want of playout evidence (H11)`,
      evidence: { ...evidence, counts: metrics.counts },
    }));
};

export const matchLedgerTurns = (
  measurements: ReadonlyArray<{ readonly atMs: number }>,
  ledgerTurns: ReadonlyArray<LedgerTurn>,
  /** Optional, so a caller that does not know keeps the old behaviour rather than a wrong bound. */
  callEndedAtMs?: number,
): ReadonlyArray<string | null> => {
  const turns = [...ledgerTurns].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const claimed = new Set<string>();
  /**
   * Only measurements that can be ordered: an abandoned line carries `atMs: NaN`, which makes the
   * comparator inconsistent and lets `sort` permute the array — measured, one `NaN` moved a finite
   * line onto another turn's id. A non-finite instant can never join anything, so it is dropped.
   */
  const byTime = measurements
    .map((m, index) => ({ index, atMs: m.atMs }))
    .filter((m) => Number.isFinite(m.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const out: Array<string | null> = measurements.map(() => null);
  byTime.forEach((m, i) => {
    // The next line's instant closes this line's window; for the last line it is the end of the call.
    const until = byTime[i + 1]?.atMs ?? callEndedAtMs ?? Number.POSITIVE_INFINITY;
    const hit = turns.find((t) => !claimed.has(t.turn_id) && t.startedAtMs >= m.atMs - CLOCK_GRACE_MS && t.startedAtMs < until);
    if (!hit) return;
    claimed.add(hit.turn_id);
    out[m.index] = hit.turn_id;
  });
  return out;
};

/** Lines with no reference are ignored. */
/**
 * Beside `stt.wer`, not folded into it: WER asks how much of the transcript was wrong, this asks
 * whether the parts that decide the call survived. An amount error is a wrong promise.
 */
export const summariseEntities = <L extends { readonly reference: string; readonly hypothesis: string }>(
  lines: ReadonlyArray<L>,
  names: ReadonlyArray<string>,
): {
  readonly n: number;
  readonly amount_errors: number;
  readonly date_errors: number;
  readonly name_errors: number;
  /** Null when no line carried an entity — nothing to be wrong about (same rule as WER). */
  readonly entity_er: number | null;
  readonly counts: Readonly<Record<string, number>>;
} => {
  let expected = 0;
  let wrong = 0;
  const errs = { amount: 0, date: 0, name: 0 };
  const counts = { amount: 0, date: 0, name: 0 };
  for (const l of lines) {
    const r = entityErrors(l.reference, l.hypothesis, { names });
    for (const k of ["amount", "date", "name"] as const) counts[k] += r.counts[k];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- kinds are exhaustive
    expected += r.counts.amount + r.counts.date + r.counts.name;
    wrong += r.errors.length;
    for (const e of r.errors) errs[e.kind] += 1;
  }
  return {
    n: expected,
    amount_errors: errs.amount,
    date_errors: errs.date,
    name_errors: errs.name,
    entity_er: expected === 0 ? null : wrong / expected,
    counts,
  };
};

export const summariseWer = <L extends { readonly turn: string; readonly wer: number | null }>(lines: ReadonlyArray<L>) => {
  const measured = lines.filter((l): l is L & { wer: number } => l.wer !== null);
  if (measured.length === 0) return null;
  const mean = measured.reduce((a, l) => a + l.wer, 0) / measured.length;
  const worst = measured.reduce((a, l) => (l.wer > a.wer ? l : a));
  return { mean: Math.round(mean * 10000) / 10000, worst, n: measured.length };
};

/** Never throws: failing to read them drops the per-turn scores and leaves the call-level summary. */
export const ledgerTurns = async (controlPlaneUrl: string, conversationId: string): Promise<ReadonlyArray<LedgerTurn>> => {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/latency`, { headers: harnessHeaders() });
    if (!res.ok) return [];
    return ((await res.json()) as Array<{ turn_id: string; started_at: string }>).map((r) => ({ turn_id: r.turn_id, startedAtMs: Date.parse(r.started_at) }));
  } catch {
    return [];
  }
};
