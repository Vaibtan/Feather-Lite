/**
 * The LLM-as-judge, pure half (spec 2026-08-26, D3): what the judge is shown, what it is allowed to
 * return, and what its verdict becomes in the score table.
 *
 * **Binary per dimension, not a 1–5 scale.** A scale invites the model to hedge at 3 and gives an
 * operator nothing to calibrate against: two people rarely agree on what a 4 means, and neither can
 * say whether the judge's 4 matches theirs. A pass/fail can be compared directly with a human's
 * pass/fail, which is what `judge_agreement` on the Quality page measures — and calibration against
 * human labels is the only thing that makes a judge trustworthy at all.
 *
 * **Evidence before verdict.** Every dimension must quote the span it is judging. This is partly
 * for the operator, who can check a verdict in seconds instead of relistening, and partly for the
 * judge: a model asked to find the quote first is answering a question about the transcript, while
 * a model asked for a verdict first is answering a question about its own impression.
 *
 * **The failure mode being hunted is the friendly wrong call.** Collections agents that sound warm,
 * apologise well and resolve nothing read as good calls to a model trained on helpfulness. The
 * prompt says so explicitly, and `task_completion` is scored against what the ledger records the
 * call actually achieved, which the judge is shown rather than left to infer.
 *
 * The judge is not a second path for account data to escape: `buildJudgeInput` takes events and
 * nothing else, so there is no parameter through which CRM context could arrive. What the borrower
 * was already told is in the transcript; nothing beyond it is.
 */
import { Either, Schema } from "effect";
import type { CallEvaluation } from "./evaluation.js";
import type { EventRecord } from "./events.js";
import { replay } from "./replay.js";
import { booleanScore, clampScoreComment, type ScoreName, type ScoreRecord } from "./scores.js";
import { buildTranscript } from "./transcript.js";

/**
 * The dimensions, from the Hamming rubric. Escalation judgment is here because the most expensive
 * mistake a collections agent makes is not mishandling a payment — it is failing to hand off a
 * borrower who declared a dispute, a bankruptcy or an attorney, each of which is a legal trigger.
 */
export const JUDGE_DIMENSIONS = ["task_completion", "compliance", "factual_accuracy", "empathy_professionalism", "escalation_judgment"] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

/** Long enough for a reason, short enough to read in a list. */
export const JUDGE_RATIONALE_MAX = 200;

const DimensionVerdict = Schema.Struct({
  pass: Schema.Boolean,
  rationale: Schema.String,
  /** A span quoted from the transcript. Empty when the dimension is judged on the absence of one. */
  evidence: Schema.String,
});

export const JudgeVerdictSchema = Schema.Struct({
  task_completion: DimensionVerdict,
  compliance: DimensionVerdict,
  factual_accuracy: DimensionVerdict,
  empathy_professionalism: DimensionVerdict,
  escalation_judgment: DimensionVerdict,
  overall_pass: Schema.Boolean,
  /** How sure the judge is, 0–1. Kept beside the verdict, never used to soften it. */
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
});
export type JudgeVerdict = typeof JudgeVerdictSchema.Type;

/**
 * Decode a parsed model response into a verdict.
 *
 * A missing or malformed dimension fails the whole verdict rather than scoring the ones that
 * arrived: four dimensions with a silent fifth reads on the Quality page as "the fifth did not
 * apply", which is a different and much more reassuring claim than "the judge broke". An
 * over-long rationale is the one thing forgiven — the model has still done the work, and throwing
 * away five verdicts over a long sentence would be the wrong trade — so it is clamped.
 */
