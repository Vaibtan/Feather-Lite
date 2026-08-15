# Feather-Lite Plan-vs-Build Review

**Date:** 2026-08-16 · **Scope:** `PRD.md`, `SPEC.md`, `backend/` (5.7k LOC Python), 25 unit tests, 12 in-process scenarios · **Reviewer stance:** senior voice-AI platform lead asked "is this the artifact that impresses Feather?"

---

## 1. Verdict

1. **The control plane is genuinely good.** Schema, event sourcing with monotonic `sequence_no`, state machine + tool-state matrix, idempotent tools, six-check pre-call validation, workflow/attempt/scheduled-action model, outbox-in-transaction, replay, and a 12-scenario runner all exist and closely follow the SPEC. This is real platform engineering, not a chatbot demo.
2. **`SPEC.md §19` ("all 8 phases Complete") is materially overstated.** The two things Feather will probe hardest are absent: **there is no LLM anywhere** — the "conversationalist" is a keyword/substring stub (`conversation_service.py:474-633`); and **no real voice call is evidenced** — the LiveKit path is a browser WebRTC token plus an agent that speaks the stub's text with `llm=None`, no SIP/PSTN, no AMD, no no-input timer.
3. **The compliance invariant the whole design is built around — right-party gating — is currently bypassable** by ordinary third-party phrasings ("I am not Jordan, he moved out" → protected context unlocked). The scenario that "proves" gating passes by construction.
4. **Zero engineering hygiene around the code:** nothing committed (`git status`: `?? backend/`), empty README, no docker-compose/Dockerfile/CI, scenarios not runnable in pytest and need a live Postgres (none reachable on this machine).
5. **The PRD's shape is right; keep it.** The gap is sequencing: the cheapest 60% was built and declared done; the 40% that carries the demo (LLM ↔ state machine, a live call, tracing) is what remains. Language/infra choice (TS+Effect, Cloudflare) is decided below by *interview date*, not taste.

---

## 2. What is built and good (verified by reading + 25 passing unit tests)

| Capability | Where | Notes |
|---|---|---|
| 11-table schema, indexes, unique constraints per SPEC §6 | `app/models/*`, `migrations/versions/4695df21e44e_initial_schema.py`, `9af9a0d6f3b1_outbox_jobs.py` | `conversations(call_attempt_id)` unique, `(conversation_id, sequence_no)` unique, `outbox_jobs` added |
| Event append with row-lock + MAX+1 `sequence_no`; state derived from events | `app/services/conversation_store.py:42-91` | Correct under READ COMMITTED; no `current_state` column by design |
| Adjacency map, override precedence (OPT_OUT > DISPUTE > HARDSHIP > WRONG_NUMBER), tool-state matrix | `app/services/state_machine.py` | Matches SPEC §8.1/§8.4/§10.6 exactly |
| Six domain tools, fail-closed by state, idempotent by `tool_call_id` (deterministic fallback hash) | `app/services/tool_dispatcher.py:86-126` | Duplicate call returns cached `TOOL_RESULT` |
| Pre-call validation: opt-out, consent/validity, TCPA 8–21 local, 7-in-7, active conversation, scheduled-action conflict, + contact-point association | `app/services/workflow_service.py:197-259` | 422 with `validation_failures[]` at `routes_calls.py:22-28` |
| Workflow reuse for follow-ups, atomic attempt increment (`UPDATE … RETURNING`) | `workflow_service.py:262-321` | |
| Scheduled actions: `SKIP LOCKED` claim, retry/backoff, cancel-on-opt-out/wrong-number | `scheduled_action_service.py`, `workers/scheduled_action_worker.py` | Callback/RETRY re-enter `start_call` with the same validation |
| Outbox rows written in the *same transaction* as finalize | `conversation_service.py:768`, `outbox_service.py:15-46` | Real outbox pattern; worker has retry/backoff/FAILED |
| Call-control log with `action_id` idempotency; transfer stub emits `TRANSFER_REQUESTED/COMPLETED` | `app/services/call_control.py` | |
| Durable-before-speak on voice: commit, *then* `session.say()` | `app/voice/agent_runtime.py:50-65` | Correct ordering |
| Replay of state / unlock / outcome / tools / call-control from events | `app/services/replay_service.py` | |
| 12 mandatory scenarios asserting state path, tools, call-control, event types, replay | `app/services/scenario_runner.py` | Statically traced 5 of 12; consistent with the stub |
| Operator console (conversations, transcript, timeline, scenario runner) | `app/api/routes_ui.py` | Escapes HTML; adequate for demo |
| Structured JSON logs with correlation ids; `/metrics` snapshot | `app/services/observability.py` | In-memory only |

