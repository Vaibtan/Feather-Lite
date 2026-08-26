/**
 * The deterministic post-call evaluator (spec 2026-08-26, D2).
 *
 * Pure: events in, facts out. It replaces the two regexes the EVALUATION outbox job used to be, and
 * it stays in the domain package rather than the job because everything it reports is already in
 * the ledger — the same reason replay and the transcript live here. That also makes it testable on
 * event fixtures alone, with no database and no LLM.
 *
 * Every check is **positional**, not textual, wherever it can be. "Did the agent leak account data
 * before verification" is answered by comparing sequence numbers against the RIGHT_PARTY_CONFIRMED
 * transition, not by looking for the word "balance" anywhere in the call: the promise read-back
 * legitimately says the amount out loud, and a check that fires on it would cry wolf on every
 * successful call.
 *
 * Checks that have no evidence either way report `null` rather than `false`. A JSON simulation
 * records no audio, so "was the read-back heard in full" is unanswerable, not failed; and a
 * voicemail is FDCPA-safe precisely *because* it omits the Mini-Miranda, so scoring it as a missing
 * disclosure would invert the rule it is enforcing.
 */
import type { EventRecord } from "./events.js";
import { disclosesProtectedDetail } from "./context.js";
import { booleanScore, numericScore, type ScoreRecord } from "./scores.js";

/** What the evaluator can conclude about one call. `null` means "no evidence", never "failed". */
export interface CallEvaluation {
  /* --- compliance --- */
  /** The first thing said carried the FDCPA §1692e(11) disclosure. `null` on a voicemail. */
  readonly miniMirandaFirst: boolean | null;
  /** No account detail was spoken before right-party confirmation. */
  readonly noProtectedBeforeRpc: boolean;
  /** Every recorded promise followed a read-back the borrower heard in full. `null` if no promise. */
  readonly noPromiseWithoutReadback: boolean | null;

  /* --- call facts --- */
  readonly rightPartyVerified: boolean;
  readonly voicemail: boolean;
  readonly bargeInCount: number;
  readonly noInputCount: number;
  readonly degradedTurns: number;
  readonly toolRejections: Readonly<Record<string, number>>;
  readonly toolRejectionCount: number;
  readonly agentTurns: number;
  readonly borrowerTurns: number;
  readonly durationMs: number | null;

  /* --- the shape the outbox job has always returned --- */
  readonly issues: ReadonlyArray<string>;
  readonly complianceOk: boolean;
}

const at = (e: EventRecord): number => Date.parse(e.created_at);

export const evaluateCall = (events: ReadonlyArray<EventRecord>): CallEvaluation => {
  const ordered = [...events].sort((a, b) => a.sequence_no - b.sequence_no);

  const agentTurnEvents = ordered.filter((e) => e.type === "AGENT_TURN");
  const borrowerTurnEvents = ordered.filter((e) => e.type === "USER_TURN_FINAL");
  const voicemail = ordered.some((e) => e.type === "AMD_RESULT" && e.payload.result === "MACHINE");

  const rpcSeq = ordered.find((e) => e.type === "STATE_TRANSITION" && e.payload.triggered_by === "RIGHT_PARTY_CONFIRMED")?.sequence_no ?? null;

  /* ---------------------------- compliance ---------------------------- */

  const firstAgentLine = agentTurnEvents[0];
  const miniMirandaFirst = voicemail
    ? null
    : firstAgentLine !== undefined && firstAgentLine.type === "AGENT_TURN"
      ? firstAgentLine.payload.text.includes("attempt to collect a debt")
      : false;

  // Only lines spoken strictly before the unlock can leak; after it, saying the balance is the job.
  const noProtectedBeforeRpc = !agentTurnEvents.some(
    (e) => e.type === "AGENT_TURN" && (rpcSeq === null || e.sequence_no < rpcSeq) && disclosesProtectedDetail(e.payload.text),
  );

  /**
   * A promise is legal only if the read-back that preceded it was heard in full, and
   * `AGENT_TURN_PLAYOUT` is the audio truth about that. This audits the orchestrator's fully-heard
   * guard rather than duplicating it: the guard already refuses to record a promise whose read-back
   * was interrupted, so a `false` here means the guard did not hold.
   *
   * Finding the right read-back is the whole difficulty. It is **not** simply the last agent line
   * before the record — a borrower side-question answered in CONFIRMING_OUTCOME produces a plain
   * AGENT_TURN with no tool, and checking whether *that* was heard in full would fail a compliant
   * call. The orchestrator arms `pendingProposal.read_back_turn_id` at exactly two moments: when
   * `propose_promise_to_pay` succeeds, and when a `record_promise_to_pay` is rejected and the
   * read-back is repeated. Those two events are the anchors here, and the read-back is the turn of
   * the first agent line after the most recent anchor — which is the same turn the guard armed.
   */
  const playouts = new Map<string, boolean>();
  for (const e of ordered) if (e.type === "AGENT_TURN_PLAYOUT") playouts.set(e.payload.turn_id, e.payload.interrupted);

  const readBackAnchors = ordered.filter(
    (e) => (e.type === "TOOL_RESULT" && e.payload.name === "propose_promise_to_pay") || (e.type === "TOOL_REJECTED" && e.payload.name === "record_promise_to_pay"),
  );
  const readBackTurnIdBefore = (seq: number): string | undefined => {
    const anchor = [...readBackAnchors].reverse().find((a) => a.sequence_no < seq);
    if (anchor === undefined) return undefined;
    const turn = agentTurnEvents.find((e) => e.sequence_no > anchor.sequence_no && e.sequence_no < seq);
    return turn !== undefined && turn.type === "AGENT_TURN" ? turn.payload.turn_id : undefined;
  };

  const recordedPromises = ordered.filter((e) => e.type === "TOOL_RESULT" && e.payload.name === "record_promise_to_pay");
  let noPromiseWithoutReadback: boolean | null = null;
  for (const promise of recordedPromises) {
    const turnId = readBackTurnIdBefore(promise.sequence_no);
    const interrupted = turnId === undefined ? undefined : playouts.get(turnId);
    // No playout for that turn at all: a simulated call, which has no audio to have missed.
    if (interrupted === undefined) continue;
    noPromiseWithoutReadback = (noPromiseWithoutReadback ?? true) && !interrupted;
  }

  /* ---------------------------- call facts ---------------------------- */

  const toolRejections: Record<string, number> = {};
  let toolRejectionCount = 0;
  for (const e of ordered) {
    if (e.type !== "TOOL_REJECTED") continue;
    toolRejections[e.payload.reason] = (toolRejections[e.payload.reason] ?? 0) + 1;
    toolRejectionCount += 1;
  }

  const started = ordered.find((e) => e.type === "CALL_STARTED") ?? ordered[0];
  const ended = ordered.find((e) => e.type === "CALL_ENDED");
  const durationMs = started !== undefined && ended !== undefined ? at(ended) - at(started) : null;

  /* ------------------------------ issues ------------------------------ */

  const issues: string[] = [];
  if (miniMirandaFirst === false) issues.push("MINI_MIRANDA_MISSING");
  if (!noProtectedBeforeRpc) issues.push("PROTECTED_CONTEXT_BEFORE_VERIFICATION");
  if (noPromiseWithoutReadback === false) issues.push("PROMISE_WITHOUT_READBACK");

  return {
    miniMirandaFirst,
    noProtectedBeforeRpc,
    noPromiseWithoutReadback,
    rightPartyVerified: rpcSeq !== null,
    voicemail,
    bargeInCount: ordered.filter((e) => e.type === "TURN_SUPERSEDED").length,
    noInputCount: ordered.filter((e) => e.type === "NO_INPUT").length,
    degradedTurns: agentTurnEvents.filter((e) => e.type === "AGENT_TURN" && e.payload.degraded === true).length,
    toolRejections,
    toolRejectionCount,
    agentTurns: agentTurnEvents.length,
    borrowerTurns: borrowerTurnEvents.length,
    durationMs,
    issues,
    complianceOk: issues.length === 0,
  };
};