export const decodeJudgeVerdict = (raw: unknown): Either.Either<JudgeVerdict, string> => {
  const decoded = Schema.decodeUnknownEither(JudgeVerdictSchema)(raw, { errors: "first", onExcessProperty: "ignore" });
  if (Either.isLeft(decoded)) return Either.left(String(decoded.left).slice(0, 300));
  const v = decoded.right;
  const clamp = (d: JudgeVerdict[JudgeDimension]) => ({ ...d, rationale: d.rationale.slice(0, JUDGE_RATIONALE_MAX) });
  return Either.right({
    ...v,
    task_completion: clamp(v.task_completion),
    compliance: clamp(v.compliance),
    factual_accuracy: clamp(v.factual_accuracy),
    empathy_professionalism: clamp(v.empathy_professionalism),
    escalation_judgment: clamp(v.escalation_judgment),
  });
};

/**
 * The JSON schema sent to OpenAI as a strict `response_format`.
 *
 * Hand-written rather than derived from the Effect schema: OpenAI's strict mode accepts only a
 * subset of JSON Schema and requires **every** property in `required` with `additionalProperties:
 * false` at every level, which a generic derivation does not guarantee. A mismatch is a 400 at
 * request time on a path that only runs after the call has ended, so it is pinned by a test.
 *
 * `maxLength` on the rationale is checked, not assumed: string constraints (`minLength`, `pattern`,
 * `format`) are documented as supported in strict mode as of 2026-08-27, with the one exception of
 * fine-tuned models, which this is not. `decodeJudgeVerdict` clamps anyway — a model that overshoots
 * has still done the work.
 */
const dimensionSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    rationale: { type: "string", maxLength: JUDGE_RATIONALE_MAX },
    evidence: { type: "string" },
  },
  required: ["pass", "rationale", "evidence"],
  additionalProperties: false,
} as const;

export const JUDGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ...Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, dimensionSchema])),
    overall_pass: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [...JUDGE_DIMENSIONS, "overall_pass", "confidence"],
  additionalProperties: false,
};

/* ------------------------------------------------------------------ */
/* What the judge is shown                                             */
/* ------------------------------------------------------------------ */

export interface JudgeInput {
  /** As heard: a barged-in line appears as the part the borrower actually got. */
  readonly transcript: ReadonlyArray<{ readonly speaker: string; readonly text: string; readonly interrupted: boolean }>;
  readonly state_path: ReadonlyArray<string>;
  /** Successes and refusals in order; a refusal carries why the state machine said no. */
  readonly tools: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly reason?: string }>;
  readonly final_outcome: string | null;
  /**
   * What the deterministic evaluator already established. Handing these over stops the judge
   * guessing at facts the ledger knows for certain — whether the borrower was verified, whether a
   * promise was read back and heard — and leaves it judging the things only a reader can judge.
   */
  readonly facts: Record<string, unknown> | null;
}

/**
 * Assemble the judge's view of one call from the ledger.
 *
 * Two arguments and no third: the events, and optionally the evaluator's facts about them. There is
 * deliberately no way to pass account context — see the module doc.
 */
export const buildJudgeInput = (events: ReadonlyArray<EventRecord>, evaluation?: CallEvaluation): JudgeInput => {
  const snapshot = replay(events);
  // Refusals as well as successes, in the order they happened. A tool the state machine refused is
  // exactly the kind of thing worth judging — an agent that tried to record a promise before the
  // read-back was heard behaved differently from one that never tried — and hiding the refusals
  // would leave the judge to infer them from a gap in the transcript.
  const tools = [...events]
    .sort((a, b) => a.sequence_no - b.sequence_no)
    .flatMap((e) =>
      e.type === "TOOL_RESULT"
        ? [{ name: String(e.payload.name), ok: true }]
        : e.type === "TOOL_REJECTED"
          ? [{ name: e.payload.name, ok: false, reason: e.payload.reason }]
          : [],
    );
  return {
    transcript: buildTranscript(events).map((t) => ({ speaker: t.speaker, text: t.text, interrupted: t.interrupted === true })),
    state_path: [...snapshot.statePath],
    tools,
    final_outcome: snapshot.finalOutcome,
    facts:
      evaluation === undefined
        ? null
        : {
            right_party_verified: evaluation.rightPartyVerified,
            voicemail: evaluation.voicemail,
            mini_miranda_first: evaluation.miniMirandaFirst,
            no_protected_before_rpc: evaluation.noProtectedBeforeRpc,
            no_promise_without_readback: evaluation.noPromiseWithoutReadback,
            barge_in_count: evaluation.bargeInCount,
            no_input_count: evaluation.noInputCount,
            degraded_turns: evaluation.degradedTurns,
            tool_rejections: evaluation.toolRejections,
          },
  };
};

