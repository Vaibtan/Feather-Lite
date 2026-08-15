# Feather-Lite demo script (v2)

The interviewer's 10 minutes. Everything runs from the console URL; the terminal is only for the
"look at the code" part. What the console does is exactly what this document says — nothing here
is aspirational (see README "Not built" for what is deliberately missing).

## 0. Before the call (2 min prep)

- Server + worker up (`pnpm dev`, or `pnpm start:server` + `pnpm start:worker`), tunnel running
  (`pnpm tunnel`), console open at the Pages URL with `?api=…#token=…` (or `http://127.0.0.1:5173`
  locally). Set `TURN_DECIDER=openai` for the real model.
- **Status** shows: API up, DB ok, `feather-lite-agent` online (heartbeat < 30 s), decider `openai`.
- Demo data seeded (**Status → Seed demo data**): Jordan Avery (America/New_York), Priya Nair
  (Asia/Kolkata, prior PROMISE_TO_PAY), Sam Ortiz (opted out → 422), Lee Chen (invalid contact →
  422), Morgan Reyes (Europe/London). The borrower picker labels anyone the pre-call policy would
  reject with the reason (TCPA window, opt-out, invalid number) and "expect 422".

## 1. Platform, not chatbot (2 min)

1. **Conversations**: outcomes, channel (`voice` vs `simulated`), duration. Open a completed one:
   transcript (bubbles; interrupted agent lines show the *heard* text), **event timeline**
   (`CALL_STARTED → STATE_TRANSITION → AGENT_TURN → USER_TURN_FINAL → TOOL_CALLED/TOOL_RESULT → …
   → CALL_ENDED → OUTBOX_ENQUEUED → OUTBOX_PROCESSED`), **Replay from events** (state rebuilt from
   the ledger only), scheduled actions and outbox jobs.
2. **Scenarios → Run all**: 20 scenarios go green in ~3 s — state paths, tool sequences,
   call-control actions, outcomes; each row's `open` link is a real conversation the run wrote.
   Point at `invalid-llm-transition-recovered` and `tool-in-wrong-state-fails-closed`: the model
   suggested something illegal, the state machine rejected it, the call continued.

## 2. The call (4 min)

3. **Live call → Call me in the browser** (as Jordan). The interviewer hears the non-interruptible
   Mini-Miranda + recording disclosure and the right-party question; the ledger timeline on the
   right updates every 2 s.
   - "Yes, this is Jordan" → `TOOL_CALLED confirm_right_party` → `STATE_TRANSITION VERIFYING_IDENTITY →
     DISCUSSING_PAYMENT (RIGHT_PARTY_CONFIRMED)`; the agent now
     recites the balance/due date (protected context was invisible to the model before this).
   - Interrupt the agent mid-sentence → it stops; next turn shows
     `AGENT_TURN_PLAYOUT{interrupted:true, heard_text}`.
   - "I can pay 200 on the 25th" → `propose_promise_to_pay` → read-back → "yes" →
     `record_promise_to_pay{confirmed:true}` → **"I have recorded…" is spoken only after the
     commit** → the agent closes and hangs up; outcome `PROMISE_TO_PAY`, outbox jobs land.
4. Latency: every `turn_end` frame carries `ttft_ms` (shown under each reply in **Simulate**; stored
   per turn in `conversation_turns.result`); if Langfuse keys are set, the trace has one generation
   per turn (model, state, tokens, TTFT).
5. Optional: **Dial my phone (SIP)** — needs a SIP trunk id in `.env`; AMD → voicemail path or a
   live PSTN conversation. Not verified in v2; skip unless configured.

## 3. Guardrails (1 min)

6. **Simulate**: type "I lost my job" → immediate `ESCALATED` (override before the model),
   `CALL_CONTROL WARM_TRANSFER`, human follow-up scheduled. Start another and type "stop calling
   me" → `OPT_OUT`; then pick Sam Ortiz in the picker: **Start** returns 422 `BORROWER_OPT_OUT`.
7. **Status → Guardrails**: durable counts of `TOOL_REJECTED` / `TURN_DECISION_REJECTED` — "the
   state machine caught the model N times" — next to outcomes and volume.

## 4. Code walk (1 min, if asked)

- `packages/domain/src/stateMachine.ts` — adjacency, override-only and forced targets; exhaustive table tests.
- `packages/control-plane/src/services/Orchestrator.ts` — `processTurn`: T1 claim → decide → T2 commit → speak (ADR 0003).
- `apps/voice-worker/src/feather-agent.ts` — `llmNode` streams `/turn`; `say` frames; playout/no-input/opening signals (ADR 0002).
- `docs/adr/` — 0001 loop in the control plane · 0002 llmNode · 0003 three-phase turn · 0004 hosting · 0005 TS + Effect.

## Fallbacks

- Worker offline → the console says so; run **Simulate** instead (same orchestrator, same events).
- LiveKit inference credit exhausted → set `LIVEKIT_STT_MODEL` / `LIVEKIT_TTS_MODEL` to other
  LiveKit Inference models, or bring-your-own-key plugins.
- Public URL down → local console at `http://127.0.0.1:5173` over screen share.
- OpenAI down → `TURN_DECIDER=scripted` restarts the server in deterministic mode; every turn
  still works, just without the model's phrasing.