/**
 * The evaluator's facts as scores (spec 2026-08-26, D2: "Each becomes a score").
 *
 * Pure, so the mapping is asserted in the domain tests rather than through a job run. A fact with
 * no evidence (`null`) produces no score at all: writing 0 for "we could not tell" would make a
 * compliant voicemail indistinguishable from a call that skipped its disclosure, and the whole
 * point of the null is to keep those apart.
 */
export const evaluationScores = (conversationId: string, evaluation: CallEvaluation): ReadonlyArray<ScoreRecord> => {
  const out: ScoreRecord[] = [];
  const bool = (name: Parameters<typeof booleanScore>[1], v: boolean | null, comment?: string) => {
    if (v !== null) out.push(booleanScore(conversationId, name, v, "EVALUATOR", comment !== undefined ? { comment } : {}));
  };
  const num = (name: Parameters<typeof numericScore>[1], v: number | null, comment?: string) => {
    if (v !== null) out.push(numericScore(conversationId, name, v, "EVALUATOR", comment !== undefined ? { comment } : {}));
  };

  bool("compliance.mini_miranda_first", evaluation.miniMirandaFirst, evaluation.miniMirandaFirst === false ? "first agent line does not carry the FDCPA disclosure" : undefined);
  bool("compliance.no_protected_before_rpc", evaluation.noProtectedBeforeRpc, evaluation.noProtectedBeforeRpc ? undefined : "account detail spoken before right-party confirmation");
  bool("compliance.no_promise_without_readback", evaluation.noPromiseWithoutReadback, evaluation.noPromiseWithoutReadback === false ? "a promise was recorded after a read-back the borrower did not hear in full" : undefined);
  bool("call.right_party_verified", evaluation.rightPartyVerified);
  bool("call.voicemail", evaluation.voicemail);
  num("call.barge_in_count", evaluation.bargeInCount);
  num("call.no_input_count", evaluation.noInputCount);
  num("call.degraded_turns", evaluation.degradedTurns);
  // D2 asks for tool rejections "by reason". The score's value is the total, because that is what
  // aggregates across calls; the breakdown goes in `evidence`, which is jsonb and therefore still
  // queryable (`evidence->>'INVALID_ARGS'`) rather than prose buried in a comment.
  if (evaluation.toolRejectionCount === 0) {
    out.push(numericScore(conversationId, "call.tool_rejections", 0, "EVALUATOR"));
  } else {
    out.push(
      numericScore(conversationId, "call.tool_rejections", evaluation.toolRejectionCount, "EVALUATOR", {
        comment: Object.entries(evaluation.toolRejections).map(([reason, n]) => `${reason}×${n}`).join(", "),
        evidence: { by_reason: evaluation.toolRejections },
      }),
    );
  }
  num("call.agent_turns", evaluation.agentTurns);
  num("call.borrower_turns", evaluation.borrowerTurns);
  num("call.duration_ms", evaluation.durationMs);
  return out;
};
