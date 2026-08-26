/**
 * The score vocabulary (spec `2026-08-26-quality-and-slo-layer-spec.md` D1).
 *
 * A score is a measurement *about* a call — was it compliant, was it transcribed correctly, did it
 * meet the latency SLO — as opposed to a conversation event, which is a record of something that
 * *happened on* the call. The distinction is load-bearing: events carry a monotonic `sequence_no`
 * and replay to the outcome, so re-running an evaluator or a judge must never touch them. Scores
 * live in their own table, are upserted by identity, and are free to change when the evaluator does.
 *
 * The names are a closed vocabulary here rather than free strings at each producer, so a typo
 * cannot quietly create a second metric that the console never shows and Langfuse charts beside the
 * real one. Every producer — the deterministic evaluator, the judge, the voice harness, a human —
 * writes names from this list or does not compile. The list grows with the producers: a name is
 * added in the same change that first writes it, so an entry here is never a metric nobody emits.
 */
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export const SCORE_NAMES = [
  /** Deterministic compliance checks, derived from the ledger (EVALUATOR). */
  "compliance.mini_miranda_first",
  "compliance.no_protected_before_rpc",
  "compliance.no_promise_without_readback",

  /** Deterministic call facts, also ledger-derived (EVALUATOR) — the funnel and the judge read these. */
  "call.right_party_verified",
  "call.voicemail",
  "call.barge_in_count",
  "call.no_input_count",
  "call.degraded_turns",
  "call.tool_rejections",
  "call.agent_turns",
  "call.borrower_turns",
  "call.duration_ms",

  /** LLM-as-judge verdicts: binary per dimension, with evidence (JUDGE). */
  "judge.task_completion",
  "judge.compliance",
  "judge.factual_accuracy",
  "judge.empathy_professionalism",
  "judge.escalation_judgment",
  "judge.overall_pass",
  /** The judge returned something that was not a verdict. Its own score so a broken judge is
   *  visible as a broken judge, rather than as a call with no opinion — which is what an operator
   *  would otherwise see, and would read as "nobody has looked at this one yet". */
  "judge.invalid_output",

  /** Speech quality. WER needs ground truth, so it only ever comes from the harness (HARNESS). */
  "stt.wer",
  "stt.wer_worst_line",
  "tts.silent_playout",
  "tts.chars_per_second",

  /** Latency (SYSTEM). `latency.response_ms` is per turn; the SLO verdict is per call. */
  "latency.response_ms",
  "latency.slo_pass",

  /** Harness and suite outcomes. */
  "harness.equivalence_pass",
  "scenario.pass_rate",

  /** Reliability: how long the sweeper took to notice a conversation had lost its worker (SYSTEM). */
  "system.orphan_detect_ms",

  /** The operator's own label — the calibration target for `judge.overall_pass` (HUMAN). */
  "human.overall_pass",
] as const;

export const ScoreName = Schema.Literal(...SCORE_NAMES);
export type ScoreName = typeof ScoreName.Type;

/* ------------------------------------------------------------------ */
/* Sources and data types                                              */
/* ------------------------------------------------------------------ */

/**
 * Who produced the score. Part of the identity of a score, so the judge's verdict and a human's
 * label on the same call are two rows that can be compared, not one that overwrites the other.
 */
export const SCORE_SOURCES = ["EVALUATOR", "JUDGE", "HARNESS", "HUMAN", "SCENARIO", "SYSTEM"] as const;
export const ScoreSource = Schema.Literal(...SCORE_SOURCES);
export type ScoreSource = typeof ScoreSource.Type;

/** Mirrors Langfuse's score data types (the subset this system produces). */
export const SCORE_DATA_TYPES = ["NUMERIC", "BOOLEAN", "CATEGORICAL"] as const;
export const ScoreDataType = Schema.Literal(...SCORE_DATA_TYPES);
export type ScoreDataType = typeof ScoreDataType.Type;

/**
 * The data type each name is measured in. Declared once so the console can render a name it has
 * never seen (pass/fail chip vs. number) and so a producer cannot write `judge.overall_pass = 0.7`.
 * Langfuse requires boolean score values to be exactly 1 or 0, which this table is what enforces.
 */
export const SCORE_DATA_TYPE_BY_NAME: Readonly<Record<ScoreName, ScoreDataType>> = {
  "compliance.mini_miranda_first": "BOOLEAN",
  "compliance.no_protected_before_rpc": "BOOLEAN",
  "compliance.no_promise_without_readback": "BOOLEAN",
  "call.right_party_verified": "BOOLEAN",
  "call.voicemail": "BOOLEAN",
  "call.barge_in_count": "NUMERIC",
  "call.no_input_count": "NUMERIC",
  "call.degraded_turns": "NUMERIC",
  "call.tool_rejections": "NUMERIC",
  "call.agent_turns": "NUMERIC",
  "call.borrower_turns": "NUMERIC",
  "call.duration_ms": "NUMERIC",
  "judge.task_completion": "BOOLEAN",
  "judge.compliance": "BOOLEAN",
  "judge.factual_accuracy": "BOOLEAN",
  "judge.empathy_professionalism": "BOOLEAN",
  "judge.escalation_judgment": "BOOLEAN",
  "judge.overall_pass": "BOOLEAN",
  "judge.invalid_output": "BOOLEAN",
  "stt.wer": "NUMERIC",
  "stt.wer_worst_line": "NUMERIC",
  "tts.silent_playout": "BOOLEAN",
  "tts.chars_per_second": "NUMERIC",
  "latency.response_ms": "NUMERIC",
  "latency.slo_pass": "BOOLEAN",
  "harness.equivalence_pass": "BOOLEAN",
  "scenario.pass_rate": "NUMERIC",
  "system.orphan_detect_ms": "NUMERIC",
  "human.overall_pass": "BOOLEAN",
};

