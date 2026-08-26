/**
 * Minimal HTTP client for the control plane used by the voice worker: turn stream (SSE),
 * signals, no-input, heartbeat. Plain fetch (Node 22) — the SSE parser is the only real logic.
 */
import type { TurnFrame } from "@feather-lite/contracts";
import { decodeFrame } from "@feather-lite/contracts";

export interface ControlPlaneConfig {
  readonly baseUrl: string;
  readonly bearerToken: string | null;
}

export interface TurnRequestBody {
  readonly turn_id: string;
  readonly user_text: string;
  readonly playout?: { readonly turn_id: string; readonly heard_text: string; readonly interrupted: boolean };
  readonly supersede?: boolean;
}

export type SignalBody =
  | { kind: "amd_result"; result: "HUMAN" | "MACHINE" | "NO_ANSWER" | "UNCERTAIN"; confidence?: number; action_id?: string }
  | { kind: "no_answer"; action_id?: string }
  | { kind: "hangup"; reason?: string; action_id?: string }
  | { kind: "barge_in"; partial_agent_text?: string; action_id?: string }
  | { kind: "playout"; turn_id: string; heard_text: string; interrupted: boolean }
  | { kind: "opening_played"; text: string }
  | { kind: "voicemail_drop"; confidence?: number; action_id?: string }
  | { kind: "turn_metrics"; turn_id: string; eou_delay_ms?: number; transcription_delay_ms?: number; tts_ttfb_ms?: number };

export interface ProviderEventBody {
  readonly provider: string;
  readonly kind: "error" | "retry" | "timeout";
  readonly stage: "stt" | "tts" | "llm" | "media";
  readonly message: string;
  readonly conversation_id?: string | null;
}

export interface RuntimeResult {
  readonly agent_text: string;
  readonly new_state: string;
  readonly call_control_action: { action: string; action_id: string } | null;
  readonly outcome: string | null;
  readonly end_call: boolean;
}

export class ControlPlaneClient {
  constructor(private readonly cfg: ControlPlaneConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.cfg.bearerToken) h["authorization"] = `Bearer ${this.cfg.bearerToken}`;
    return h;
  }

  /** Stream a turn. Yields decoded frames; throws on non-2xx before the stream starts. */
  async *turn(conversationId: string, body: TurnRequestBody, signal?: AbortSignal): AsyncGenerator<TurnFrame> {
    const res = await fetch(`${this.cfg.baseUrl}/api/conversations/${conversationId}/turn`, {
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`turn ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const parsed = decodeFrame(JSON.parse(dataLine.slice(5).trim()));
        if (parsed._tag === "Right") yield parsed.right;
      }
    }
  }

  async signal(conversationId: string, body: SignalBody): Promise<RuntimeResult> {
    const res = await fetch(`${this.cfg.baseUrl}/api/conversations/${conversationId}/signal`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`signal ${body.kind} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as RuntimeResult;
  }

  async noInput(conversationId: string): Promise<RuntimeResult> {
    const res = await fetch(`${this.cfg.baseUrl}/api/conversations/${conversationId}/no_input`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`no_input ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as RuntimeResult;
  }

  /**
   * Report vendor failures the runtime saw (spec 2026-08-26, D6). Deliberately not a conversation
   * signal: a retried STT socket is not an event on the call, and it must not consume a
   * `sequence_no` on a path that is already degraded. Fire-and-forget for the same reason the
   * heartbeat is — telemetry must never be able to fail a call.
   */
  async providerEvents(events: ReadonlyArray<ProviderEventBody>): Promise<void> {
    if (events.length === 0) return;
    await fetch(`${this.cfg.baseUrl}/api/system/provider-events`, { method: "POST", headers: this.headers(), body: JSON.stringify({ events }) }).catch(() => undefined);
  }

  async heartbeat(agentName: string, meta: Record<string, unknown>): Promise<void> {
    await fetch(`${this.cfg.baseUrl}/api/agents/heartbeat`, { method: "POST", headers: this.headers(), body: JSON.stringify({ agent_name: agentName, meta }) }).catch(() => undefined);
  }

  async conversation(conversationId: string): Promise<{ conversation: { current_state: string; final_outcome: string | null } }> {
    const res = await fetch(`${this.cfg.baseUrl}/api/conversations/${conversationId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`detail ${res.status}`);
    return (await res.json()) as { conversation: { current_state: string; final_outcome: string | null } };
  }
}
