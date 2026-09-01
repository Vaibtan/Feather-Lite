/**
 * The HTTP contract (SPEC §12, PRD §9) as an Effect `HttpApi`. Shared by the server (handlers),
 * the voice worker (typed client) and the console. Wire shapes are snake_case.
 *
 * Endpoint map (kept compatible with the Python reference where it existed):
 *   POST /api/calls/start                          pre-call policy + workflow/attempt/conversation
 *   GET  /api/conversations                        list
 *   GET  /api/conversations/:id                    detail: transcript, timeline, replay
 *   POST /api/conversations/:id/simulate_turn      SPEC §12.2 non-streaming alias
 *   POST /api/conversations/:id/turn               streaming turn (SSE frames, see turnFrames.ts)
 *   POST /api/conversations/:id/signal             runtime/telephony signals
 *   POST /api/conversations/:id/no_input           no-input strike
 *   GET  /api/conversations/:id/scores             quality scores for one call
 *   POST /api/conversations/:id/scores             ingest scores (harness runs, human labels)
 *   GET  /api/testing/scenarios ; POST /api/testing/scenarios/:id/run ; POST /api/testing/scenarios/run-all
 *   GET  /api/borrowers                            demo directory
 *   POST /api/agents/heartbeat ; GET /api/system/status
 *   POST /api/system/provider-events               vendor failures the voice worker saw
 *   GET  /api/system/quality                       funnel + rates + SLO + agreement
 *   POST /api/voice/sessions                       LiveKit room + dispatch + browser token
 *   POST /api/demo/seed ; POST /api/demo/reset     (demo mode)
 *   GET  /healthz ; GET /readyz
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { CallControlAction, ConversationState, Outcome, PreCallFailure, ScoreDataType, ScoreName, ScoreSource } from "@feather-lite/domain";
import { CallControlSummary, ToolCalledSummary } from "./turnFrames.js";

/* ------------------------------ errors ------------------------------ */

export class ApiNotFound extends Schema.TaggedError<ApiNotFound>()("ApiNotFound", {
  entity: Schema.String,
  id: Schema.String,
}, HttpApiSchema.annotations({ status: 404 })) {}

export class ApiPreCallRejected extends Schema.TaggedError<ApiPreCallRejected>()("ApiPreCallRejected", {
  error: Schema.String,
  validation_failures: Schema.Array(PreCallFailure),
}, HttpApiSchema.annotations({ status: 422 })) {}

export class ApiConflict extends Schema.TaggedError<ApiConflict>()("ApiConflict", {
  code: Schema.Literal("CONVERSATION_COMPLETED", "TURN_IN_PROGRESS"),
  message: Schema.String,
}, HttpApiSchema.annotations({ status: 409 })) {}

export class ApiUnavailable extends Schema.TaggedError<ApiUnavailable>()("ApiUnavailable", {
  message: Schema.String,
}, HttpApiSchema.annotations({ status: 503 })) {}

export class ApiUnauthorized extends Schema.TaggedError<ApiUnauthorized>()("ApiUnauthorized", {
  message: Schema.String,
}, HttpApiSchema.annotations({ status: 401 })) {}

export class ApiBadRequest extends Schema.TaggedError<ApiBadRequest>()("ApiBadRequest", {
  message: Schema.String,
}, HttpApiSchema.annotations({ status: 400 })) {}

/* ------------------------------ shapes ------------------------------ */

const Json = Schema.Unknown;
const JsonRecord = Schema.Record({ key: Schema.String, value: Json });

export const StartCallRequest = Schema.Struct({
  borrower_id: Schema.String,
  contact_point_id: Schema.String,
  channel: Schema.optional(Schema.Literal("simulated", "voice")),
  /** Demo-mode clock override (ISO-8601). Ignored unless DEMO_MODE. */
  now: Schema.optional(Schema.String),
});
export const StartCallResponse = Schema.Struct({
  conversation_id: Schema.String,
  workflow_execution_id: Schema.String,
  call_attempt_id: Schema.String,
  attempt_no: Schema.Number,
  opening_text: Schema.String,
});

export const ConversationSummary = Schema.Struct({
  conversation_id: Schema.String,
  borrower_id: Schema.String,
  borrower_name: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  final_outcome: Schema.NullOr(Schema.String),
  duration_seconds: Schema.NullOr(Schema.Number),
  channel: Schema.String,
  current_state: Schema.String,
});
export const ConversationList = Schema.Struct({
  items: Schema.Array(ConversationSummary),
  total: Schema.Number,
  limit: Schema.Number,
  offset: Schema.Number,
});

