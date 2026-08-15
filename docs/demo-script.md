# Feather-Lite demo script

The interviewer's 10 minutes. Everything below runs from the console URL; the terminal is only
for the "look at the code" part. This document is also the specification for the console.

## 0. Before the call (2 min prep)

- `pnpm dev` (server + voice worker) on the laptop; `cloudflared tunnel run` gives the public API URL.
- Console (Cloudflare Pages) shows: **API online**, **Agent worker online (last heartbeat 3s)**, **Neon warm**.
- Seed data present: `Jordan Avery` (America/New_York, delinquent, has a prior NO_ANSWER), `Priya Nair`
  (Asia/Kolkata, delinquent, prior PROMISE_TO_PAY history), `Sam Ortiz` (opted out — used to show 422),
  `Lee Chen` (contact point invalid — 422). If the current hour is outside 08:00–21:00 for a
  borrower, the console greys them out with the reason (TCPA) and shows the next allowed time.

## 1. Platform, not chatbot (2 min)

1. Open **Conversations**. Point at the list: outcomes, channel, duration.
2. Open one completed conversation. Show **transcript** (with an *interrupted* agent line), then
   **event timeline**: `CALL_STARTED → STATE_TRANSITION → … → TOOL_CALLED/TOOL_RESULT → CALL_ENDED →
   OUTBOX_ENQUEUED`. Then **Replay** — the state rebuilt from events only.
3. Open **Scenarios** → **Run all**. 14 scenarios go green in ~5 s: state paths, tool sequences,
   call-control actions, event shapes, replay, idempotency, third-party phrasings, invalid LLM
   transition recovered, tool-in-wrong-state fails closed.

## 2. The call (4 min)

4. **Call me in the browser** (as Jordan). Interviewer hears the non-interruptible Mini-Miranda +
   recording disclosure and the right-party question.
   - Say "yes, this is Jordan" → protected context unlocks (event `RIGHT_PARTY_CONFIRMED` appears
     live in the timeline panel next to the call).
   - Interrupt the agent mid-sentence → it stops; the timeline shows `AGENT_TURN_PLAYOUT{interrupted:true, heard_text}`.
   - "I can pay 550 on Friday" → the agent reads it back (non-interruptible) → "yes" →
     `TOOL_CALLED record_promise_to_pay` → **confirmation is spoken only after commit** → hangs up.
5. Point at the per-turn **latency waterfall** (EOT → decision TTFT → first audio) and the Langfuse trace link.
6. Optional: **Dial my phone** → AMD → voicemail path (or a live PSTN conversation).

## 3. Guardrails (1 min)

7. Start a simulated conversation and type "I lost my job" → immediate `ESCALATED`, transfer events,
   human follow-up scheduled; type "stop calling me" on another → `OPT_OUT`, then show `POST /calls/start`
   for that borrower now returns **422 BORROWER_OPT_OUT**.
8. Show the **guardrail counters**: `TURN_DECISION_REJECTED` and `TOOL_REJECTED` rates ("the state
   machine caught the model N times").

## 4. Code walk (1 min, if asked)

- `packages/domain/src/stateMachine.ts` — adjacency, override-only, forced targets; the exhaustive table test.
- `packages/control-plane/src/orchestrator/turn.ts` — the three-phase turn and two-mode streaming.
- `apps/voice-worker/src/agent.ts` — `llmNode` is the control plane; `say` frames; AMD gate.
- `docs/adr/` — why the loop lives in the control plane; why not `llm.handoff`; the transaction boundary.

## Fallbacks

- Worker offline → the console says so; run the simulated conversation instead (same orchestrator).
- Inference credit exhausted → set `LIVEKIT_STT/TTS` env to bring-your-own-key plugins.
- Public URL down → local console at `http://localhost:8080` over screen share.
