/**
 * Console API client. Base URL resolution: `?api=` query > localStorage > VITE_API_BASE_URL > same origin.
 * Bearer token: `#token=` fragment > localStorage.
 */
import { decodeFrame, type TurnFrame } from "@feather-lite/contracts";

const LS_API = "feather.apiBase";
const LS_TOKEN = "feather.apiToken";

const bootstrapSettings = () => {
  const url = new URL(window.location.href);
  const api = url.searchParams.get("api");
  if (api) localStorage.setItem(LS_API, api.replace(/\/$/, ""));
  const frag = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = frag.get("token");
  if (token) {
    localStorage.setItem(LS_TOKEN, token);
    history.replaceState(null, "", url.pathname + url.search);
  }
};
bootstrapSettings();

export const apiBase = (): string =>
  localStorage.getItem(LS_API) ?? (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "";
export const setApiBase = (v: string) => localStorage.setItem(LS_API, v.replace(/\/$/, ""));
export const apiToken = (): string | null => localStorage.getItem(LS_TOKEN);
export const setApiToken = (v: string) => (v ? localStorage.setItem(LS_TOKEN, v) : localStorage.removeItem(LS_TOKEN));

const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...extra };
  const t = apiToken();
  if (t) h["authorization"] = `Bearer ${t}`;
  return h;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

const req = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers: headers((init.headers as Record<string, string>) ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
};

/* ------------------------------ types (wire) ------------------------------ */