export const TranscriptEntry = Schema.Struct({
  speaker: Schema.Literal("AGENT", "BORROWER"),
  text: Schema.String,
  timestamp: Schema.String,
  sequence_no: Schema.Number,
  interrupted: Schema.optional(Schema.Boolean),
});
export const TimelineEntry = Schema.Struct({
  sequence_no: Schema.Number,
  type: Schema.String,
  payload: JsonRecord,
  created_at: Schema.String,
});
export const ConversationDetail = Schema.Struct({
  conversation: Schema.Struct({
    id: Schema.String,
    borrower_id: Schema.String,
    workflow_execution_id: Schema.String,
    call_attempt_id: Schema.String,
    started_at: Schema.String,
    ended_at: Schema.NullOr(Schema.String),
    final_outcome: Schema.NullOr(Schema.String),
    final_outcome_metadata: JsonRecord,
    channel: Schema.String,
    current_state: Schema.String,
    protected_context_unlocked: Schema.Boolean,
    transfer_target: Schema.NullOr(Schema.String),
  }),
  transcript: Schema.Array(TranscriptEntry),
  event_timeline: Schema.Array(TimelineEntry),
  replay: JsonRecord,
  scheduled_actions: Schema.Array(JsonRecord),
  outbox_jobs: Schema.Array(JsonRecord),
});

export const SimulateTurnRequest = Schema.Struct({
  user_text: Schema.String.pipe(Schema.minLength(1)),
  turn_id: Schema.optional(Schema.String),
});
/** SPEC §12.2 shape (+ turn_id, degraded). */
export const SimulateTurnResponse = Schema.Struct({
  turn_id: Schema.String,
  agent_text: Schema.String,
  new_state: ConversationState,
  tool_called: Schema.NullOr(ToolCalledSummary),
  call_control_action: Schema.NullOr(CallControlSummary),
  outcome: Schema.NullOr(Outcome),
  end_call: Schema.Boolean,
  degraded: Schema.Boolean,
});

export const TurnRequest = Schema.Struct({
  turn_id: Schema.String.pipe(Schema.minLength(1)),
  user_text: Schema.String,
  playout: Schema.optional(Schema.Struct({ turn_id: Schema.String, heard_text: Schema.String, interrupted: Schema.Boolean })),
  supersede: Schema.optional(Schema.Boolean),
});

export const SignalRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("amd_result"), result: Schema.Literal("HUMAN", "MACHINE", "NO_ANSWER", "UNCERTAIN"), confidence: Schema.optional(Schema.Number), action_id: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("no_answer"), action_id: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("hangup"), reason: Schema.optional(Schema.String), action_id: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("barge_in"), partial_agent_text: Schema.optional(Schema.String), action_id: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("playout"), turn_id: Schema.String, heard_text: Schema.String, interrupted: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("opening_played"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("voicemail_drop"), confidence: Schema.optional(Schema.Number), action_id: Schema.optional(Schema.String) }),
  /**
   * Runtime latency the voice worker measured for a turn and the control plane cannot see: the
   * end-of-utterance delay and transcription delay (before `/turn` was ever called) and the TTS
   * time-to-first-byte (after it returned). Together with the decide TTFT the control plane already
   * records, one turn row then holds the whole borrower-stops-speaking -> agent-audio waterfall.
   */
  Schema.Struct({
    kind: Schema.Literal("turn_metrics"),
    turn_id: Schema.String,
    eou_delay_ms: Schema.optional(Schema.Number),
    transcription_delay_ms: Schema.optional(Schema.Number),
    tts_ttfb_ms: Schema.optional(Schema.Number),
    /** Played audio duration and the characters synthesised for it (D5, TTS heuristics). */
    tts_audio_ms: Schema.optional(Schema.Number),
    tts_chars: Schema.optional(Schema.Number),
  }),
);
export type SignalRequest = typeof SignalRequest.Type;

export const RuntimeResult = Schema.Struct({
  agent_text: Schema.String,
  new_state: ConversationState,
  call_control_action: Schema.NullOr(Schema.Struct({ action: CallControlAction, action_id: Schema.String })),
  outcome: Schema.NullOr(Outcome),
  end_call: Schema.Boolean,
});

