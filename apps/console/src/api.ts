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
  turn_decider: string;
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
