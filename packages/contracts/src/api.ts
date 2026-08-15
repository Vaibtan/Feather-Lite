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
 *   GET  /api/testing/scenarios ; POST /api/testing/scenarios/:id/run ; POST /api/testing/scenarios/run-all
 *   GET  /api/borrowers                            demo directory
 *   POST /api/agents/heartbeat ; GET /api/system/status
 *   POST /api/voice/sessions                       LiveKit room + dispatch + browser token
 *   POST /api/demo/seed ; POST /api/demo/reset     (demo mode)
 *   GET  /healthz ; GET /readyz
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { CallControlAction, ConversationState, Outcome, PreCallFailure } from "@feather-lite/domain";
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

export const HeartbeatRequest = Schema.Struct({ agent_name: Schema.String, meta: Schema.optional(JsonRecord) });
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
  }),
  turn_decider: Schema.String,
  demo_mode: Schema.Boolean,
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

export const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("healthz", "/healthz").addSuccess(Schema.Struct({ status: Schema.Literal("ok"), version: Schema.String })))
  .add(HttpApiEndpoint.get("readyz", "/readyz").addSuccess(Schema.Struct({ status: Schema.Literal("ready"), database: Schema.Literal("ok") })).addError(ApiUnavailable))
  .add(HttpApiEndpoint.get("status", "/api/system/status").addSuccess(SystemStatus))
  .add(HttpApiEndpoint.post("heartbeat", "/api/agents/heartbeat").setPayload(HeartbeatRequest).addSuccess(Schema.Struct({ ok: Schema.Literal(true) })));

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
  .add(HttpApiEndpoint.post("noInput", "/api/conversations/:id/no_input").setPath(IdPath).addSuccess(RuntimeResult).addError(ApiNotFound).addError(ApiConflict));

export const TestingGroup = HttpApiGroup.make("testing")
  .add(HttpApiEndpoint.get("scenarios", "/api/testing/scenarios").addSuccess(Schema.Array(ScenarioSummary)))
  .add(HttpApiEndpoint.post("runScenario", "/api/testing/scenarios/:id/run").setPath(IdPath).addSuccess(ScenarioRunResponse).addError(ApiNotFound))
  .add(HttpApiEndpoint.post("runAll", "/api/testing/scenarios/run-all").addSuccess(Schema.Array(ScenarioRunResponse)));

export const VoiceGroup = HttpApiGroup.make("voice").add(
  HttpApiEndpoint.post("createSession", "/api/voice/sessions").setPayload(VoiceSessionRequest).addSuccess(VoiceSessionResponse).addError(ApiPreCallRejected).addError(ApiNotFound).addError(ApiUnavailable),
);

export const DemoGroup = HttpApiGroup.make("demo")
  .add(HttpApiEndpoint.post("seed", "/api/demo/seed").addSuccess(Schema.Array(Schema.Struct({ name: Schema.String, created: Schema.Boolean }))))
  .add(HttpApiEndpoint.post("reset", "/api/demo/reset").addSuccess(Schema.Array(Schema.Struct({ name: Schema.String, created: Schema.Boolean }))));

export class FeatherApi extends HttpApi.make("feather-lite")
  .add(SystemGroup)
  .add(CallsGroup)
  .add(ConversationsGroup)
  .add(TestingGroup)
  .add(VoiceGroup)
  .add(DemoGroup)
  .addError(ApiUnauthorized)
  .addError(ApiBadRequest) {}