export const ScenarioSummary = Schema.Struct({ scenario_id: Schema.String, description: Schema.String });
export const ScenarioRunResponse = Schema.Struct({
  scenario_id: Schema.String,
  passed: Schema.Boolean,
  conversation_id: Schema.String,
  expected_state_path: Schema.Array(Schema.String),
  actual_state_path: Schema.Array(Schema.String),
  expected_tools: Schema.Array(Schema.String),
  actual_tools: Schema.Array(Schema.String),
  expected_call_control_actions: Schema.Array(Schema.String),
  actual_call_control_actions: Schema.Array(Schema.String),
  required_event_types: Schema.Array(Schema.String),
  actual_event_types: Schema.Array(Schema.String),
  expected_final_outcome: Schema.NullOr(Schema.String),
  final_outcome: Schema.NullOr(Schema.String),
  replay_snapshot: JsonRecord,
  assertion_failures: Schema.Array(Schema.String),
  duration_ms: Schema.Number,
});

export const BorrowerDirectoryEntry = Schema.Struct({
  borrower_id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  timezone: Schema.String,
  within_contact_window: Schema.Boolean,
  contact_points: Schema.Array(Schema.Struct({ contact_point_id: Schema.String, value: Schema.String, is_valid: Schema.Boolean, consent_status: Schema.String, priority: Schema.Number })),
  loan: Schema.NullOr(Schema.Struct({ balance_due: Schema.String, due_date: Schema.String, status: Schema.String, delinquency_days: Schema.Number })),
});

/* --------------------------- quality report --------------------------- */

const Rate = Schema.NullOr(Schema.Number);

/**
 * The collections funnel (spec 2026-08-26, D7). Counts are conversations, not events, so a call
 * that verified twice still counts once. Rates are ratios of the *previous* stage, which is how the
 * industry reads them: contact rate is of attempts, right-party of connected, promise of
 * right-party. A rate is null rather than 0 when its denominator is 0 — "no calls reached a person"
 * and "every call that reached a person failed" are different findings.
 */
export const Funnel = Schema.Struct({
  attempts: Schema.Number,
  /** Calls that have reached a final outcome. `attempts - finished` are still in flight. */
  finished: Schema.Number,
  /** Still running. Counted, never folded into a rate: an unfinished call has not failed either. */
  in_progress: Schema.Number,
  /**
   * A person answered: a *finished* call whose outcome is neither no-answer nor a machine.
   * An in-flight call is not connected — it may yet turn out to be either (O3).
   */
  connected: Schema.Number,
  voicemail: Schema.Number,
  right_party: Schema.Number,
  promise_to_pay: Schema.Number,
  callback_scheduled: Schema.Number,
  failed: Schema.Number,
  orphaned: Schema.Number,
  rates: Schema.Struct({
    contact: Rate,
    /** SPEC §17.2's "right-party verification success rate". */
    right_party: Rate,
    promise: Rate,
    /** SPEC §17.2's "voicemail rate", of attempts. */
    voicemail: Rate,
  }),
});

/**
 * A promise the agent recorded, and whether it has come due. Promise-*kept* needs payment data this
 * system does not have — a `record_payment` tool is the missing input, named here rather than
 * silently approximated — so this reports only what the ledger can honestly say.
 */
export const PromiseRow = Schema.Struct({
  conversation_id: Schema.String,
  borrower_name: Schema.String,
  amount: Schema.String,
  date: Schema.String,
  status: Schema.Literal("PENDING", "DUE_TODAY", "OVERDUE"),
});

/**
 * Which population the SLO was computed over (O2). An SLO across every call this system has ever
 * placed is not a claim about anything: a window of scripted load-test turns and a window of real
 * voice calls have nothing to say about each other.
 */
export const SloSegment = Schema.Struct({
  channel: Schema.NullOr(Schema.String),
  decider: Schema.NullOr(Schema.String),
  /** How many calls in the segment the window asked for, and how many it actually found. */
  calls_requested: Schema.Number,
  calls_found: Schema.Number,
});
export type SloSegment = typeof SloSegment.Type;

/** One latency component's verdict. `insufficient_sample` is not a pass and not a failure. */
export const SloComponent = Schema.Struct({
  target_ms: Schema.Number,
  /** p95 over turns that carry this component. Null when none did, or when below the minimum. */
  measured_ms: Schema.NullOr(Schema.Number),
  /** Turns carrying this component in the window — the denominator the verdict rests on. */
  n: Schema.Number,
  status: Schema.Literal("pass", "breach", "insufficient_sample", "not_measured"),
});
export type SloComponent = typeof SloComponent.Type;