---

## 3. Gap matrix — PRD/SPEC requirement → actual

Legend: ✅ done · 🟡 partial · ❌ absent · — n/a

### A. Conversation intelligence
| Requirement | Status | Evidence |
|---|---|---|
| LLM as "the conversationalist" (PRD §5.2.3, SPEC §9.4) | ❌ | No OpenAI/LLM import in `app/` (grep). `_generate_turn_decision` is substring matching. `openai` in `uv.lock` is transitive from `livekit-agents`. |
| Structured `TurnDecision` produced by LLM + validated | 🟡 | Schema + `validate_transition` exist; never fed by a model |
| Per-state model selection (PRD §5.2.2) | ❌ | — |
| Prompt builder with public/protected split + tests | 🟡 | `app/voice/prompt_builder.py` exists with tests but is **dead code** — never called by the runtime |
| Cross-call memory (last 3–5 conversations → compact block; PRD §5.2.3, Milestone 2) | ❌ | `memory_context` = current conversation's `final_outcome_metadata` only (`conversation_service.py:455-459`) |
| Override rules before LLM | 🟡 | Exists; 3–5 phrases per class. Misses "don't call me anymore", "I do not owe", "unemployed", "wrong guy" (probed) |
| Semantic override safety net | — | Stretch, correctly deferred |

### B. Voice / telephony
| Requirement | Status | Evidence |
|---|---|---|
| LiveKit room + agent dispatch + participant token | ✅ | `livekit_service.py:105-183`, rollback + cleanup on failure |
| `AgentSession` with VAD, `MultilingualModel`, endpointing, adaptive interruption, AEC warmup | ✅ | `agent_runtime.py:90-107` (LiveKit Inference strings for STT/TTS) |
| Agent hooked to orchestrator (LiveKit→TurnDecision adapter) | ✅ | `on_user_turn_completed` → `process_voice_turn` → `say` → `StopResponse` |
| Outbound PSTN via SIP (`create_sip_participant`) | ❌ | Not present; voice = browser WebRTC only |
| Inbound PSTN | ❌ | — |
| AMD → VOICEMAIL | 🟡 | `process_call_control_signal("voicemail_drop")` exists but is reachable **only from the scenario runner**; no runtime/telephony hook, no HTTP endpoint |
| Silence / NO_INPUT (2-strike) | 🟡 | Logic exists; in voice only fires if STT yields empty text. No idle timer / `user_state_changed=away` hook |
| Barge-in persisted as event | 🟡 | LiveKit handles barge-in natively; `barge_in` signal exists but nothing in runtime emits it |
| Non-interruptible Mini-Miranda | ✅ | greeting `allow_interruptions=False` |
| Non-interruptible readbacks | ❌ | all mid-call turns interruptible (`livekit_adapter.py:35`) |
| Sentence-level LLM→TTS streaming, latency <2s, timeouts/retries for STT/LLM/TTS | — | Nothing to stream/measure yet |
| **Evidence of one completed voice call** (PRD §4, Milestone 3) | ❌ | SPEC says "bootstrap verified" = room/dispatch API call succeeded, not a call |

