/**
 * The voice harnesses post what they measured back to the conversation as scores
 * (spec 2026-08-26, D4: "harness runs and production calls share one score model").
 *
 * WER only exists here — a production call has no ground truth — so without this the number would
 * live in a terminal scrollback and nowhere else. Posting it through the same
 * `POST /api/conversations/:id/scores` a human label uses means the Quality page, Langfuse and the
 * fleet report all read one store rather than three.
 */
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
  const bearer = process.env["API_BEARER_TOKEN"];
  try {
    const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/scores`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
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
  readonly werLines: ReadonlyArray<{ readonly turn: string; readonly reference: string; readonly hypothesis: string; readonly wer: number | null }>;
  readonly turnLatencies: ReadonlyArray<{ readonly turn: string; readonly ms: number }>;
  /**
   * The conversation's turn ids from the ledger, in `started_at` order (O8).
   *
   * The harness names its measurements after the line it spoke — `"BARGE-IN: I can pay 550 on
   * Friday"` — and those were posted as `turn_id`. They matched no row in `conversation_turns`, so
   * every per-turn harness score joined nothing and silently took the session-level fallback in
   * `Tracing.score`. The ledger's ids are the only real ones, and the harness already reads the
   * ledger for its TTS numbers.
   *
   * Paired positionally, which holds when the harness measured a reply for every turn the ledger
   * recorded. When it does not — an unanswered turn leaves a row with no measurement — the scores
   * go to the call rather than guessing, and say so. A wrong join is worse than an absent one.
   */
  readonly ledgerTurnIds: ReadonlyArray<string>;
}): ReadonlyArray<HarnessScore> => {
  const wer = summariseWer(params.werLines);
  /**
   * Positional pairing is only defensible when the two lists describe the same turns. The measured
   * lines and the ledger's turns line up on the happy path (three scripted lines, three turn rows);
   * when they do not, the per-turn scores become call-level rather than joining the wrong row.
   */
  const measuredLines = params.werLines.filter((l) => l.wer !== null).length;
  const paired = params.ledgerTurnIds.length === params.turnLatencies.length && params.ledgerTurnIds.length === measuredLines;
  return [
    { name: "harness.equivalence_pass", value: params.equivalent ? 1 : 0, source: "HARNESS", comment: params.equivalenceComment },
    ...params.werLines
      .filter((l): l is typeof l & { wer: number } => l.wer !== null)
      .map((l, i): HarnessScore => {
        const turnId = paired ? (params.ledgerTurnIds[i] ?? null) : null;
        return {
          name: "stt.wer",
          value: l.wer,
          source: "HARNESS",
          turn_id: turnId,
          comment: turnId === null ? `${l.turn} (not matched to a ledger turn)` : l.turn,
          evidence: { reference: l.reference, hypothesis: l.hypothesis },
        };
      }),
    ...(wer === null
      ? []
      : [
          { name: "stt.wer", value: wer.mean, source: "HARNESS", comment: `mean over ${wer.n} borrower line(s)` } as HarnessScore,
          { name: "stt.wer_worst_line", value: wer.worst.wer, source: "HARNESS", comment: wer.worst.turn, evidence: { reference: wer.worst.reference, hypothesis: wer.worst.hypothesis } } as HarnessScore,
        ]),
    // The composite metric the latency work of ADR 0007/0008 is measured against: borrower falls
    // silent -> agent starts replying. Per turn, because a mean hides the one slow turn.
    // The composite metric the latency work of ADR 0007/0008 is measured against, per turn, with
    // the ledger's own id so it joins `conversation_turns` and the label kept as the comment.
    ...params.turnLatencies.map((t, i): HarnessScore => {
      const turnId = paired ? (params.ledgerTurnIds[i] ?? null) : null;
      return {
        name: "latency.response_ms",
        value: t.ms,
        source: "HARNESS",
        turn_id: turnId,
        comment: turnId === null ? `${t.turn} (not matched to a ledger turn)` : t.turn,
      };
    }),
  ];
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
 * The conversation's turn ids from the ledger, in order (O8).
 *
 * A harness measures per turn and names the line it spoke; only the ledger knows what the turn is
 * actually called. Failing to read them is not fatal — the scores become call-level, which is what
 * they were before this existed — so this never throws.
 */
export const ledgerTurnIds = async (controlPlaneUrl: string, conversationId: string): Promise<ReadonlyArray<string>> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  try {
    const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}/latency`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    if (!res.ok) return [];
    return ((await res.json()) as Array<{ turn_id: string }>).map((r) => r.turn_id);
  } catch {
    return [];
  }
};