export const SloReport = Schema.Struct({
  pass: Schema.Boolean,
  segment: SloSegment,
  /** Below this many observations a component reports `insufficient_sample` rather than a verdict. */
  min_sample: Schema.Number,
  components: Schema.Record({ key: Schema.String, value: SloComponent }),
  targets: Schema.Record({ key: Schema.String, value: Schema.Number }),
  /** p95 per component, over the same window. Null where the window had no turns carrying it. */
  measured: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Number) }),
  /** Which components missed their target; empty when `pass`. */
  breaches: Schema.Array(Schema.String),
  /** Components with too few observations to judge. A verdict of `pass` with these is not a clean bill. */
  insufficient: Schema.Array(Schema.String),
});
export type SloReport = typeof SloReport.Type;

const Aggregate = Schema.Struct({ n: Schema.Number, mean: Schema.NullOr(Schema.Number), p50: Schema.NullOr(Schema.Number), p95: Schema.NullOr(Schema.Number) });

export const ScoreSummary = Schema.Struct({
  name: ScoreName,
  source: ScoreSource,
  n: Schema.Number,
  mean: Schema.NullOr(Schema.Number),
  /** For BOOLEAN scores, the share that passed. Null for numeric ones. */
  pass_rate: Rate,
});

/**
 * Speech-synthesis heuristics (spec 2026-08-26, D5). **These are not a quality score.** There is no
 * MOS model in this system — UTMOS and NISQA are Python-only and were ruled out of scope — so what
 * is reported is what the runtime can honestly know: whether any audio was produced, and whether a
 * turn's speaking rate was far enough from the window's median to be worth a human ear. A turn
 * flagged here may sound perfectly fine; a turn not flagged here may not.
 */
export const TtsHeuristicsReport = Schema.Struct({
  /** Turns that had a voice runtime at all — the denominator. Simulated turns are not counted. */
  turns: Schema.Number,
  silent_playouts: Schema.Number,
  /** Null when no turn tried to speak: "the voice worked every time" and "we never checked" differ. */
  silent_playout_rate: Rate,
  chars_per_second: Schema.Struct({
    n: Schema.Number,
    /** The baseline the outlier band is measured against — the window's own median, not a constant. */
    median: Schema.NullOr(Schema.Number),
    min: Schema.NullOr(Schema.Number),
    max: Schema.NullOr(Schema.Number),
  }),
  /** Time to the voice's first audio frame over the same turns — the SLO gates on this p95. */
  ttfb_ms: Schema.Struct({ n: Schema.Number, p50: Schema.NullOr(Schema.Number), p95: Schema.NullOr(Schema.Number) }),
  /** Deviation from the median beyond which a turn is flagged, as a share (0.4 = ±40 %). */
  outlier_band: Schema.Number,
  /** Readings needed before any turn can be flagged; below this the median is not a baseline. */
  baseline_readings: Schema.Number,
  outlier_count: Schema.Number,
  /** The worst few, most deviant first. `deviation` is signed: +1 is double the median rate. */
  outliers: Schema.Array(Schema.Struct({ turn_id: Schema.String, chars_per_second: Schema.Number, deviation: Schema.Number })),
});
export type TtsHeuristicsReport = typeof TtsHeuristicsReport.Type;

export const QualityReport = Schema.Struct({
  window: Schema.Struct({
    calls: Schema.NullOr(Schema.Number),
    from: Schema.NullOr(Schema.String),
    to: Schema.NullOr(Schema.String),
    conversations: Schema.Number,
  }),
  funnel: Funnel,
  promises: Schema.Array(PromiseRow),
  slo: SloReport,
  /** Heuristics, not a quality score — see `TtsHeuristicsReport`. */
  tts: TtsHeuristicsReport,
  /** Durable counts from the ledger, plus how long orphan detection actually took. */
  reliability: Schema.Struct({
    counts: Schema.Record({ key: Schema.String, value: Schema.Number }),
    orphan_detect_ms: Aggregate,
    /** Live, process-local provider failures — labelled separately because they reset on restart. */
    provider_counters: Schema.Record({ key: Schema.String, value: Schema.Number }),
  }),
  scores: Schema.Array(ScoreSummary),
  /** STT word error rate, harness-only: production calls have no ground truth to compare against. */
  stt_wer: Aggregate,
  /**
   * How often the judge and a human agreed, over calls that have both labels. `rate` is null until
   * at least one call has been labelled by hand — an agreement number with no human input is not a
   * calibration, and reporting 1.0 for an empty set would be a lie.
   */
  judge_agreement: Schema.Struct({
    judged: Schema.Number,
    human_labelled: Schema.Number,
    both: Schema.Number,
    agreed: Schema.Number,
    rate: Rate,
  }),
});
export type QualityReport = typeof QualityReport.Type;