### C. Observability
| Requirement | Status | Evidence |
|---|---|---|
| Langfuse (or equivalent) LLM tracing | ❌ | In-memory `MetricsRegistry` (200-trace deque) is not equivalent; nothing to trace yet |
| Business events with correlation ids | ✅ | JSON logs + `conversation_events` |
| Post-call LLM-as-judge | 🟡 | `_build_evaluation` is a string heuristic (stretch anyway) |

### D. Admin / QA
| Requirement | Status | Evidence |
|---|---|---|
| List (page/limit), detail w/ transcript + timeline | 🟡 | List has hard `limit(50)`, no pagination |
| Scenario runner API + UI | ✅ | |
| Scenarios in the automated test suite | ❌ | Only `test_scenario_registry_contains_full_mandatory_suite` checks the registry has 12 entries. Running them requires a live DB; no fixture, no compose |

### E. Engineering hygiene / deployment
| Requirement | Status | Evidence |
|---|---|---|
| Git history | ❌ | Single empty "Initial commit"; all work untracked |
| README / run instructions | ❌ | `backend/README.md` empty |
| docker-compose / Dockerfile / CI | ❌ | none; PRD §8 says Docker + compose |
| Auth on endpoints | ❌ | none (acceptable for demo; note it) |
| Secrets in env | ✅ | `.env` gitignored |

---

## 4. SPEC §19 status audit

| Phase | Claimed | Honest | Why |
|---|---|---|---|
| 1 Skeleton & schema | Complete | **Complete** | |
| 2 State machine & orchestrator | Complete | **Partial** | prompt builder unused; "LLM" is a stub; override list thin |
| 3 Durable eventing | Complete | **Complete** | |
| 4 Workflow & scheduled actions | Complete | **Complete** (edge in §5.7) | |
| 5 Voice runtime & call control | Complete | **Partial** | AMD/no-input/voicemail only via in-process signals; no telephony; no call evidence |
| 6 Admin APIs & scenarios | Complete | **Mostly** | scenarios not in pytest; need DB |
| 7 UI & observability | Complete | **Partial** | no Langfuse |
| 8 Hardening | Complete | **Partial** | worker retries yes; no external-call timeouts; "crash/restart replay test" is a `SimpleNamespace` unit test |

---

## 5. Defects found (ranked)

1. **Right-party gating bypass (compliance-critical).** `conversation_service.py:510` treats any of `"yes" | "speaking" | "this is" | "i am"` as verification. Probed:
   - `"I am not Jordan, he moved out"` → `DISCUSSING_PAYMENT`
   - `"yes but she's not here right now"` → `DISCUSSING_PAYMENT`
   - `"this is his mother, he's at work"` → `DISCUSSING_PAYMENT`
   Next turn reads the balance to a third party. This is exactly the FDCPA §1692c(b) failure the PRD lists as a non-negotiable invariant.
2. **The gating scenario proves nothing.** `protected-context-not-exposed-before-verification` only checks AGENT_TURN text for the literals "balance due"/"due date" before the transition, and its inputs were chosen to pass. Same for the outbox `_build_evaluation`.
3. **Wrong commitments get recorded.** `_extract_amount("I can pay two hundred on the 15th")` → `None` → falls back to full balance; `_extract_payment_date` maps anything not "tomorrow"/"friday" to +3 days. The readback would say "550.00 by <+3d>", and a borrower who says "yes" out of confusion gets a wrong PTP durably written. Callback time is always now+24h regardless of what was said.
4. **Voice NO_INPUT never fires** — `agent_runtime.py:46` only runs on turn completion.
5. **No HTTP surface for call-control signals** (`voicemail_drop`, `no_answer`, `barge_in`) — telephony webhooks/AMD would have nowhere to land.
6. **Override list is thin** — 4–5 literal phrases per class; STT variants (`"can't"` vs `"cannot"`, `"do not owe"` vs `"don't owe"`) fall through.
7. Scheduled callback that fails TCPA at its due time is retried 3× (5/10/15 min) then **CANCELED** rather than rescheduled to next 8am window (`scheduled_action_worker.py:37-44`).
8. `THIRD_PARTY_CONTACT` → workflow `COMPLETED`, no retry scheduled (SPEC §14.2 says "optionally schedule retry"; PRD says retry).
9. `list_conversations` unpaginated, hard limit 50.
10. Cosmetic: mixed `HTTP_422_UNPROCESSABLE_CONTENT` / `_ENTITY`; `seed.py` seeds a `PROMISE_TO_PAY` conversation with `protected_context_unlocked=False`; odd backslash-continuation style in `seed.py`.

