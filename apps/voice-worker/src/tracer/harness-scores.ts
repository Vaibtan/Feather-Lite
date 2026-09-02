/**
 * The voice harnesses post what they measured back to the conversation as scores
 * (spec 2026-08-26, D4: "harness runs and production calls share one score model").
 *
 * WER only exists here — a production call has no ground truth — so without this the number would
 * live in a terminal scrollback and nowhere else. Posting it through the same
 * `POST /api/conversations/:id/scores` a human label uses means the Quality page, Langfuse and the
 * fleet report all read one store rather than three.
 */
import { harnessHeaders, harnessJsonHeaders } from "@feather-lite/load-test/harness-http";

/** One turn as the ledger knows it: its id, and when the control plane claimed it. */
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
      // Logged, never thrown: a harness run that measured everything correctly must not be failed
      // by the reporting of it, and the numbers are already on stdout.
      log?.(`posting scores failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return;
    }
    log?.(`posted ${scores.length} score(s)`);
  } catch (e) {
    log?.(`posting scores failed: ${String(e)}`);
  }
};

/**
 * Everything one harness call measured, as scores (D4 and user story 22: WER, response latency and
 * the equivalence verdict). Built once and shared by the single-call and fleet harnesses, which
 * were assembling the same list independently and had already begun to drift.
 *
 * Per-turn rows as well as the call-level summary: D4 asks for `stt.wer` "per turn and the call
 * mean + worst line", and a mean alone cannot tell a call where every line was slightly wrong from
 * one where a single line was badly wrong.
 */
export const buildHarnessScores = (params: {
  readonly equivalent: boolean;
  readonly equivalenceComment: string;
  readonly werLines: ReadonlyArray<{ readonly turn: string; readonly atMs: number; readonly reference: string; readonly hypothesis: string; readonly wer: number | null }>;
  readonly turnLatencies: ReadonlyArray<{ readonly turn: string; readonly atMs: number; readonly ms: number }>;
  /**
   * The conversation's turns from the ledger, in `started_at` order (O8).
   *
   * The harness names its measurements after the line it spoke — `"BARGE-IN: I can pay 550 on
   * Friday"` — and those were posted as `turn_id`. They matched no row in `conversation_turns`, so
   * every per-turn harness score joined nothing and silently took the session-level fallback in
   * `Tracing.score`. The ledger's ids are the only real ones, and the harness already reads the
   * ledger for its TTS numbers.
   */
  readonly ledgerTurns: ReadonlyArray<LedgerTurn>;
  /**
   * When the call ended, closing the last measurement's join window (H3). Without it the final line
   * reaches forward forever and can claim a post-call turn.
   */
  readonly callEndedAtMs?: number;
  /** Told what could not be joined, and how many rows that is. Never fails the run. */
  readonly log?: (message: string) => void;
}): ReadonlyArray<HarnessScore> => {
  const wer = summariseWer(params.werLines);
  const measuredLines = params.werLines.filter((l): l is (typeof params.werLines)[number] & { wer: number } => l.wer !== null);
  const werTurnIds = matchLedgerTurns(measuredLines, params.ledgerTurns, params.callEndedAtMs);
  const latencyTurnIds = matchLedgerTurns(params.turnLatencies, params.ledgerTurns, params.callEndedAtMs);
  /**
   * A measurement that could not be joined is **dropped**, not posted with a null turn id
   * (review #10).
   *
   * The score key is `(conversation_id, turn_id, name, source)` with `NULLS NOT DISTINCT` and an
   * upsert behind it (`migrations/0002_scores.ts:44`), so N per-line `stt.wer` rows at
   * `turn_id: null` were never N rows: they collapsed onto each other *and* onto the call-level
   * mean posted under the same name, last write winning, while the harness reported writing N+1.
   * The call-level mean and worst line survive, carry the same information in aggregate, and are
   * honest about being about the call.
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
    // The composite metric the latency work of ADR 0007/0008 is measured against: borrower falls
    // silent -> agent starts replying. Per turn, because a mean hides the one slow turn, and with
    // the ledger's own id so it joins `conversation_turns`; the label stays as the comment.
    ...params.turnLatencies.flatMap((t, i): ReadonlyArray<HarnessScore> => {
      const turnId = latencyTurnIds[i];
      if (turnId === null || turnId === undefined) return [];
      return [{ name: "latency.response_ms", value: t.ms, source: "HARNESS", turn_id: turnId, comment: t.turn }];
    }),
  ];
};

/**
 * Join harness measurements to ledger turns **by time**, not by position (review #10).
 *
 * Position held only while the two lists described the same turns. A barge-in adds a turn row the
 * harness never measured, and from that row on every measurement was one place out — which is why
 * the old code refused to join at all in that case and posted null keys instead.
 *
 * A measurement is anchored to the instant the borrower fell silent; the ledger's turn is created
 * afterwards, when the worker posts the committed turn. So a measurement's turn is one that started
 * after it — **and before the next line was spoken**. That upper bound is what makes the join safe
 * rather than merely plausible: without it, a line the agent never answered would reach forward and
 * claim the *next* line's turn, and every score after it would be posted under someone else's turn
 * id. A wrong join is worse than an absent one, and it is worse silently, because only the absences
 * are counted.
 *
 * `null` where the window holds no unclaimed turn — an unanswered line, or a run whose measurements
 * outnumber the turns that were recorded.
 */
/**
 * How far a turn may appear to precede the line it belongs to.
 *
 * Only clock skew: the harness reads `Date.now()` and the control plane stamps `started_at`, and
 * both are on one box for every run this harness produces. It is not a "how long may a turn take to
 * be claimed" budget — that direction is bounded by the next line instead, which is a fact rather
 * than a guess. 250 ms is an order of magnitude above any same-box skew and an order of magnitude
 * below the gap between two scripted lines.
 */
const CLOCK_GRACE_MS = 250;
/**
 * D4's six turn-taking numbers, as scores (issue #1, D4; the names are H8's).
 *
 * Separate from `buildHarnessScores` because it is measured differently: those come from what the
 * harness spoke and heard, these from the join of the borrower's own events with the agent's speech
 * stretches and the ledger's playout truth. Only tier 3 has that join today.
 *
 * **A null is not posted.** `null` here means "no denominator" — no interruption happened, so there
 * is no yield rate — and a score row of 0 would read as "it never yielded", which is a different and
 * worse claim than silence. H11's `unknown_truncation` count travels with them as evidence so a
 * reader can see how thin the denominator was.
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
  /**
   * When the call ended, closing the last measurement's window (H3).
   *
   * Without it the final line's window runs to infinity and claims whatever turn the ledger opened
   * next — a post-call turn, or the sweeper's close, joined to a line the borrower spoke a minute
   * earlier. Optional so a caller that genuinely does not know keeps the old behaviour rather than
   * being handed a wrong bound.
   */
  callEndedAtMs?: number,
): ReadonlyArray<string | null> => {
  const turns = [...ledgerTurns].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const claimed = new Set<string>();
  /**
   * Only measurements that can be ordered (H3).
   *
   * An abandoned line carries `atMs: NaN`, and `(a, b) => a.atMs - b.atMs` returns `NaN` for every
   * comparison involving it — an inconsistent comparator, which `Array.prototype.sort` is entitled
   * to answer by permuting the array however it likes. Measured on the case below: one `NaN` among
   * four measurements moved a *finite* line off its own turn, so a score was posted under another
   * turn's id. Only the nulls are counted as unjoined, so nothing would have said so — and this
   * file's own note is that a wrong join is worse than an absent one, silently.
   *
   * A non-finite instant can never join anything anyway, so it is dropped before the sort and left
   * `null`, which is what "this measurement has no turn" already means everywhere else here.
   */
  const byTime = measurements
    .map((m, index) => ({ index, atMs: m.atMs }))
    .filter((m) => Number.isFinite(m.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const out: Array<string | null> = measurements.map(() => null);
  byTime.forEach((m, i) => {
    // The next line's instant closes this line's window: a turn that started after the borrower had
    // already moved on belongs to that later line. For the last line it is the end of the call.
    const until = byTime[i + 1]?.atMs ?? callEndedAtMs ?? Number.POSITIVE_INFINITY;
    const hit = turns.find((t) => !claimed.has(t.turn_id) && t.startedAtMs >= m.atMs - CLOCK_GRACE_MS && t.startedAtMs < until);
    if (!hit) return;
    claimed.add(hit.turn_id);
    out[m.index] = hit.turn_id;
  });
  return out;
};

/** Call-level WER summary from the per-line measurements, ignoring lines with no reference. */
export const summariseWer = <L extends { readonly turn: string; readonly wer: number | null }>(lines: ReadonlyArray<L>) => {
  const measured = lines.filter((l): l is L & { wer: number } => l.wer !== null);
  if (measured.length === 0) return null;
  const mean = measured.reduce((a, l) => a + l.wer, 0) / measured.length;
  const worst = measured.reduce((a, l) => (l.wer > a.wer ? l : a));
  return { mean: Math.round(mean * 10000) / 10000, worst, n: measured.length };
};

/**
 * The conversation's turns from the ledger, with the instant each was claimed (O8, review #10).
 *
 * A harness measures per turn and names the line it spoke; only the ledger knows what the turn is
 * actually called, and only `started_at` says which turn a measurement belongs to. Failing to read
 * them is not fatal — the per-turn scores are then dropped and the call-level summary stands, which
 * is what existed before any of this — so this never throws.
 */
export const ledgerTurns = async (controlPlaneUrl: string, conversationId: string): Promise<ReadonlyArray<LedgerTurn>> => {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/latency`, { headers: harnessHeaders() });
    if (!res.ok) return [];
    return ((await res.json()) as Array<{ turn_id: string; started_at: string }>).map((r) => ({ turn_id: r.turn_id, startedAtMs: Date.parse(r.started_at) }));
  } catch {
    return [];
  }
};