/**
 * A vendor failure the voice worker saw and handled (spec 2026-08-26, D6). Reported out of band
 * rather than as a conversation signal: a retried Deepgram socket is not something that happened
 * *on the call* in the replayable sense, and it must not consume a `sequence_no` or take the
 * conversation row lock on a path that is already degraded. `conversation_id` is optional because
 * a provider can fail before, between or outside calls.
 */
export const ProviderEventBody = Schema.Struct({
  provider: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60)),
  kind: Schema.Literal("error", "retry", "timeout"),
  stage: Schema.Literal("stt", "tts", "llm", "media"),
  message: Schema.String.pipe(Schema.maxLength(300)),
  conversation_id: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ProviderEventsRequest = Schema.Struct({
  events: Schema.Array(ProviderEventBody).pipe(Schema.minItems(1), Schema.maxItems(50)),
});

export const RecordedProviderEvent = Schema.Struct({
  provider: Schema.String,
  kind: Schema.String,
  stage: Schema.String,
  message: Schema.String,
  conversation_id: Schema.NullOr(Schema.String),
  at: Schema.String,
});

/**
 * Worker liveness. `conversations` is the list this worker is serving right now — the signal the
 * orphaned-call sweeper runs on (D6). Explicit rather than buried in `meta` because the control
 * plane acts on it: a conversation nobody has claimed for three intervals becomes a sweep candidate.
 */
export const HeartbeatRequest = Schema.Struct({
  agent_name: Schema.String,
  meta: Schema.optional(JsonRecord),
  conversations: Schema.optional(Schema.Array(Schema.String).pipe(Schema.maxItems(200))),
});
export const SystemStatus = Schema.Struct({
  ok: Schema.Boolean,
  database: Schema.Literal("ok", "down"),
  agents: Schema.Array(Schema.Struct({ agent_name: Schema.String, last_seen_at: Schema.String, online: Schema.Boolean, meta: JsonRecord })),
  counters: JsonRecord,
  /** Durable counts from the ledger (survive restarts): outcomes and guardrail events. */
  ledger: Schema.Struct({
    conversations_total: Schema.Number,
    outcomes: Schema.Record({ key: Schema.String, value: Schema.Number }),
    guardrails: Schema.Record({ key: Schema.String, value: Schema.Number }),
    /**
     * The failure modes ADR 0008 found, counted from committed events rather than incremented in
     * process — so they are exact, and they survive a restart.
     */
    reliability: Schema.Record({ key: Schema.String, value: Schema.Number }),
  }),
  /**
   * Vendor reliability, live view. `counters` never resets except on restart and `recent` is a
   * short ring, so this answers "what is degrading right now"; the durable rates live on
   * /api/system/quality.
   */
  provider_events: Schema.Struct({
    counters: Schema.Record({ key: Schema.String, value: Schema.Number }),
    recent: Schema.Array(RecordedProviderEvent),
  }),
  /** Latency measured against its target over the most recent calls (D6). */
  slo: SloReport,
  turn_decider: Schema.String,
  demo_mode: Schema.Boolean,
  /**
   * Whether the post-call LLM judge is on. Exposed so a load harness can refuse to start against a
   * server that would bill a reasoning-model call per conversation (O13) — cost discipline the
   * docs asserted and nothing enforced.
   */
  judge: Schema.Struct({ enabled: Schema.Boolean, model: Schema.String }),
  /**
   * Load this server shed rather than served (O9). Counted apart from provider failures because
   * they answer opposite questions: a 429 is this process working as configured, not a vendor
   * failing. `buckets` is the size of the per-IP map, published so an unbounded one is visible.
   */
  /**
   * What the server process is doing to itself (D3). Absent before this: every number on this page
   * was about calls, and none of it answered "is the event loop blocked" or "is the pool starving".
   */
  process: Schema.Struct({
    uptime_seconds: Schema.Number,
    /**
     * CPU this process has burned since boot. The denominator of the per-core budget (D1): before
     * this it could only be read from outside, by a harness guessing which OS process was the
     * server.
     */
    cpu_seconds: Schema.Struct({ user: Schema.Number, system: Schema.Number }),
    event_loop_delay_ms: Schema.Struct({ p50: Schema.Number, p99: Schema.Number, max: Schema.Number }),
    memory_bytes: Schema.Struct({ rss: Schema.Number, heap_used: Schema.Number, heap_total: Schema.Number, external: Schema.Number }),
    gc: Schema.Struct({ total_pause_ms: Schema.Number, collections: Schema.Number }),
    /** Null in a process with no database, so "not measured" is not reported as an empty pool. */
    pg_pool: Schema.NullOr(Schema.Struct({ size: Schema.Number, idle: Schema.Number, waiting: Schema.Number })),
    /** Each background loop and when it last ticked. A stale one fails `/readyz`. */
    loops: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        /** Null when the loop is registered but has never completed a tick — which is itself stale. */
        last_tick_at: Schema.NullOr(Schema.String),
        interval_ms: Schema.Number,
        stale: Schema.Boolean,
        /** Ticks failed in a row. A live loop that errors every time reads fresh here and non-zero. */
        consecutive_failures: Schema.Number,
      }),
    ),
    sse_streams: Schema.Number,
    live_turns: Schema.Number,
    rate_limit_buckets: Schema.Number,
  }),
  rate_limiting: Schema.Struct({
    per_minute: Schema.Number,
    daily_turn_cap: Schema.Number,
    rejected_start: Schema.Number,
    rejected_turn: Schema.Number,
    rejected_daily_cap: Schema.Number,
    buckets: Schema.Number,
  }),
});