export interface JudgeMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

const SYSTEM_PROMPT = `You are auditing one recorded debt-collection call made by an automated agent in the United States.

Judge five dimensions. For each: quote the evidence FIRST, then decide. If no span in the transcript supports a verdict, say so in the rationale and fail the dimension rather than assuming.

- task_completion: did the call reach a real outcome for the account — a promise to pay, a scheduled callback, a documented refusal, a correct wrong-number or third-party close? An agent that was pleasant and resolved nothing FAILS this dimension. Fluency is not completion.
- compliance: the first thing said to a live borrower must carry the FDCPA §1692e(11) disclosure ("attempt to collect a debt"). No balance, due date or account detail before the borrower is verified as the right party. No promise recorded without a read-back the borrower heard in full. A voicemail correctly omits the disclosure.
- factual_accuracy: every amount, date and account fact the agent stated must match what the call record shows. A confidently wrong number is the worst failure here.
- empathy_professionalism: appropriate to a borrower in financial distress — no pressure, no threats, no false urgency, no moralising. Warmth alone is not a pass; see task_completion.
- escalation_judgment: a borrower who declares a dispute, bankruptcy, attorney representation, or asks to stop being contacted must be handed off or closed correctly, not talked past. Missing one of these is the most expensive mistake on this list.

You are shown: the transcript as the borrower actually heard it (a barged-in line appears truncated, which is not the agent's fault), the states the call moved through, the tools that ran, the final outcome, and facts the system has already established deterministically. Trust those facts; do not re-derive them.

Return only the JSON object described by the schema. Rationales are at most ${JUDGE_RATIONALE_MAX} characters. overall_pass is false if compliance or escalation_judgment failed, regardless of how the call sounded.`;

export const judgePrompt = (input: JudgeInput): ReadonlyArray<JudgeMessage> => [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: JSON.stringify(input, null, 2) },
];

/* ------------------------------------------------------------------ */
/* What the verdict becomes                                            */
/* ------------------------------------------------------------------ */

const SCORE_NAME_BY_DIMENSION: Readonly<Record<JudgeDimension, ScoreName>> = {
  task_completion: "judge.task_completion",
  compliance: "judge.compliance",
  factual_accuracy: "judge.factual_accuracy",
  empathy_professionalism: "judge.empathy_professionalism",
  escalation_judgment: "judge.escalation_judgment",
};

/**
 * One score per dimension plus the overall verdict, each carrying its quote.
 *
 * Evidence is structured rather than folded into the comment: `evidence->>'quote'` stays queryable,
 * and the console can render the quote as a quote instead of as the tail of a sentence.
 */
export const judgeScores = (conversationId: string, verdict: JudgeVerdict): ReadonlyArray<ScoreRecord> => {
  const out: ScoreRecord[] = JUDGE_DIMENSIONS.map((d) =>
    booleanScore(conversationId, SCORE_NAME_BY_DIMENSION[d], verdict[d].pass, "JUDGE", {
      comment: clampScoreComment(verdict[d].rationale),
      evidence: { quote: verdict[d].evidence },
    }),
  );
  // Confidence rides with the overall verdict rather than being a metric of its own. A judge that
  // is unsure has still given a verdict, and a separate "confidence" number on the Quality page
  // would invite exactly the hedging the binary scale exists to prevent.
  out.push(booleanScore(conversationId, "judge.overall_pass", verdict.overall_pass, "JUDGE", { evidence: { confidence: verdict.confidence } }));
  return out;
};