export interface ConversationSummary {
  conversation_id: string;
  borrower_id: string;
  borrower_name: string;
  started_at: string;
  ended_at: string | null;
  final_outcome: string | null;
  duration_seconds: number | null;
  channel: string;
  current_state: string;
}
export interface TranscriptEntry {
  speaker: "AGENT" | "BORROWER";
  text: string;
  timestamp: string;
  sequence_no: number;
  interrupted?: boolean;
}
export interface TimelineEntry {
  sequence_no: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
/** One turn's latency waterfall; see the API's TurnLatencyRow. Any component may be null. */
export interface TurnLatencyRow {
  turn_id: string;
  started_at: string;
  status: string;
  state: string | null;
  eou_delay_ms: number | null;
  transcription_delay_ms: number | null;
  ttft_ms: number | null;
  tts_ttfb_ms: number | null;
  total_ms: number | null;
  /** Speech shape, not part of the waterfall: see the API's TurnLatencyRow. */
  tts_audio_ms: number | null;
  tts_chars: number | null;
  tts_chars_per_second: number | null;
  tts_silent: boolean;
}

export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface LatencyAggregate {
  conversations: number;
  turns: number;
  /** Readings discarded as impossible; non-zero means something is writing bad durations. */
  implausible_dropped: number;
  eou_delay_ms: Percentiles;
  transcription_delay_ms: Percentiles;
  ttft_ms: Percentiles;
  tts_ttfb_ms: Percentiles;
  total_ms: Percentiles;
}

/** One quality measurement about a call or one of its turns; see the API's ScoreRow. */
export interface ScoreRow {
  conversation_id: string;
  turn_id: string | null;
  name: string;
  value: number;
  data_type: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  string_value: string | null;
  source: "EVALUATOR" | "JUDGE" | "HARNESS" | "HUMAN" | "SCENARIO" | "SYSTEM";
  comment: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
}

/** Which population the verdict was computed over, and how much of it there was (O2). */
export interface SloSegment {
  channel: string | null;
  decider: string | null;
  calls_requested: number;
  calls_found: number;
}

/** One component's verdict. `insufficient_sample` is neither a pass nor a failure. */
export interface SloComponent {
  target_ms: number;
  measured_ms: number | null;
  n: number;
  status: "pass" | "breach" | "insufficient_sample" | "not_measured";
}

export interface SloReport {
  pass: boolean;
  segment: SloSegment;
  min_sample: number;
  components: Record<string, SloComponent>;
  targets: Record<string, number>;
  measured: Record<string, number | null>;
  breaches: string[];
  /** Components with too few observations to judge; a `pass` alongside these is not a clean bill. */
  insufficient: string[];
}

/** A rate is null, never 0, when its denominator is 0 — see the API's Funnel. */
export interface QualityReport {
  window: { calls: number | null; from: string | null; to: string | null; conversations: number };
  funnel: {
    attempts: number;
    /** Calls that have reached a final outcome; `attempts - finished` are still in flight. */
    finished: number;
    in_progress: number;
    connected: number;
    voicemail: number;
    right_party: number;
    promise_to_pay: number;
    callback_scheduled: number;
    failed: number;
    orphaned: number;
    rates: { contact: number | null; right_party: number | null; promise: number | null; voicemail: number | null };
  };
  promises: Array<{ conversation_id: string; borrower_name: string; amount: string; date: string; status: "PENDING" | "DUE_TODAY" | "OVERDUE" }>;
  slo: SloReport;
  /** Heuristics, never a quality claim — the view says so on the card. */
  tts: {
    turns: number;
    silent_playouts: number;
    silent_playout_rate: number | null;
    chars_per_second: { n: number; median: number | null; min: number | null; max: number | null };
    ttfb_ms: { n: number; p50: number | null; p95: number | null };
    outlier_band: number;
    baseline_readings: number;
    outlier_count: number;
    outliers: Array<{ turn_id: string; chars_per_second: number; deviation: number }>;
  };
  reliability: {
    counts: Record<string, number>;
    orphan_detect_ms: { n: number; mean: number | null; p50: number | null; p95: number | null };
    provider_counters: Record<string, number>;
  };
  scores: Array<{ name: string; source: string; n: number; mean: number | null; pass_rate: number | null }>;
  stt_wer: { n: number; mean: number | null; p50: number | null; p95: number | null };
  judge_agreement: { judged: number; human_labelled: number; both: number; agreed: number; rate: number | null };
}

export interface ConversationDetail {
  conversation: {
    id: string;
    borrower_id: string;
    workflow_execution_id: string;
    call_attempt_id: string;
    started_at: string;
    ended_at: string | null;
    final_outcome: string | null;
    final_outcome_metadata: Record<string, unknown>;
    channel: string;
    current_state: string;
    protected_context_unlocked: boolean;
    transfer_target: string | null;
  };
  transcript: TranscriptEntry[];
  event_timeline: TimelineEntry[];
  replay: Record<string, unknown>;
  scheduled_actions: Array<Record<string, unknown>>;
  outbox_jobs: Array<Record<string, unknown>>;
}
export interface Borrower {
  borrower_id: string;
  name: string;
  status: string;
  timezone: string;
  within_contact_window: boolean;
  contact_points: Array<{ contact_point_id: string; value: string; is_valid: boolean; consent_status: string; priority: number }>;
  loan: { balance_due: string; due_date: string; status: string; delinquency_days: number } | null;
}
export interface SystemStatus {
  ok: boolean;
  database: "ok" | "down";
  agents: Array<{ agent_name: string; last_seen_at: string; online: boolean; meta: Record<string, unknown> }>;
  counters: Record<string, unknown>;
  ledger: { conversations_total: number; outcomes: Record<string, number>; guardrails: Record<string, number>; reliability: Record<string, number> };
  /** Live vendor failures; the durable rates are on /api/system/quality. */
  provider_events: { counters: Record<string, number>; recent: Array<{ provider: string; kind: string; stage: string; message: string; at: string; conversation_id: string | null }> };
  slo: SloReport;
  /** What the server process is doing to itself (D3): loop lateness, memory, GC, pool, loop liveness. */
  process: {
    uptime_seconds: number;
    cpu_seconds: { user: number; system: number };
    event_loop_delay_ms: { p50: number; p99: number; max: number };
    memory_bytes: { rss: number; heap_used: number; heap_total: number; external: number };
    gc: { total_pause_ms: number; collections: number };
    pg_pool: { size: number; idle: number; waiting: number } | null;
    loops: Array<{ name: string; last_tick_at: string | null; interval_ms: number; stale: boolean }>;
    sse_streams: number;
    live_turns: number;
    rate_limit_buckets: number;
  };
  turn_decider: string;
  judge: { enabled: boolean; model: string };
  /** Load this server shed rather than served (O9). A 429 is configuration, not a vendor failure. */
  rate_limiting: {
    per_minute: number;
    daily_turn_cap: number;
    rejected_start: number;
    rejected_turn: number;
    rejected_daily_cap: number;
    buckets: number;
  };
  demo_mode: boolean;
}
export interface ScenarioSummary {
  scenario_id: string;
  description: string;
}
export interface ScenarioRun {
  scenario_id: string;
  passed: boolean;
  conversation_id: string;
  expected_state_path: string[];
  actual_state_path: string[];
  expected_tools: string[];
  actual_tools: string[];
  expected_call_control_actions: string[];
  actual_call_control_actions: string[];
  final_outcome: string | null;
  expected_final_outcome: string | null;
  assertion_failures: string[];
  duration_ms: number;
}
export interface VoiceSession {
  conversation_id: string;
  room_name: string;
  participant_identity: string;
  participant_token: string;
  livekit_url: string;
  agent_name: string;
}

/* ------------------------------ calls ------------------------------ */

export const api = {
  status: () => req<SystemStatus>("/api/system/status"),
  borrowers: () => req<Borrower[]>("/api/borrowers"),
  conversations: (limit = 50, offset = 0) => req<{ items: ConversationSummary[]; total: number }>(`/api/conversations?limit=${limit}&offset=${offset}`),
  conversation: (id: string) => req<ConversationDetail>(`/api/conversations/${id}`),
  turnLatencies: (id: string) => req<TurnLatencyRow[]>(`/api/conversations/${id}/latency`),
  latencyAggregate: (calls = 20) => req<LatencyAggregate>(`/api/system/latency?calls=${calls}`),
  quality: (calls = 50) => req<QualityReport>(`/api/system/quality?calls=${calls}`),
  scores: (id: string) => req<ScoreRow[]>(`/api/conversations/${id}/scores`),
  /** Ingest path shared with the voice harnesses; the console only ever posts a HUMAN label. */
  postScores: (id: string, scores: Array<{ name: string; value: number; source: string; comment?: string | null }>) =>
    req<{ written: number }>(`/api/conversations/${id}/scores`, { method: "POST", body: JSON.stringify({ scores }) }),
  startCall: (borrower_id: string, contact_point_id: string) =>
    req<{ conversation_id: string; opening_text: string }>("/api/calls/start", { method: "POST", body: JSON.stringify({ borrower_id, contact_point_id, channel: "simulated" }) }),
  noInput: (id: string) => req<{ agent_text: string; new_state: string; end_call: boolean; outcome: string | null }>(`/api/conversations/${id}/no_input`, { method: "POST" }),
  signal: (id: string, body: Record<string, unknown>) => req<{ agent_text: string; new_state: string; end_call: boolean; outcome: string | null }>(`/api/conversations/${id}/signal`, { method: "POST", body: JSON.stringify(body) }),
  scenarios: () => req<ScenarioSummary[]>("/api/testing/scenarios"),
  runScenario: (id: string) => req<ScenarioRun>(`/api/testing/scenarios/${id}/run`, { method: "POST" }),
  runAll: () => req<ScenarioRun[]>("/api/testing/scenarios/run-all", { method: "POST" }),
  voiceSession: (borrower_id: string, contact_point_id: string, mode: "browser" | "sip") =>
    req<VoiceSession>("/api/voice/sessions", { method: "POST", body: JSON.stringify({ borrower_id, contact_point_id, mode, participant_identity: "console-browser", participant_name: "Console (browser)" }) }),
  seed: () => req<Array<{ name: string; created: boolean }>>("/api/demo/seed", { method: "POST" }),
  reset: () => req<Array<{ name: string; created: boolean }>>("/api/demo/reset", { method: "POST" }),

  /** Streaming turn: yields decoded frames. */
  async *turn(id: string, turn_id: string, user_text: string, signal?: AbortSignal): AsyncGenerator<TurnFrame> {
    const res = await fetch(`${apiBase()}/api/conversations/${id}/turn`, {
      method: "POST",
      headers: headers({ accept: "text/event-stream" }),
      body: JSON.stringify({ turn_id, user_text }),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        const parsed = decodeFrame(JSON.parse(data.slice(5).trim()));
        if (parsed._tag === "Right") yield parsed.right;
      }
    }
  },
};