export const VoiceSessionRequest = Schema.Struct({
  borrower_id: Schema.String,
  contact_point_id: Schema.String,
  participant_identity: Schema.optional(Schema.String),
  participant_name: Schema.optional(Schema.String),
  /** "browser" joins via WebRTC token; "sip" dials the contact point through the configured trunk. */
  mode: Schema.optional(Schema.Literal("browser", "sip")),
});
export const VoiceSessionResponse = Schema.Struct({
  conversation_id: Schema.String,
  workflow_execution_id: Schema.String,
  call_attempt_id: Schema.String,
  room_name: Schema.String,
  participant_identity: Schema.String,
  participant_token: Schema.String,
  livekit_url: Schema.String,
  agent_name: Schema.String,
  dispatch_id: Schema.String,
});

/* ------------------------------ groups ------------------------------ */

const IdPath = Schema.Struct({ id: Schema.String });

/**
 * One turn's latency waterfall. The four components are the serial cost of a reply: the borrower
 * stops speaking, the session decides the turn is over (`eou_delay_ms`), the transcript lands
 * (`transcription_delay_ms`), the decider produces its first token (`ttft_ms`), and TTS produces its
 * first byte (`tts_ttfb_ms`). Any of them is null when the turn had no voice worker behind it —
 * simulated calls and load tests fill in only `ttft_ms`.
 */
export const TurnLatencyRow = Schema.Struct({
  turn_id: Schema.String,
  started_at: Schema.String,
  status: Schema.String,
  state: Schema.NullOr(Schema.String),
  eou_delay_ms: Schema.NullOr(Schema.Number),
  transcription_delay_ms: Schema.NullOr(Schema.Number),
  ttft_ms: Schema.NullOr(Schema.Number),
  tts_ttfb_ms: Schema.NullOr(Schema.Number),
  /** Sum of whichever components are present — the height of the stacked bar. */
  total_ms: Schema.NullOr(Schema.Number),
  /**
   * The turn's speech shape (spec 2026-08-26, D5): how much audio was produced for how many
   * characters, and the rate that implies. Not part of the waterfall — a reply's speed does not
   * depend on how long the reply then took to say — but the same row is where a turn's synthesis is
   * described, and a `tts_ttfb_ms` reading means nothing on a turn that produced no audio at all.
   */
  tts_audio_ms: Schema.NullOr(Schema.Number),
  tts_chars: Schema.NullOr(Schema.Number),
  tts_chars_per_second: Schema.NullOr(Schema.Number),
  /** The synthesis produced no audio: the ADR 0008 failure, and why a rate may be missing. */
  tts_silent: Schema.Boolean,
});

/**
 * One quality measurement about a call (or one of its turns). `value` is always numeric — a BOOLEAN
 * score is 1/0 and a CATEGORICAL one carries its label in `string_value` — because that is the
 * shape Langfuse stores and having two disagree would defeat the point of mirroring them.
 */
export const ScoreRow = Schema.Struct({
  conversation_id: Schema.String,
  turn_id: Schema.NullOr(Schema.String),
  name: ScoreName,
  value: Schema.Number,
  data_type: ScoreDataType,
  string_value: Schema.NullOr(Schema.String),
  source: ScoreSource,
  comment: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(JsonRecord),
  created_at: Schema.String,
});
export type ScoreRow = typeof ScoreRow.Type;

/**
 * Score ingest. Sources are restricted to the ones that legitimately come from outside the server:
 * a harness run posting its measured WER and equivalence verdict, an operator recording a label,
 * and SYSTEM for out-of-process probes. EVALUATOR, JUDGE and SCENARIO are written by the jobs and
 * the suite that produce them, so no client can post a judge verdict the judge never reached.
 */
