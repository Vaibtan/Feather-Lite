# ADR 0001 — The control plane owns the conversation loop; the voice worker is a media adapter

- Status: accepted (2026-08-16), implemented in v2
- Related: [ADR 0002](0002-voice-worker-overrides-llmnode.md), [ADR 0003](0003-three-phase-turn-transaction.md)

## Context

A collections agent has two very different jobs on every turn: *deciding what is allowed to happen*
(right-party verification before any account data, tools only in the states where they are legal,
promises recorded before they are confirmed aloud, compliance overrides that beat the model) and
*sounding like a person* (phrasing, empathy, negotiation). PRD §4/§5.2 and SPEC §3.1 make the first
job a deterministic state machine and the second an LLM, and require that a JSON simulation and a
real voice call produce **identical events** for the same inputs (SPEC §10.5).

LiveKit Agents offers an attractive alternative: per-state `voice.Agent` subclasses with
`llm.handoff()` between them, tools attached per agent, all running inside the worker process.

## Decision

The **control plane** (`packages/control-plane`, one HTTP API on the always-on URL) owns the loop:

`POST /api/conversations/:id/turn` → override check → `TurnDecider` (LLM or scripted) →
adjacency / tool-matrix validation → tool execution → durable event append → streamed reply.

Simulation (`/turn` from the console), the scenario runner (in-process, scripted decider, frozen
clock) and the voice worker (`llmNode` → `/turn` SSE) all go through the *same* `Orchestrator`
service. The worker never decides anything about the conversation; it turns audio into
`user_text` + `heard_text` and frames into speech.

## Consequences

- **Equivalence is testable.** The 20-scenario suite runs against real Postgres with no LiveKit
  in the loop, and a scripted voice call through LiveKit Cloud produced the same state path, tool
  sequence and outcome as the corresponding scenario (verified in Phase 5). Phase 8 made that
  assertion automatic rather than eyeballed — the tracer now compares a finished call's ledger to
  the scenario run through the same API — and held it on a self-hosted media server and across
  concurrent calls (`docs/loadtest/`, [ADR 0006](0006-self-hosted-livekit-for-local-dev.md)).
- **The authority lives on the durable URL.** Killing the worker mid-call loses audio, not the
  ledger; a re-dispatched worker resumes from `active_turn_id`/`current_state`.
- **One extra network hop per turn** (worker → control plane). Measured decision TTFT with GPT-4.1
  was 1.2–2 s end-to-end; the hop is a few ms on the same box and ~50 ms across a tunnel.
- The `llm.handoff()` design remains a plausible v3 experiment *inside* the worker for latency,
  but only with the state machine still validating every transition server-side.

## Alternatives considered

| Option | Why not (for v2) |
|---|---|
| Per-state `voice.Agent` + `llm.handoff()` in the worker | State authority moves into the Node worker; scenarios need livekit-agents in the loop; JSON and voice paths diverge in event shape |
| Worker calls the LLM directly, posts events to the API afterwards | Events become advisory, not authoritative; tool side effects can happen before they are durable |
