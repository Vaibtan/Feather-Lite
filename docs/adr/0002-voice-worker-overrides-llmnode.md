# ADR 0002 — The voice worker overrides `Agent.llmNode()` and streams the control-plane turn

- Status: accepted (2026-08-16), implemented in `apps/voice-worker/src/feather-agent.ts`
- Related: [ADR 0001](0001-conversation-loop-in-the-control-plane.md), tracer findings
  `docs/plans/2026-08-16-phase-1.5-tracer-findings.md`

## Context

Given ADR 0001, the worker needs one integration point where "the user finished a turn" becomes
"speak this reply, sentence by sentence, with barge-in and metrics handled natively". LiveKit
Agents 1.6 exposes three candidates:

1. `llmNode(chatCtx, toolCtx, settings)` — the node the framework calls to produce the assistant
   reply as a `ReadableStream`;
2. `onUserTurnCompleted` + `session.say()` + `StopResponse` — the Python reference did this;
3. a custom `llm.LLM` implementation.

## Decision

`FeatherAgent extends voice.Agent` overrides `llmNode`. On each user turn it:

- reads the final user text (and, when the previous agent line was interrupted, the truncated
  `heard_text` from `conversation_item_added`) and opens `POST /turn` (SSE) with `supersede: true`;
- yields `delta` frames as bare strings — the framework does TTS streaming, interruption
  bookkeeping, `agent_state_changed`, transcript publication and metrics;
- turns `say` frames into `session.say(text, { allowInterruptions })` (queued after the reply);
- forwards `turn_end.call_control_action` / `end_call` into hangup (`ctx.deleteRoom()` after playout).

A placeholder `RemoteOrchestratorLLM` (whose `chat()` throws) is registered so the framework
does not refuse to generate replies; it is never called.

## Consequences

- Native barge-in: when the borrower interrupts, the framework truncates the assistant item to
  what was actually spoken; we forward it as `AGENT_TURN_PLAYOUT{interrupted, heard_text}` so the
  transcript and the read-back guard use the *heard* text, not the generated one.
- Read-backs are **interruptible** and the promise is only recorded when the read-back was fully
  heard (`record_promise_to_pay{confirmed:true}` is rejected otherwise). Non-interruptible
  read-backs looked safer but the framework **drops** user turns that complete during
  non-interruptible speech — a confirmed "yes" could vanish (finding F9).
- WHATWG `pull()` must loop until it enqueues, `preemptiveGeneration` is off (the turn is not
  known before the SSE opens), and `discardAudioIfUninterruptible` is false.
- Opening disclosure (Mini-Miranda) is spoken with `session.say(..., allowInterruptions:false)`
  and acknowledged with an `opening_played` signal so the ledger's `AGENT_TURN` is written when
  it was actually spoken (the voicemail path must not recite it).

## Alternatives considered

| Option | Why not |
|---|---|
| `onUserTurnCompleted` + `say()` + `StopResponse` | Loses native barge-in truncation and per-reply metrics; every reply becomes a "say" |
| Custom `llm.LLM` returning `ChatChunk`s | Works, but the control plane's reply is not an OpenAI-shaped chat completion; `llmNode` is the documented seam for "bring your own inference" |
