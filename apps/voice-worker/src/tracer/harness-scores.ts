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
}): ReadonlyArray<HarnessScore> => {
  const wer = summariseWer(params.werLines);
  return [
    { name: "harness.equivalence_pass", value: params.equivalent ? 1 : 0, source: "HARNESS", comment: params.equivalenceComment },
    ...params.werLines
      .filter((l): l is typeof l & { wer: number } => l.wer !== null)
      .map((l): HarnessScore => ({ name: "stt.wer", value: l.wer, source: "HARNESS", turn_id: l.turn, comment: l.turn, evidence: { reference: l.reference, hypothesis: l.hypothesis } })),
    ...(wer === null
      ? []
      : [
          { name: "stt.wer", value: wer.mean, source: "HARNESS", comment: `mean over ${wer.n} borrower line(s)` } as HarnessScore,
          { name: "stt.wer_worst_line", value: wer.worst.wer, source: "HARNESS", comment: wer.worst.turn, evidence: { reference: wer.worst.reference, hypothesis: wer.worst.hypothesis } } as HarnessScore,
        ]),
    // The composite metric the latency work of ADR 0007/0008 is measured against: borrower falls
    // silent -> agent starts replying. Per turn, because a mean hides the one slow turn.
    ...params.turnLatencies.map((t): HarnessScore => ({ name: "latency.response_ms", value: t.ms, source: "HARNESS", turn_id: t.turn, comment: t.turn })),
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