export const PostScoresRequest = Schema.Struct({
  scores: Schema.Array(
    Schema.Struct({
      name: ScoreName,
      value: Schema.Number,
      source: Schema.Literal("HARNESS", "HUMAN", "SYSTEM"),
      turn_id: Schema.optional(Schema.NullOr(Schema.String)),
      string_value: Schema.optional(Schema.NullOr(Schema.String)),
      comment: Schema.optional(Schema.NullOr(Schema.String)),
      evidence: Schema.optional(Schema.NullOr(JsonRecord)),
    }),
  ).pipe(Schema.minItems(1), Schema.maxItems(200)),
});

const Percentiles = Schema.Struct({ n: Schema.Number, p50: Schema.NullOr(Schema.Number), p95: Schema.NullOr(Schema.Number) });

export type TurnLatencyRow = typeof TurnLatencyRow.Type;

export const LatencyAggregate = Schema.Struct({
  conversations: Schema.Number,
  turns: Schema.Number,
  /**
   * Component readings discarded as impossible (negative, or over five minutes). Surfaced rather
   * than silently dropped, so "no data" and "we hid data" are distinguishable: a non-zero count here
   * means something is writing bad durations, not that the calls were quiet.
   */
  implausible_dropped: Schema.Number,
  eou_delay_ms: Percentiles,
  transcription_delay_ms: Percentiles,
  ttft_ms: Percentiles,
  tts_ttfb_ms: Percentiles,
  total_ms: Percentiles,
});
export type LatencyAggregate = typeof LatencyAggregate.Type;