/**
 * Prefixes whose boolean scores are a **verdict** — something passed or failed — as opposed to a
 * fact about the call that happens to be boolean.
 *
 * `call.voicemail = 0` means "no answering machine picked up" and `call.right_party_verified = 0`
 * means "this call never reached the borrower". Neither is a failure, and rendering them in the red
 * reserved for a breached compliance check would teach an operator that red means nothing. The
 * distinction lives here rather than in the console because both the Quality page and the
 * conversation detail need it, and a rule spelled out in two views drifts.
 */
export const VERDICT_SCORE_PREFIXES: ReadonlyArray<string> = ["compliance.", "judge.", "human.", "harness."];

export const isVerdictScore = (name: string): boolean => VERDICT_SCORE_PREFIXES.some((p) => name.startsWith(p));

/** Names that describe one turn rather than the whole call; everything else is call-level. */
export const TURN_LEVEL_SCORE_NAMES: ReadonlySet<ScoreName> = new Set<ScoreName>([
  "latency.response_ms",
  "stt.wer",
  "tts.silent_playout",
  "tts.chars_per_second",
]);

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

/** Langfuse truncates long comments and a comment is meant to be readable in a list, not a report. */
export const SCORE_COMMENT_MAX = 500;

/**
 * One measurement. `(conversationId, turnId, name, source)` is its identity: writing it again —
 * a re-judge, a second harness run over the same call — updates in place rather than appending,
 * which is also how Langfuse's idempotent score `id` behaves.
 */
export interface ScoreRecord {
  readonly conversationId: string;
  /** null for a call-level score. */
  readonly turnId: string | null;
  readonly name: ScoreName;
  /** Always numeric, including for BOOLEAN (1/0) and CATEGORICAL (the ordinal); see `stringValue`. */
  readonly value: number;
  readonly source: ScoreSource;
  /** The label of a CATEGORICAL score. null otherwise. */
  readonly stringValue?: string | null;
  /** One line a human can read to see why. Clamped to `SCORE_COMMENT_MAX`. */
  readonly comment?: string | null;
  /** Structured backing for the comment — the judge's quoted transcript span, the worst WER line. */
  readonly evidence?: Record<string, unknown> | null;
}

/** Clamp a comment to the stored width, preserving the front (where the verdict is). */
export const clampScoreComment = (comment: string | null | undefined): string | null =>
  comment === null || comment === undefined ? null : comment.length <= SCORE_COMMENT_MAX ? comment : `${comment.slice(0, SCORE_COMMENT_MAX - 1)}…`;

/** A BOOLEAN score. Langfuse rejects any value other than 1 or 0 for this data type. */
export const booleanScore = (
  conversationId: string,
  name: ScoreName,
  pass: boolean,
  source: ScoreSource,
  extra: { readonly turnId?: string | null; readonly comment?: string | null; readonly evidence?: Record<string, unknown> | null } = {},
): ScoreRecord => ({
  conversationId,
  turnId: extra.turnId ?? null,
  name,
  value: pass ? 1 : 0,
  source,
  stringValue: null,
  comment: clampScoreComment(extra.comment),
  evidence: extra.evidence ?? null,
});

/** A NUMERIC score. */
export const numericScore = (
  conversationId: string,
  name: ScoreName,
  value: number,
  source: ScoreSource,
  extra: { readonly turnId?: string | null; readonly comment?: string | null; readonly evidence?: Record<string, unknown> | null } = {},
): ScoreRecord => ({
  conversationId,
  turnId: extra.turnId ?? null,
  name,
  value,
  source,
  stringValue: null,
  comment: clampScoreComment(extra.comment),
  evidence: extra.evidence ?? null,
});

/**
 * Reject a record whose value contradicts its name's declared data type, so a bad producer fails
 * where it writes rather than at the Langfuse ingestion boundary (which drops the score silently).
 * Returns the reason, or null when the record is well-formed.
 */
export const scoreRecordProblem = (record: ScoreRecord): string | null => {
  const expected = SCORE_DATA_TYPE_BY_NAME[record.name];
  if (expected === undefined) return `unknown score name ${record.name}`;
  if (!Number.isFinite(record.value)) return `${record.name}: value must be finite, got ${String(record.value)}`;
  if (expected === "BOOLEAN" && record.value !== 0 && record.value !== 1) return `${record.name}: BOOLEAN scores must be 1 or 0, got ${record.value}`;
  if (expected === "CATEGORICAL" && (record.stringValue === null || record.stringValue === undefined)) return `${record.name}: CATEGORICAL scores need a string_value`;
  return null;
};

/** The data type a record will be stored and mirrored with. */
export const dataTypeOf = (name: ScoreName): ScoreDataType => SCORE_DATA_TYPE_BY_NAME[name];