Nothing here is hard to fix; items 1–3 are inherent to a keyword stub and vanish once an LLM owns the turn and tools carry validated args.

---

## 6. The interview read

Per prior research on what lands with Feather's team (LiveKit depth, FDCPA/TCPA as constraints, barge-in architecture, event sourcing, state-machine+LLM hybrid, latency arithmetic, production telephony):

| Signal | Today |
|---|---|
| Event sourcing for calls | **Strong** — real, replayable, tested |
| State machine + tool gating | **Strong** on the enforcer side; **hollow** on the LLM side |
| Compliance as engineering | **Strong** on pre-call/overrides; **broken** at right-party gating |
| LiveKit Agents depth | **Medium** — correct session config, adapter pattern, dispatch; but `llm=None` and no telephony |
| Barge-in / latency arithmetic | **None to show** — nothing generates audio from a model |
| Production telephony | **None** |
| Observability | **Weak** |

The first two questions in the loop will be "show me a call" and "how does the LLM interact with your state machine". Neither has an answer yet. Everything else is already above the bar.

---

## 7. Strategic assessment

**Premise:** correct. "Platform primitives, not a chatbot" is the right pitch for a 6-person team running 3M+ calls. Do not reframe.

**What went wrong:** SPEC §3.2 ordered "deterministic control plane first" — right — but the SPEC then marked the LLM/voice phases Complete based on adapters and signal handlers rather than a working model and a completed call. The Python code is now effectively an executable spec of the control plane.

**Language / runtime — recommendation:**

- **Go: no.** There is no LiveKit *Agents* framework in Go (only room/server SDKs). The voice worker must be Python or Node. A Go control plane + Node voice worker means two runtimes and two DB clients for a demo, and Feather's posting says Python/TS. Use Go only if you have a separate reason to signal it.
- **TypeScript + Effect: yes, if time allows.** `@livekit/agents` (Node) is 1.x-mature: `voice.Agent` subclasses with `onEnter`, `llm.tool()` with zod schemas, `llm.handoff()` between agents, `AgentSession` with the same VAD/turn-detector/inference-gateway options as Python. **`llm.handoff` between per-state `voice.Agent` subclasses is literally the PRD's state machine** — state-scoped tools become the tools object on each Agent; the adjacency map becomes "which handoffs each Agent may return". Effect adds what the PRD promises but Python can't express cleanly: typed error channel (the Error & Rescue registry becomes types), `Layer` for swapping LLM/telephony/clock in scenario tests, `Schedule` for retries, `Schema` for `TurnDecision`, `@effect/sql-pg`. Illegal states become unrepresentable. Cost: port ~5.7k LOC (design already done), Effect ramp-up.
- **Python: keep, if the interview is close.** Adding a real LLM (LiveKit `openai` plugin or structured-output call inside the orchestrator), Langfuse, one SIP outbound call, and a no-input timer is 1–2 focused days on the existing code.