export const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("healthz", "/healthz").addSuccess(Schema.Struct({ status: Schema.Literal("ok"), version: Schema.String })))
  /**
   * Readiness, not liveness (D3). `/healthz` says the process is running; this says it is doing its
   * job. A process whose outbox fiber has died answers HTTP perfectly and is not ready, and before
   * this the two were indistinguishable — `SELECT 1` was the whole check.
   */
  .add(
    HttpApiEndpoint.get("readyz", "/readyz")
      .addSuccess(Schema.Struct({ status: Schema.Literal("ready"), database: Schema.Literal("ok"), loops: Schema.Array(Schema.String) }))
      .addError(ApiUnavailable),
  )
  /**
   * The `process` block below, in Prometheus exposition format, so the same numbers a human reads
   * on the console can be scraped beside `livekit-server`'s own `/metrics` (D3). Text, not JSON:
   * the content type is part of the contract a scraper checks.
   */
  .add(
    HttpApiEndpoint.get("metrics", "/metrics").addSuccess(
      Schema.String.pipe(HttpApiSchema.withEncoding({ kind: "Text", contentType: "text/plain; version=0.0.4; charset=utf-8" })),
    ),
  )
  .add(HttpApiEndpoint.get("status", "/api/system/status").addSuccess(SystemStatus))
  .add(
    HttpApiEndpoint.get("latency", "/api/system/latency")
      .setUrlParams(Schema.Struct({ calls: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(LatencyAggregate),
  )
  .add(HttpApiEndpoint.post("heartbeat", "/api/agents/heartbeat").setPayload(HeartbeatRequest).addSuccess(Schema.Struct({ ok: Schema.Literal(true) })))
  .add(
    HttpApiEndpoint.post("providerEvents", "/api/system/provider-events")
      .setPayload(ProviderEventsRequest)
      .addSuccess(Schema.Struct({ recorded: Schema.Number })),
  )
  .add(
    HttpApiEndpoint.get("quality", "/api/system/quality")
      .setUrlParams(Schema.Struct({ calls: Schema.optional(Schema.NumberFromString), from: Schema.optional(Schema.String), to: Schema.optional(Schema.String) }))
      .addSuccess(QualityReport),
  );

export const CallsGroup = HttpApiGroup.make("calls")
  .add(HttpApiEndpoint.post("start", "/api/calls/start").setPayload(StartCallRequest).addSuccess(StartCallResponse).addError(ApiPreCallRejected).addError(ApiNotFound))
  .add(HttpApiEndpoint.get("borrowers", "/api/borrowers").addSuccess(Schema.Array(BorrowerDirectoryEntry)));

export const ConversationsGroup = HttpApiGroup.make("conversations")
  .add(
    HttpApiEndpoint.get("list", "/api/conversations")
      .setUrlParams(Schema.Struct({ limit: Schema.optional(Schema.NumberFromString), offset: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(ConversationList),
  )
  .add(HttpApiEndpoint.get("detail", "/api/conversations/:id").setPath(IdPath).addSuccess(ConversationDetail).addError(ApiNotFound))
  .add(
    HttpApiEndpoint.post("simulateTurn", "/api/conversations/:id/simulate_turn")
      .setPath(IdPath)
      .setPayload(SimulateTurnRequest)
      .addSuccess(SimulateTurnResponse)
      .addError(ApiNotFound)
      .addError(ApiConflict),
  )
  .add(
    HttpApiEndpoint.post("turn", "/api/conversations/:id/turn")
      .setPath(IdPath)
      .setPayload(TurnRequest)
      // Streams `text/event-stream`; the success schema documents the frame type only.
      .addSuccess(Schema.String.pipe(HttpApiSchema.withEncoding({ kind: "Text", contentType: "text/event-stream" })))
      .addError(ApiNotFound)
      .addError(ApiConflict),
  )
  .add(HttpApiEndpoint.post("signal", "/api/conversations/:id/signal").setPath(IdPath).setPayload(SignalRequest).addSuccess(RuntimeResult).addError(ApiNotFound).addError(ApiConflict))
  .add(HttpApiEndpoint.post("noInput", "/api/conversations/:id/no_input").setPath(IdPath).addSuccess(RuntimeResult).addError(ApiNotFound).addError(ApiConflict))
  .add(HttpApiEndpoint.get("latency", "/api/conversations/:id/latency").setPath(IdPath).addSuccess(Schema.Array(TurnLatencyRow)).addError(ApiNotFound))
  .add(HttpApiEndpoint.get("scores", "/api/conversations/:id/scores").setPath(IdPath).addSuccess(Schema.Array(ScoreRow)).addError(ApiNotFound))
  .add(
    HttpApiEndpoint.post("postScores", "/api/conversations/:id/scores")
      .setPath(IdPath)
      .setPayload(PostScoresRequest)
      .addSuccess(Schema.Struct({ written: Schema.Number }))
      .addError(ApiNotFound)
      .addError(ApiBadRequest),
  );

export const TestingGroup = HttpApiGroup.make("testing")
  .add(HttpApiEndpoint.get("scenarios", "/api/testing/scenarios").addSuccess(Schema.Array(ScenarioSummary)))
  .add(HttpApiEndpoint.post("runScenario", "/api/testing/scenarios/:id/run").setPath(IdPath).addSuccess(ScenarioRunResponse).addError(ApiNotFound))
  .add(HttpApiEndpoint.post("runAll", "/api/testing/scenarios/run-all").addSuccess(Schema.Array(ScenarioRunResponse)));

export const VoiceGroup = HttpApiGroup.make("voice").add(
  HttpApiEndpoint.post("createSession", "/api/voice/sessions").setPayload(VoiceSessionRequest).addSuccess(VoiceSessionResponse).addError(ApiPreCallRejected).addError(ApiNotFound).addError(ApiUnavailable),
);

/** Throwaway borrowers for load tests: one live conversation per borrower is a pre-call rule, so a
 * run at concurrency C needs C of them. Demo-mode only. */
export const LoadFixtureRequest = Schema.Struct({
  count: Schema.Number.pipe(Schema.int(), Schema.between(1, 1000)),
  /** Distinguishes one run's fixtures from another's in the borrowers table. */
  prefix: Schema.optional(Schema.String),
});
export const LoadFixture = Schema.Struct({
  borrower_id: Schema.String,
  contact_point_id: Schema.String,
  name: Schema.String,
  timezone: Schema.String,
});

export const DemoGroup = HttpApiGroup.make("demo")
  .add(HttpApiEndpoint.post("seed", "/api/demo/seed").addSuccess(Schema.Array(Schema.Struct({ name: Schema.String, created: Schema.Boolean }))))
  .add(HttpApiEndpoint.post("reset", "/api/demo/reset").addSuccess(Schema.Array(Schema.Struct({ name: Schema.String, created: Schema.Boolean }))))
  .add(HttpApiEndpoint.post("loadFixtures", "/api/demo/load-fixtures").setPayload(LoadFixtureRequest).addSuccess(Schema.Array(LoadFixture)).addError(ApiBadRequest));

export class FeatherApi extends HttpApi.make("feather-lite")
  .add(SystemGroup)
  .add(CallsGroup)
  .add(ConversationsGroup)
  .add(TestingGroup)
  .add(VoiceGroup)
  .add(DemoGroup)
  .addError(ApiUnauthorized)
  .addError(ApiBadRequest) {}