**Cloudflare (free tier) — what fits (verified against Cloudflare docs, Aug 2026):**
- **Fits:** control-plane API on Workers (Hono or Effect `HttpApi`); **Durable Objects** (free plan, SQLite storage) — one DO per conversation is a single-writer state machine + event log where `sequence_no` monotonicity is trivial (no `FOR UPDATE`); **Queues** (free since Feb 2026, 10k ops/day) for the outbox; **Workflows** (free plan) for scheduled actions — durable `sleepUntil(due_at)` then dial; Cron Triggers; Pages for the operator console; **Hyperdrive** → Neon/Supabase Postgres if analytics need SQL across conversations.
- **Does not fit:** the LiveKit agent worker. It is a long-lived Node process holding a WebSocket to LiveKit, running silero VAD (ONNX) and seconds of CPU per turn; Workers' CPU-time/runtime limits exclude it and Cloudflare Containers require the paid plan. Run it on your laptop for the demo (LiveKit Cloud dispatch works from anywhere) or on a Fly.io/Railway free-ish box.
- **Telephony:** LiveKit Cloud SIP + a Twilio trial number for one outbound PSTN call; browser WebRTC as the always-available fallback.

Sketch (option C below):
```
Borrower phone ─SIP─► LiveKit Cloud ◄─WebRTC─ browser
                          │ dispatch
                          ▼
              Voice worker (Node, @livekit/agents; laptop or Fly)
                          │ Effect HttpClient
                          ▼
   Cloudflare Worker (Effect HttpApi) ──► Durable Object per Conversation
                          │                 (state machine + event log)
                          ├──► Queues  ── outbox worker (summary/eval)
                          ├──► Workflows ─ scheduled actions (sleepUntil → dial)
                          └──► Hyperdrive → Postgres (borrowers/loans/attempts/analytics)
   Cloudflare Pages ── operator console
```
Open tension to decide: DO-SQLite *or* Postgres as the event store, not both.

---

## 8. Options for the next phase

| | A. Finish in Python | B. Port to TS + Effect (Node monolith) | C. TS + Effect + Cloudflare-native control plane |
|---|---|---|---|
| Effort | **S–M** (1–2 days) | **M–L** (3–5 days) | **L** (5–8 days) |
| Risk | Low | Medium (Effect ramp, LiveKit JS surface) | High (more moving parts before a demo exists) |
| Reuses | Everything | The design, schema, scenarios, prompts | Same, plus DO/Workflows patterns |
| Story it tells | "I finish what I plan"; LiveKit Python depth | Modern TS, typed effects, per-state agents via `handoff` | Everything in B + edge-native durable execution |
| What it doesn't tell | Nothing new about TS/Effect | Cloudflare | — |

**Recommendation:** decide by interview date.
- **< 7 days:** A now. Then, if you want the TS story, start B on a branch as "v2" and talk about the migration in the interview.
- **≥ 2 weeks:** B, with C's Durable-Object-per-conversation as a bounded stretch after B demos end-to-end. Do not attempt C first.
- **Either way, not Go.**

---

## 9. Do today regardless of path

1. `git add` + commit the current tree with a README stating honestly: *control plane complete; LLM, telephony, tracing pending*.
2. Correct `SPEC.md §19` statuses per §4 above.
3. Add `docker-compose.yml` (Postgres) and a pytest fixture that runs the 12 scenarios against it, so "green" is reproducible.
4. Fix defect #1 in the stub or — better — replace the stub with the LLM.

---

## 10. Questions to settle before planning

1. **When is the interview** (or the loop's next stage)? This alone picks A vs B.
2. Has any real voice call happened via LiveKit (playground/browser)? Recording or transcript?
3. Is TS+Effect a signal you want Feather to see, or personal preference for the long term? Both valid; changes the weighting.
4. Cloudflare: is the goal a live URL they can click, or is local demo + screen-share fine?
5. Twilio number / LiveKit Cloud project tier available for one PSTN call?
6. Budget for OpenAI + LiveKit Inference minutes for the demo (~$5–20)?

**Unverified by this review:** the 12 scenarios were not executed (no Postgres/Docker/Podman available on this machine); 5 were traced statically and are consistent with the stub. Nothing was changed in `backend/`.

Sources for Cloudflare free-tier facts: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [Queues on Free plan (Feb 2026)](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/) · [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) · [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
