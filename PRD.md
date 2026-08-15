# Feather‑Lite Collections Voice Agent – Product Requirements Document (PRD)

## 1. Overview

Feather‑Lite is a narrow, production‑flavored prototype of a voice AI agent for loan collections and payment reminders, inspired by platforms like Feather that run human‑like AI phone agents for lending and financial services. The goal is to demonstrate a minimal but realistic voice runtime built around explicit platform primitives — **agent version, workflow execution, call attempt, conversation state, call control, and observability** — not just a demo chat bot.[^1][^2][^3][^4][^5][^6]

---

## 2. Goals and Non‑Goals

### 2.1 Goals

- Demonstrate a clean agent runtime that models conversations as stateful workflows with explicit outcomes (e.g., promise‑to‑pay, callback scheduled, wrong number, escalation).[^3][^5]
- Model the system using production‑shaped backend primitives: **workflow execution**, **call attempt**, **contact point**, and **durable event logging**, so the design looks like a real platform rather than a single-call demo.
- Showcase a realistic collections use case (loan payment reminders / overdue accounts) aligned with Feather's domain in lending and borrower conversations.[^2][^4]
- Exercise an event‑driven architecture: calls and agent actions generate events that drive the workflow asynchronously (e.g., transcription ready, tool result, call ended).[^7][^1]
- Integrate basic telephony and voice (via LiveKit + STT/TTS) to prove real‑time or near‑real‑time operation for at least one inbound or outbound call path.[^8][^9]
- Provide minimal analytics/QA: list of calls, final outcomes, and per‑call transcript plus event timeline.[^10][^1]

### 2.2 Non‑Goals

- Comprehensive telephony feature set (campaign management, predictive dialers, SIP trunk management, advanced compliance logic) is out of scope.[^11][^3]
- Full production readiness (geo‑redundancy, full observability stack, multi‑tenant auth, billing) is out of scope; only basic reliability (timeouts, retries, idempotent writes) is required.[^5][^1]
- Complex NLP components such as topic classification, advanced sentiment analysis, or full compliance rule engines are not required; logic can be driven mostly through LLM prompts and simple rules.[^1][^11]
- A full compliance rule engine is out of scope, but the prototype implements **minimum viable compliance constraints** (Mini‑Miranda disclosure, recording disclosure, TCPA time windows, contact frequency limits, hardship/distress triggers, right‑party gating) as engineering guardrails to demonstrate domain awareness. This is not a legal product.[^3][^1]
- The MVP is intentionally **not** a complete clone of Feather's platform surface. Advanced features such as squads, broad workflow builders, or large‑scale knowledge/RAG systems are treated as adjacent concepts and only lightly mirrored where they strengthen the interview demo.

---

## 3. Target Users and Use Cases

### 3.1 Primary User Personas

- **Collections Operations Manager** – wants a system that can automatically remind borrowers, capture promises‑to‑pay, and reduce manual calling load while ensuring escalations for complex cases.[^5][^1]
- **Customer Support/Agent Lead** – needs clear transcripts and outcomes for calls, plus visibility into which calls were escalated to human agents.[^10][^1]
- **Engineering/Platform Owner** – evaluates the architecture, extensibility, and ability to integrate with existing CRMs and dialers.[^12][^1]

### 3.2 Core Use Cases

- **Payment Reminder / Overdue Call**  
  - System calls a borrower (or answers an inbound call) about an overdue loan installment.  
  - Agent verifies identity (borrower confirms name; verification is simulated for demo purposes — see Section 5.2.2).[^3][^5]
  - Agent communicates amount due and due date, answers simple questions, and asks whether borrower can pay now, will pay by date X, or needs a callback.  
  - Agent logs promise‑to‑pay, schedules a callback, or escalates to human based on responses.[^11][^3]

- **Callback Scheduling / Follow‑up**  
  - Agent offers to schedule a later time for a call when borrower is busy.[^1][^3]
  - Agent writes callback time into a CRM table and ends the call.

- **Wrong Number / Third‑Party / Opt‑Out Handling**
  - If the callee indicates wrong number, agent logs `WRONG_NUMBER` outcome and marks the contact point as invalid.
  - If a third party answers (e.g., spouse, roommate — not the borrower), agent logs `THIRD_PARTY_CONTACT` outcome. The contact point remains valid (the borrower may answer next time), but the agent must not disclose debt details to the third party. A retry may be scheduled at a different time.
  - If borrower requests no further calls, agent logs `OPT_OUT` outcome and writes a suppression flag against the borrower/contact point.[^1][^3]
  - These are recorded as three distinct outcomes because they have different downstream effects: `WRONG_NUMBER` invalidates the contact point, `THIRD_PARTY_CONTACT` preserves it but logs the third-party reach, and `OPT_OUT` creates a durable suppression record.

---

## 4. Success Metrics

For the prototype, success is demonstration‑oriented rather than production KPIs:

- Ability to complete at least **five test calls end‑to‑end** (at least two via voice, at least two via the JSON simulation endpoint) with correct state transitions and DB writes for outcomes.[^1]
- At least **ten distinct final outcomes** correctly recorded: `PROMISE_TO_PAY`, `CALLBACK_SCHEDULED`, `WRONG_NUMBER`, `OPT_OUT`, `ESCALATED`, `DISPUTED`, `VOICEMAIL_LEFT`, `THIRD_PARTY_CONTACT`, `NO_ANSWER`, `FAILED`.
- Analytics page listing calls with final outcome, call duration, and link to assembled transcript.
- Demonstration of **interruption handling (barge-in)** (caller speaking over the agent, triggering VAD to halt TTS/LLM) in at least one interaction path.[^6][^10]

---

## 5. Functional Requirements

### 5.1 High‑Level Flow

1. **Pre‑call validation & call initiation**
   - For outbound calls, `POST /api/calls/start` runs the pre‑call validation pipeline (TCPA time window, 7‑in‑7 frequency, contact point consent/validity, borrower opt‑out, active call, scheduled‑action conflicts — see Section 5.2.8). On pass, the backend **synchronously creates** a `workflow_execution`, `call_attempt`, and initial `conversations` row before dialing.[^9][^13][^8]
   - For inbound calls, the system receives the call via SIP trunk routed to LiveKit.
   - Each call attempt is associated with a `conversation_id` and a specific `contact_point_id`. The system loads only **public context** at call start (agent name, company, phone metadata, workflow policy), while **protected borrower/loan context** remains gated until right‑party verification succeeds.[^3][^1]

2. **Agent session creation (In-Memory Hot Path)**
   - The LiveKit Agents Framework creates an `AgentSession` with the configured STT/LLM/TTS/VAD pipeline. The custom `Agent` subclass initializes `session.userdata` with an **in-memory** state dataclass holding `workflow_execution_id`, `call_attempt_id`, `conversation_id`, `contact_point_id`, current `state`, public context, and a protected-context placeholder (ensuring sub‑500ms latency). Durable rows already exist before media starts.

3. **Mandatory disclosures & AMD check**
   - The `Agent.on_enter()` hook delivers Mini‑Miranda and recording disclosures as non‑interruptible segments (`allow_interruptions=False`).
   - AMD check: if a voicemail system is detected, agent transitions to `VOICEMAIL` state, leaves a scripted message (no debt details), and ends the call.

4. **Streaming loop / turn handling**
   - Audio from caller is streamed via LiveKit → SileroVAD → Deepgram STT (streaming) → semantic turn detection (`MultilingualModel`).
   - Hard‑coded override rules are evaluated against the transcript BEFORE the LLM (opt‑out, wrong number, hardship, dispute).
   - **The state machine determines which transitions are valid and what tools are callable at this point; the LLM decides what to say and whether to invoke a tool within those boundaries** (see Section 5.2.3).[^5][^3]
   - LLM response tokens are streamed through sentence‑level `FlushSentinel` chunking → ElevenLabs TTS → audio back to borrower.

5. **Tooling / side effects**
   - Based on state and user intent, agent can call state‑scoped `@function_tool` methods:
     - `lookup_contact_profile(contact_point_id)`
     - `get_account_context(borrower_id)` — only after right‑party verification
     - `record_promise_to_pay(borrower_id, date, amount, notes)` — requires verbal confirmation readback
     - `schedule_callback(borrower_id, datetime)`
     - `record_opt_out(subject_id, scope, reason)`
     - `record_wrong_party_contact(contact_point_id, notes)`
   - **Call-control actions are NOT LLM business tools.** AMD, voicemail drop, hold, warm transfer, and hangup are orchestrator/telephony actions invoked by the runtime, not free-form tool calls.
   - Conversation analytics writes can be asynchronous, but outcome‑committing writes (`CALL_STARTED`, `STATE_TRANSITION`, final outcome, callback schedule, promise-to-pay) must be durably committed before the agent tells the borrower the action succeeded.

6. **Conversation completion**
   - When outcome is finalized, session `state` becomes `COMPLETED` or `ESCALATED`, `current_outcome` is set, and call is ended gracefully.[^5][^3]
   - In-memory `session.userdata` state is finalized and flushed to Postgres; any non-critical enrichment jobs (summary generation, embeddings, QA scoring) run after call completion via background workers.

7. **Analytics & QA (Transcripts)**
   - A simple admin view lists all calls with final outcome, duration, and a reconstructed transcript assembled sequentially from `USER_TURN_FINAL` and `AGENT_TURN` events in chronological order (see Section 5.2.6).[^10][^1]

---

### 5.2 Detailed Functional Requirements

#### 5.2.1 Telephony & Voice (LiveKit Agents Framework)

The voice pipeline is built on the **LiveKit Agents Framework** (`livekit-agents`), which provides `AgentSession`, the `Agent` base class, SileroVAD, speech queue management, barge‑in handling, and semantic turn detection out of the box. The prototype builds ON the framework — not alongside it.

- **Agent Implementation:** The collections agent is a subclass of `livekit.agents.Agent` with state‑specific `instructions`, `@function_tool`‑decorated methods for CRM operations, and `on_enter`/`on_exit` lifecycle hooks for state transitions and non‑interruptible disclosures.
- **Session Configuration:**
  ```python
  session = AgentSession(
      stt=deepgram.STT(model="nova-3", language="en"),
      llm=openai.LLM(model="gpt-4o"),
      tts=elevenlabs.TTS(voice_id="..."),
      vad=silero.VAD.load(),
      turn_detection=MultilingualModel(),   # semantic turn detection
      allow_interruptions=True,
      min_endpointing_delay=0.5,            # minimum wait after speech stops
      max_endpointing_delay=3.0,            # borrowers pause to think about amounts/dates
      false_interruption_timeout=2.0,       # resume if interruption was noise
      resume_false_interruption=True,
      min_interruption_duration=0.5,        # ignore sub-500ms sounds
  )
  ```

- **Telephony — Outbound Calls:** System initiates outbound PSTN calls via `ctx.api.sip.create_sip_participant()` with `wait_until_answered=True`, bridging the borrower into a LiveKit room where the AI agent is a participant.[^14][^8][^9]
- **Telephony — Inbound Calls:** Inbound PSTN calls are routed to LiveKit via SIP trunk and joined by the AI agent participant.
- **Plan B Telephony Fallback (Twilio Media Streams):** If SIP/LiveKit routing becomes problematic, bypass WebRTC entirely using Twilio Media Streams. Architecture: dual‑WebSocket bridge — Twilio Media Streams WebSocket sends raw mulaw audio to FastAPI backend, which maintains a separate WebSocket to OpenAI Realtime API. Audio flows bidirectionally through FastAPI. Barge‑in on this path: OpenAI sends `input_audio_buffer.speech_started` → backend sends `clear` to Twilio media buffer + `response.cancel` to OpenAI. Trade‑offs: simpler setup, but no semantic turn detection, less voice quality control, higher OpenAI Realtime API costs.
- Audio MUST be processed in small chunks to allow near real‑time back‑and‑forth (latency target < 2 seconds from user speech to agent response for the demo).

##### Interruption Architecture (Barge-in)

System MUST explicitly handle interruptions.[^9][^10] The LiveKit Agents framework handles this internally via `AgentSession`'s speech queue. When the VAD detects user speech during agent playback:
  1. The current `SpeechHandle` is cancelled — TTS playback stops immediately, in‑flight LLM generation is cancelled via cancellation token propagation.
  2. The partial TTS output (what the user actually heard before interruption) is appended to the LLM context as a truncated assistant message, preserving conversational coherence.
  3. The new user utterance is processed from the beginning through the full pipeline.

**Adaptive Interruption Detection:** The framework's `AdaptiveInterruptionDetector` distinguishes true barge‑ins from backchanneling ("uh‑huh," "okay," "mm‑hmm") using `min_interruption_words` threshold. Backchannels do NOT trigger speech cancellation.

**AEC Warmup Protection:** For the first ~3 seconds of a call, echo cancellation is calibrating — the agent's own audio can cause false VAD triggers. This is naturally handled by the non‑interruptible Mini‑Miranda disclosure at call start (see Section 5.2.8).

##### Non‑Interruptible Segments

Certain agent utterances are legally mandated and MUST complete without interruption:

- **Mini‑Miranda disclosure** (FDCPA): "This is an attempt to collect a debt. Any information obtained will be used for that purpose." Delivered via `session.generate_reply(instructions="...", allow_interruptions=False)`.
- **Call recording disclosure**: "This call may be recorded for quality and training purposes." Delivered via `session.say("...", allow_interruptions=False)`.
- **Verbal confirmation readbacks**: When reading back a promise‑to‑pay date/amount for borrower confirmation.

During non‑interruptible playback, VAD continues to detect speech but does NOT trigger TTS stop or LLM cancellation. User audio is buffered and processed after the segment completes.

##### Turn Detection & Endpointing

- **Semantic Turn Detection:** Use LiveKit's `MultilingualModel()` — a transformer model that evaluates conversation context + VAD + STT to determine if the user has genuinely finished speaking vs. pausing mid‑thought. This is critical for collections: borrowers frequently pause to think about payment dates and amounts.
- **Endpointing Delays:** `min_endpointing_delay=0.5s` (minimum wait after speech stops) and `max_endpointing_delay=3.0s` (maximum wait for thinking borrowers). These are tuned for PSTN collections, not consumer chat.
- **False Interruption Recovery:** `false_interruption_timeout=2.0s` with `resume_false_interruption=True` — if a detected "interruption" turns out to be noise (no actual speech follows), the agent resumes its previous response automatically.
- **Silence / No‑Input Handling:** If no speech is detected for X seconds, the system generates an internal `NO_INPUT` event. The first `NO_INPUT` triggers a scripted "Are you still there?" via `session.say()` (bypasses LLM for speed). A second consecutive `NO_INPUT` triggers "We'll try reaching you again later. Goodbye." and ends the call.

#### 5.2.2 Agent State Machine

Define an explicit state machine for collections calls:

```text
GREETING
├──> VOICEMAIL ───────────────────────> ENDING (VOICEMAIL_LEFT)
└──> VERIFYING_IDENTITY
     ├──> THIRD_PARTY_OR_WRONG_PARTY ─> ENDING (THIRD_PARTY_CONTACT)
     └──> DISCUSSING_PAYMENT
          ├──> CONFIRMING_OUTCOME ────> ENDING (PROMISE_TO_PAY or CALLBACK_SCHEDULED)
          ├──> WARM_TRANSFER_PENDING ─> ENDING (ESCALATED)
          ├──> WRONG_NUMBER ───────────> ENDING
          └──> OPT_OUT ────────────────> ENDING
(from any state — hard-coded override rules, evaluated BEFORE LLM)
├──> OPT_OUT ────────────────────> ENDING
├──> WRONG_NUMBER ───────────────> ENDING
├──> ESCALATED (hardship/distress) ──> ENDING
└──> ESCALATED (debt disputed) ──> ENDING (DISPUTED)
```

- **Answering Machine Detection (AMD):** 40–60% of outbound calls hit voicemail. AMD is treated as a telephony/runtime signal, not an LLM tool call. When telephony reports a machine, the orchestrator transitions to `VOICEMAIL` state and delivers a brief, FDCPA‑compliant voicemail (cannot disclose debt details — third parties may hear the message). Final outcome: `VOICEMAIL_LEFT`. If the call is not answered at all, outcome is `NO_ANSWER`.
- State transitions MUST be persisted per turn in `conversation_events`, enabling full replay and debugging.
- Each state has:
  - **Entry logic**: which prompt template fragment to use, and whether only public context or full protected account context may be injected (e.g., loan balance only in `DISCUSSING_PAYMENT`). The `on_enter` lifecycle hook of the `Agent` subclass handles this.
  - **Exit conditions**: what must be true before transition (e.g., `right_party_verified=true` before moving from `VERIFYING_IDENTITY`).
  - **Valid tools**: only tools relevant to the current state are exposed to the LLM via `@function_tool` decorators, dynamically filtered per state (e.g., `record_promise_to_pay` is only callable in `CONFIRMING_OUTCOME`).
  - **LLM model**: per‑state model selection for latency/cost optimization (see below).

##### Hard‑Coded Override Rules

These override rules execute **before** the LLM processes the user's speech. They are pattern‑matched against the transcribed text and trigger immediate state transitions regardless of LLM output:

| Trigger Category | Example Phrases | Target State | Final Outcome |
|---|---|---|---|
| **Opt‑out** | "stop calling me," "don't call again," "remove my number" | `OPT_OUT` | `OPT_OUT` |
| **Wrong number** | "wrong number," "I'm not [name]," "no one by that name here" | `WRONG_NUMBER` | `WRONG_NUMBER` |
| **Hardship / distress** | "I lost my job," "can't afford it," "going through bankruptcy," "talk to my lawyer" | `ESCALATED` | `ESCALATED` |
| **Debt dispute** | "I don't owe this," "this isn't my debt," "I dispute this," "prove I owe this" | `ESCALATED` | `DISPUTED` |

Hardship and dispute overrides are not optional LLM judgment calls — continuing to pressure a borrower after hardship expression is a UDAAP (Unfair, Deceptive, or Abusive Acts or Practices) risk. In the prototype they immediately route to safe handling: warm transfer if a human is available, otherwise a callback/escalation queue.

##### Semantic Override Safety Net (Optional Stretch)

Keyword matching has a known compliance gap: borrowers do not always use exact phrases. For the interview MVP, deterministic keyword/rule matching is the primary mechanism. A semantic similarity layer using **pgvector** is treated as an optional stretch feature that can be added after the core workflow runtime is stable.

If implemented, the semantic check should run **in parallel** with the LLM on each `USER_TURN_FINAL`, and only for the high-risk classes `OPT_OUT`, `HARDSHIP`, and `DISPUTE`. It is a safety net on top of keywords, not a dependency for the core demo.

##### Per‑State LLM Model Selection

Different states have different complexity requirements. Using a lighter model for scripted/simple states reduces latency and cost significantly at scale:

| State | Model | Rationale |
|---|---|---|
| `GREETING` | `gpt-4o-mini` | Scripted disclosures, low complexity, latency‑sensitive |
| `VERIFYING_IDENTITY` | `gpt-4o-mini` | Short, policy-constrained right-party verification |
| `DISCUSSING_PAYMENT` | `gpt-4o` | Reasoning, negotiation, tool calling |
| `CONFIRMING_OUTCOME` | `gpt-4o` | Accuracy‑critical, tool calling for promise/callback |
| `VOICEMAIL` | `gpt-4o-mini` | Scripted voicemail message |
| `ENDING` | `gpt-4o-mini` | Scripted closing |

The `Agent` subclass switches the LLM instance on the `AgentSession` during state transitions.

> **Note on identity verification (demo):** In production, identity verification would require a policy-aware right‑party contact flow and tighter controls. In this prototype, verification is **simulated**: the agent asks for a lightweight confirmation, and only after that confirmation does the runtime inject protected account context. This is explicitly acknowledged as a demo simplification.

#### 5.2.3 State Machine vs. LLM — Reconciliation

These two paradigms coexist with clear separation of concerns:

- **State machine is the enforcer.** It dictates:
  - Which state the agent is currently in.
  - Which transitions are valid (e.g., cannot jump from `GREETING` to `CONFIRMING_OUTCOME`).
  - Which tools the LLM is allowed to call at this point (State-Scoped Tooling via `@function_tool` decorators, dynamically filtered per state).
  - Which LLM model is used for this state (per‑state model selection — see Section 5.2.2).
  - Hard‑coded overrides: evaluated BEFORE LLM — opt‑out, wrong number, hardship/distress, and debt dispute phrases trigger immediate state transitions regardless of LLM output (see Section 5.2.2 override rules table).

- **LLM is the conversationalist.** Within the current state's boundaries, the LLM decides:
  - What to say next (natural language generation).
  - Whether to call a permitted tool and with what arguments.
  - Whether the exit condition for the current state has been satisfied (returned as a structured field in LLM output, e.g., `{ "intent_satisfied": true, "suggested_next_state": "DISCUSSING_PAYMENT" }`).

- **Implementation pattern (LiveKit Agents Framework):** The collections agent is a subclass of `livekit.agents.Agent`. Each turn:
  1. Hard‑coded override rules are evaluated against the transcribed text (via `@session.on("user_input_transcribed")` handler). If matched, state transitions immediately — LLM is bypassed.
  2. The `Agent` subclass updates `self.instructions` with the current state's system prompt fragment and injects context (borrower info, loan balance, prior interaction summary).
  3. Only `@function_tool` methods valid for the current state are exposed to the LLM.
  4. The LLM responds with structured output (`{ "message": "...", "tool_call": {...} | null, "intent_satisfied": bool, "suggested_next_state": "..." }`). The orchestrator validates the suggested transition against the state machine's adjacency map before applying it.

##### Cross‑Call Memory (Deterministic First, Retrieval Optional)

Before building prompts, the orchestrator retrieves prior interaction context for this `borrower_id`, but the data is split into two layers:

1. **Public call policy context** available before verification:
   - workflow type
   - local time / allowed contact window
   - number identity / brand
   - whether this is a retry, callback, or escalation follow-up

2. **Protected borrower/account context** available only after right-party verification:
   - due amount, due date, delinquency bucket
   - prior promise-to-pay outcome
   - prior callback commitments
   - last successful right-party contact date

For the MVP, cross-call memory should be **deterministic and structured first**:
- Query the last 3–5 relevant conversations directly from Postgres.
- Extract compact structured facts from `final_outcome` and `final_outcome_metadata`.
- Build a small machine-readable memory block for the prompt rather than injecting long natural-language summaries.

Example protected memory block:

```json
{
  "last_promise_to_pay_date": "2026-03-15",
  "last_promise_amount": 500,
  "last_callback_requested_at": "2026-03-18T14:00:00Z",
  "recent_outcomes": ["NO_ANSWER", "CALLBACK_SCHEDULED", "PROMISE_TO_PAY"]
}
```

Vector retrieval over summarized conversations is a valid future enhancement once the deterministic workflow runtime is working, but it is not required for the interview MVP.

#### 5.2.4 JSON Simulation Endpoint (Demo Fallback)

- `POST /api/conversations/{id}/simulate_turn`
  - Body: `{ "user_text": "I can pay on Friday" }`
  - Response: `{ "agent_text": "...", "new_state": "...", "tool_called": {...} | null, "outcome": null | "PROMISE_TO_PAY" | ... }`
- This endpoint drives the full agent runtime (state machine + LLM + tools + DB writes) identically to the voice path, but bypasses STT/TTS and telephony.
- MUST be built and kept working from Day 1 through the final demo.

#### 5.2.5 Tools and Data Model

The original single-table borrower/phone model is too simplistic for collections. The MVP should separate **person/account**, **contact point**, and **attempt execution**.

**`borrowers` table**

| Column             | Type         | Notes                           |
|--------------------|-------------|----------------------------------|
| id                 | UUID        | Primary key                      |
| name               | TEXT        | Full name                        |
| preferred_language | TEXT        | e.g., "en", "hi"                 |
| timezone           | TEXT        | Canonical borrower timezone for policy checks |
| status             | TEXT        | e.g., ACTIVE, OPT_OUT, DECEASED  |
| created_at         | TIMESTAMPTZ |                                  |
| updated_at         | TIMESTAMPTZ |                                  |

**`contact_points` table**

| Column             | Type         | Notes                           |
|--------------------|-------------|----------------------------------|
| id                 | UUID        | Primary key                      |
| type               | TEXT        | `PHONE` for MVP                  |
| value              | TEXT        | E.164 phone number               |
| is_valid           | BOOLEAN     | false if wrong/reassigned number |
| consent_status     | TEXT        | ALLOWED, OPTED_OUT, UNKNOWN      |
| timezone_override  | TEXT        | Nullable if number-level timezone differs |
| created_at         | TIMESTAMPTZ |                                  |
| updated_at         | TIMESTAMPTZ |                                  |

**`borrower_contact_points` table**

| Column           | Type | Notes |
|------------------|------|-------|
| borrower_id      | UUID | FK → borrowers |
| contact_point_id | UUID | FK → contact_points |
| priority         | INT  | Lower = call first |
| relationship     | TEXT | PRIMARY, CO_BORROWER, OTHER |

**`loans` table**

| Column            | Type     | Notes                |
|-------------------|----------|----------------------|
| id                | UUID     | Primary key          |
| borrower_id       | UUID     | FK → borrowers       |
| principal         | NUMERIC  |                      |
| balance_due       | NUMERIC  |                      |
| due_date          | DATE     |                      |
| status            | TEXT     | CURRENT, DELINQUENT  |
| delinquency_days  | INT      | Derived or persisted |
| last_promise_date | DATE     | Nullable             |

**`agent_versions` table**

| Column      | Type         | Notes |
|-------------|--------------|-------|
| id          | UUID         | Primary key |
| name        | TEXT         | e.g., `collections-v1` |
| prompt_hash | TEXT         | Tracks deployed prompt/config |
| status      | TEXT         | DRAFT, ACTIVE, RETIRED |
| created_at  | TIMESTAMPTZ  | |

**`workflow_executions` table**

| Column               | Type         | Notes |
|----------------------|--------------|-------|
| id                   | UUID         | Primary key |
| borrower_id          | UUID         | FK → borrowers |
| loan_id              | UUID         | FK → loans |
| workflow_type        | TEXT         | PAYMENT_REMINDER, CALLBACK_FOLLOWUP, ESCALATION_FOLLOWUP |
| status               | TEXT         | PENDING, RUNNING, COMPLETED, FAILED |
| current_attempt_no   | INT          | Incremented per dial attempt |
| scheduled_for        | TIMESTAMPTZ  | Next planned action |
| created_at           | TIMESTAMPTZ  | |
| updated_at           | TIMESTAMPTZ  | |

**`call_attempts` table**

| Column               | Type         | Notes |
|----------------------|--------------|-------|
| id                   | UUID         | Primary key |
| workflow_execution_id| UUID         | FK → workflow_executions |
| contact_point_id     | UUID         | FK → contact_points |
| direction            | TEXT         | OUTBOUND or INBOUND |
| provider_call_id     | TEXT         | LiveKit/Twilio identifier |
| attempt_status       | TEXT         | INITIATED, ANSWERED, NO_ANSWER, VOICEMAIL, COMPLETED, FAILED |
| started_at           | TIMESTAMPTZ  | |
| ended_at             | TIMESTAMPTZ  | Nullable |

**`conversations` table**

| Column                 | Type          | Notes                           |
|------------------------|--------------|----------------------------------|
| id                     | UUID         | Primary key                      |
| call_attempt_id        | UUID         | FK → call_attempts               |
| borrower_id            | UUID         | FK → borrowers                   |
| agent_version_id       | UUID         | FK → agent_versions              |
| started_at             | TIMESTAMPTZ  |                                  |
| ended_at               | TIMESTAMPTZ  | Nullable                         |
| final_outcome          | TEXT         | Nullable until complete          |
| final_outcome_metadata | JSONB        | e.g., `{ "promised_amount": 500, "promised_date": "2026-03-15" }` |
| channel                | TEXT         | "voice" or "simulated"           |
| transfer_target        | TEXT         | Nullable; queue or human target  |
| protected_context_unlocked | BOOLEAN  | Whether right-party verification succeeded |

**`conversation_events` table**

| Column            | Type          | Notes                    |
|-------------------|--------------|---------------------------|
| id                | UUID         | Primary key               |
| conversation_id   | UUID         | FK → conversations        |
| sequence_no       | BIGINT       | Monotonic per conversation |
| type              | TEXT         | See event types below     |
| payload           | JSONB        | Turn-specific data        |
| created_at        | TIMESTAMPTZ  |                           |

**Event types:** `CALL_STARTED`, `CALL_CONTROL`, `AMD_RESULT`, `NO_INPUT`, `USER_TURN`, `USER_TURN_FINAL`, `AGENT_TURN`, `TOOL_CALLED`, `TOOL_RESULT`, `STATE_TRANSITION`, `TRANSFER_REQUESTED`, `TRANSFER_COMPLETED`, `CALL_ENDED`.

- `AMD_RESULT` payload: `{ "result": "HUMAN" | "MACHINE" | "NO_ANSWER" }`
- `CALL_CONTROL` payload: `{ "action": "HANGUP" | "VOICEMAIL_DROP" | "HOLD" | "WARM_TRANSFER", ... }`

**`scheduled_actions` table**

| Column               | Type         | Notes |
|----------------------|--------------|-------|
| id                   | UUID         | Primary key |
| workflow_execution_id| UUID         | FK → workflow_executions |
| action_type          | TEXT         | CALLBACK, RETRY_CALL, HUMAN_FOLLOWUP |
| due_at               | TIMESTAMPTZ  | |
| status               | TEXT         | PENDING, CLAIMED, DONE, CANCELED |
| payload              | JSONB        | |

**Optional stretch tables**

- `override_phrase_embeddings(category, phrase, embedding)` for semantic override detection
- `conversation_summaries(conversation_id, summary_text, summary_embedding)` for retrieval/QA

These stay out of the critical path for the MVP. The primary system design should stand without them.

#### 5.2.6 Transcript Reconstruction

- Transcripts are NOT stored as a single blob. They are assembled on read from `conversation_events`.
- The analytics API queries all finalized `USER_TURN_FINAL` (when VAD detects speech stopped) and completed/interrupted `AGENT_TURN` events for a given `conversation_id`, orders them by `created_at`, and maps them to `{ speaker: "AGENT" | "BORROWER", text: "...", timestamp: "..." }` objects to represent the exact "ground truth" of the conversation.
- The UI renders this list as a chat‑style transcript with speaker labels.
- `STATE_TRANSITION` events are interleaved in the event timeline view (not the transcript view) to show the agent's workflow progression alongside the conversation.

#### 5.2.7 Admin & QA Interface

- Provide a simple web UI (or API + API docs) for:
  - List of recent conversations: `conversation_id`, `borrower_name`, `started_at`, `ended_at`, `final_outcome`, `duration`, `channel`.
  - Conversation detail view:
    - Reconstructed transcript (from `USER_TURN_FINAL` + `AGENT_TURN` events — see 5.2.6).
    - Full event timeline (all event types in order) for debugging.
  - **Scenario test runner / testing lab:** a lightweight harness that replays scripted borrower turns and asserts expected states, outcomes, and tool invocations. This is a better MVP investment than a broad semantic search surface.
    - Example scenarios: voicemail, right-party confirmation, wrong-party contact, opt-out, hardship escalation, dispute escalation, callback scheduling
    - For each scenario store: input turns, expected final outcome, expected state path, expected tools/call-control actions
  - Optional stretch: semantic search across conversations via pgvector after the deterministic test harness is complete.

#### 5.2.8 Compliance‑as‑Engineering Constraints

In collections voice AI, certain regulatory requirements are not optional compliance features — they are **hard engineering constraints** that dictate how the system must behave. The following are implemented as architectural guardrails, not afterthoughts:

##### Pre‑Call Validation Pipeline

Before any outbound call is placed, the `POST /api/calls/start` endpoint runs a synchronous validation pipeline. ALL checks must pass before dialing:

| Check | Implementation | On Failure |
|---|---|---|
| **Borrower opt‑out status** | `borrowers.status != 'OPT_OUT'` | Reject 422 |
| **Contact point consent / validity** | `contact_points.consent_status != 'OPTED_OUT' AND contact_points.is_valid = TRUE` | Reject 422 |
| **TCPA time window** | Current time in borrower/contact timezone is between 8:00 AM – 9:00 PM | Reject 422 |
| **7‑in‑7 frequency cap (CFPB Reg F)** | count recent **call attempts** for this borrower/contact point | Reject 422 |
| **Active conversation check** | No in‑progress conversation exists for this borrower | Reject 422 |
| **Scheduled action de-dupe** | No pending callback/retry action conflicts with this outbound attempt | Reject 422 |

On any failure, return `422 Unprocessable Entity` with `{ "error": "...", "validation_failures": ["TCPA_TIME_WINDOW", ...] }`.

##### Mandatory Non‑Interruptible Disclosures

These disclosures are delivered at call start using `allow_interruptions=False` and MUST complete before the conversation proceeds (see Section 5.2.1):

1. **Mini‑Miranda (FDCPA §1692e(11)):** "This is [agent name] calling from [company]. This is an attempt to collect a debt, and any information obtained will be used for that purpose." This is delivered verbatim — the LLM does not improvise this text.
2. **Call recording disclosure:** "This call may be recorded for quality and training purposes."

These segments also serve as the AEC (Acoustic Echo Cancellation) warmup period (~3 seconds), preventing false VAD triggers from the agent's own audio at call start.

##### In‑Call Compliance Guardrails

| Guardrail | Mechanism |
|---|---|
| **Hardship / distress detection** | Hard‑coded keyword overrides trigger immediate safe handling — stop payment discussion and route to warm transfer or human follow-up queue |
| **Debt dispute detection** | Hard‑coded keyword overrides trigger `DISPUTED` outcome — acknowledge dispute and stop collection on this call |
| **Opt‑out is immediate and durable** | On opt‑out detection, update borrower/contact suppression synchronously before call completion so future outbound attempts are blocked |
| **Right‑party contact gating** | `VERIFYING_IDENTITY` state blocks protected account context, loan details, and payment tools until identity is confirmed |
| **Voicemail content restriction (FDCPA)** | Voicemail messages cannot disclose debt details (third parties may hear). The `VOICEMAIL` state prompt is restricted to: agent name, company, callback number |
| **Verbal confirmation before outcome recording** | The `record_promise_to_pay` tool requires the agent to read back date and amount and receive borrower confirmation before calling the tool |

##### Idempotency for Outcome‑Recording Tools

LLMs occasionally call the same tool twice in a single session (especially after barge‑in confuses the context). All outcome‑recording tools MUST be idempotent:
- Unique constraint on `(conversation_id, outcome_type)` or on the business key appropriate to the action
- `INSERT ... ON CONFLICT ... DO UPDATE` pattern for promise-to-pay/callback records
- All tool calls include a `tool_call_id` stored in `conversation_events` payload — duplicate `tool_call_id`s are detected and skipped
- Call-control actions (`WARM_TRANSFER`, `VOICEMAIL_DROP`, `HANGUP`) must also carry an idempotency key because telephony providers may retry webhooks/events

---

## 6. Non‑Functional Requirements

### 6.1 Performance & Latency

- Target end‑to‑end latency of under 2 seconds between borrower finishing an utterance and agent starting a response during demo scenarios.
- The core Orchestrator (LiveKit `AgentSession` + custom `Agent` subclass) must hold active conversation state **in-memory** via `session.userdata` during the call, but **durable control-plane writes** (`CALL_STARTED`, state transitions, final outcomes, scheduled callbacks, suppressions) cannot be best-effort.
- **LLM-to-TTS Streaming:** The system MUST stream LLM output tokens and dispatch them to the TTS engine in sentence-level chunks to drastically reduce Time-To-First-Byte (TTFB) audio latency. Waiting for the full LLM response before generating audio is strictly prohibited on the hot path. Implementation: override `Agent.default.llm_node()` to detect sentence boundaries in the token stream and yield `FlushSentinel` objects, which trigger immediate TTS synthesis of completed sentences while the LLM continues generating.
- **Fast Pre‑Response / Filler Pattern:** optional stretch only. It is lower priority than durable workflow state, transfer support, and deterministic test coverage.
- **Parallel Semantic Override Check:** optional stretch only. If implemented, it runs concurrently with the LLM and must never block the deterministic keyword path.
- Support at least 3 concurrent calls in a local/dev environment without degradation.

### 6.2 Reliability & Fault Handling

- Implement timeouts for STT, LLM, and TTS calls; on timeout, retry once, then escalate or gracefully end the call with an apology.
- Ensure idempotency for DB‑writing tools (see Section 5.2.8), plus idempotency keys for telephony control actions and webhook handling.
- On backend crash mid‑call, replays should be possible from durable `conversation_events` plus `call_attempts` state to reconstruct last known state.
- Use an outbox/background-worker pattern for non-critical async work (summaries, embeddings, evals) rather than `asyncio.ensure_future()` as the sole reliability mechanism.

### 6.3 Observability & Evaluation (MVP)

- **Technical Observability (LLM & Latency):** System MUST integrate an off-the-shelf tracing tool (**Langfuse** or equivalent) to wrap all LLM calls. This provides zero-effort, comprehensive dashboards for:
  - Token counting and cost estimation.
  - Step-by-step tracing of prompt injection and structured JSON outputs.
  - Granular latency breakdown (Time-To-First-Token, overall generation time) for performance debugging.
- **Business Observability:** Log key state transitions and tool calls with correlation IDs per conversation into the `conversation_events` table to power the custom React Admin Dashboard.
- **Post-Call Evaluation:** (Optional/Stretch) After `CALL_ENDED` event, a background async task reconstructs the transcript and runs an LLM‑as‑judge prompt scoring three dimensions:
  1. **Compliance** (1–5): Mini‑Miranda delivered? Recording disclosure given? No pressure after hardship expression?
  2. **Outcome quality** (1–5): Did the agent capture a concrete commitment? Was date/amount confirmed verbally?
  3. **Conversational quality** (1–5): Natural flow? Appropriate empathy? No robotic repetition?
  Scores are pushed to Langfuse as evaluation metrics, enabling aggregate quality dashboards across calls.

### 6.4 Security & Privacy (MVP)

- Do not log sensitive full DOB or full card data; use masked values in logs.
- Keep secrets (API keys) in environment variables, not in code.
- Acknowledge demo‑only nature; no real customer data.

---

## 7. System Architecture

### 7.1 High‑Level Components

- **Telephony / Media Layer (LiveKit Agents Framework OR Twilio Media Streams Fallback)**
  The LiveKit Agents Framework manages the full voice pipeline: SileroVAD, Deepgram STT (streaming), LLM inference, ElevenLabs TTS (streaming), WebRTC audio transport, and interruption handling — all within the `AgentSession` runtime. For fallback, Twilio Media Streams provides a simpler dual‑WebSocket path (see Section 5.2.1).

- **Collections Agent (`Agent` Subclass — In-Memory Hot Path)**
  A custom subclass of `livekit.agents.Agent` that IS the orchestrator. It:
  - Evaluates hard‑coded override rules first (opt‑out, wrong number, hardship, dispute) via `@session.on("user_input_transcribed")`.
  - Manages the state machine via `session.userdata` (in‑memory dataclass holding current state, public context, call attempt metadata, and whether protected context has been unlocked).
  - Exposes state‑scoped `@function_tool` methods — only tools valid for the current state are available to the LLM.
  - Updates `self.instructions` per state with the appropriate prompt fragment and context.
  - Switches the LLM model per state for latency/cost optimization.
  - Validates LLM's suggested state transition against the state machine's adjacency map.
  - Writes critical control-plane events synchronously, while offloading non-critical enrichment to background workers.
  - The same orchestration logic is reused by the JSON simulation endpoint (Section 5.2.4), just with text input/output instead of audio.

- **Workflow / Attempt Orchestrator**
  A backend module that creates `workflow_executions`, `call_attempts`, and `scheduled_actions`, applies pre-call policy validation, and owns retry/callback logic across multiple attempts.

- **Call Control Module**
  A telephony-facing module responsible for AMD, voicemail drop, hold, warm transfer, and hangup. These are not general LLM tools; they are explicit runtime operations with idempotency keys and event logging.

- **Tooling/CRM Module**
  `@function_tool`‑decorated methods on the Agent class that perform domain actions such as reading account context, recording promise-to-pay, or scheduling callback records.

- **Analytics/QA API, UI, and Test Harness**
  FastAPI HTTP endpoints to fetch conversations and reconstruct transcripts from events. Minimal frontend plus a deterministic scenario runner for regression testing.

### 7.2 Data Flow Example (Outbound Call)

```text
1. POST /api/calls/start(borrower_id, contact_point_id)
   └── Pre-call validation pipeline (TCPA time window, 7-in-7, consent/validity, active call, scheduled-action conflicts)
   └── On pass: synchronously create workflow_execution + call_attempt + conversation rows

2. ctx.api.sip.create_sip_participant(wait_until_answered=True)
   └── Borrower picks up → AI agent joins LiveKit room

3. Agent.on_enter(): deliver Mini-Miranda + recording disclosure (allow_interruptions=False)
   └── AMD check: if voicemail detected → VOICEMAIL state → leave scripted message → ENDING

4. Agent transitions to VERIFYING_IDENTITY → only public context is available in prompt

5. Borrower audio → LiveKit → SileroVAD → Deepgram STT (streaming) → user_input_transcribed

6. Override rules check: opt-out / wrong number / hardship / dispute phrases?
   └── If matched: immediate state transition, bypass LLM
   └── If not: proceed to LLM

7. If right-party confirmed:
   └── Unlock protected context and load compact structured account memory
   └── Agent builds state-scoped prompt + @function_tools → calls LLM (per-state model)

8. LLM streams tokens → FlushSentinel at sentence boundaries → ElevenLabs TTS (TTFB < 1s)

9. LLM finishes → returns { tool_call, intent_satisfied, suggested_next_state }
   └── Validate transition against state machine adjacency map
   └── Execute tool or call-control action → durably write events → advance state

10. Repeat steps 5–9 until ENDING state reached

11. final_outcome written to conversations table; next scheduled action created if needed; non-critical background jobs queued
```

---

## 8. Technical Stack

| Layer            | Choice                  | Rationale                                          |
|-----------------|-------------------------|----------------------------------------------------|
| Backend language | Python (FastAPI)       | Fast for LLM integrations; LiveKit Agents Python SDK |
| Voice/media     | **LiveKit Agents Framework** (`livekit-agents`) | Provides `AgentSession`, `Agent` base class, SileroVAD, semantic turn detection, speech queue, barge‑in, `@function_tool` — the full voice pipeline out of the box. Twilio Media Streams as Plan B fallback. |
| STT             | Deepgram Nova‑3 (streaming) | Low‑latency, `keywords` boosting for financial terms (dates, amounts), LiveKit plugin available |
| TTS             | ElevenLabs (streaming)  | Sub‑200ms TTFB, `chunk_length_schedule` for adaptive chunking, natural voice quality |
| LLM             | OpenAI GPT‑4o + GPT‑4o‑mini | Per‑state model selection: GPT‑4o for complex states (negotiation, tool calling), GPT‑4o‑mini for scripted states (greeting, closing) and fast pre‑response filler |
| Database        | Postgres | Persistent workflow state, attempts, events, CRM data, and scheduled actions. |
| Embeddings      | OpenAI `text-embedding-3-small` (optional stretch) | Only needed if semantic override detection or semantic QA search is implemented. |
| Session cache   | Redis (optional)        | Useful only if the runtime grows beyond single-process call state management |
| Observability   | Langfuse                | LLM tracing, token/cost tracking, TTFT measurement, post‑call evaluation scores |
| Infrastructure  | Docker + docker-compose | Local dev; single-region demo deploy              |

---

## 9. API Contracts (MVP)

### 9.1 HTTP APIs

**Start a call (outbound) — with pre‑call validation**

```http
POST /api/calls/start
Body: { "borrower_id": "uuid", "contact_point_id": "uuid" }

Pre-dial validation pipeline (all must pass — see Section 5.2.8):
  1. Borrower status != OPT_OUT
  2. Contact point is valid and not opted out
  3. Current time in borrower/contact timezone is 8:00 AM – 9:00 PM (TCPA)
  4. < 7 recent attempts to this borrower/contact policy bucket in the last 7 days (CFPB Reg F)
  5. No active in-progress conversation for this borrower
  6. No conflicting pending callback/retry action

Success Response (200): { "conversation_id": "uuid" }
Failure Response (422): { "error": "Pre-call validation failed", "validation_failures": ["TCPA_TIME_WINDOW", "FREQUENCY_CAP"] }
```

**Simulate a turn (JSON demo fallback)**

```http
POST /api/conversations/{id}/simulate_turn
Body: { "user_text": "I can pay on Friday" }
Response: {
  "agent_text": "Great, I've noted your promise to pay by Friday...",
  "new_state": "CONFIRMING_OUTCOME",
  "tool_called": { "name": "record_promise_to_pay", "args": {...} },
  "outcome": null
}
```

**List conversations**

```http
GET /api/conversations?page=1&limit=20
Response: [ { conversation_id, borrower_name, started_at, ended_at, final_outcome, duration, channel } ]
```

**Get conversation detail (with reconstructed transcript)**

```http
GET /api/conversations/{id}
Response: {
  "conversation": { ...metadata },
  "transcript": [ { speaker: "AGENT"|"BORROWER", text: "...", timestamp: "..." } ],
  "event_timeline": [ { type: "...", payload: {...}, created_at: "..." } ]
}
```

**Run a deterministic scenario test**

```http
POST /api/testing/scenarios/{scenario_id}/run
Response: {
  "scenario_id": "wrong-party-contact",
  "passed": true,
  "final_outcome": "THIRD_PARTY_CONTACT",
  "expected_state_path": ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING"],
  "actual_state_path": ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING"]
}
```

Optional stretch: add `GET /api/conversations/search?q=...` backed by pgvector after the scenario runner exists.

### 9.2 Internal Event Schema (illustrative)

```json
{
  "type": "USER_TURN_FINAL",
  "conversation_id": "uuid",
  "timestamp": "2026-03-22T02:00:00Z",
  "payload": { "text": "I can pay on Friday", "confidence": 0.92 }
}
```

```json
{
  "type": "STATE_TRANSITION",
  "conversation_id": "uuid",
  "timestamp": "2026-03-22T02:00:01Z",
  "payload": { "from": "DISCUSSING_PAYMENT", "to": "CONFIRMING_OUTCOME", "triggered_by": "LLM_INTENT" }
}
```

```json
{
  "type": "AGENT_TURN",
  "conversation_id": "uuid",
  "timestamp": "2026-03-22T02:00:02Z",
  "payload": { "text": "Thanks, I have recorded your promise to pay on Friday.", "state": "CONFIRMING_OUTCOME" }
}
```

---

## 10. Milestones & Phasing

### Milestone 1 – Core Runtime, Data Model & Compliance Guardrails (Day 1)

- Implement Postgres schema for core tables: `borrowers`, `contact_points`, `borrower_contact_points`, `loans`, `agent_versions`, `workflow_executions`, `call_attempts`, `conversations`, `conversation_events`, `scheduled_actions`. Seed with demo borrower/loan/contact data.
- Implement full state machine with transitions, adjacency map, and ALL hard‑coded override rules (opt‑out, wrong number, hardship, dispute).
- Implement pre‑call validation pipeline (TCPA time window, 7‑in‑7 frequency, contact validity/consent, opt‑out, active call check).
- Implement tool stubs as `@function_tool` methods (DB writes + reads) with idempotency guards.
- Implement call-control module interfaces for voicemail, transfer, and hangup.
- Build `POST /api/conversations/{id}/simulate_turn` JSON endpoint — **NOTE: This text simulation endpoint must be kept alive for demo fallback purposes in case telephony fails.**
- Verify end‑to‑end: simulate a full five‑turn collections conversation via JSON and confirm all events, override rules, and final outcomes are written correctly.

### Milestone 2 – LLM Integration, Semantic Layer & Per‑State Configuration (Day 1–2)

- Replace stub LLM response with real OpenAI calls (GPT‑4o for complex states, GPT‑4o‑mini for simple states).
- Implement structured output parsing (`message`, `tool_call`, `intent_satisfied`, `suggested_next_state`) with state machine validation.
- Implement state‑scoped tool dispatch via `@function_tool` filtering per state.
- Implement deterministic cross‑call memory using compact structured facts from prior conversations, only injected after right-party verification.
- Tune system prompts per state (Mini‑Miranda in greeting, loan context in payment discussion, confirmation readback).
- Wire Langfuse tracing around all LLM calls with `conversation_id` + `current_state` tags.
- If time permits, add the semantic override safety net as a stretch feature after the deterministic runtime is stable.

### Milestone 3 – LiveKit Agents Voice Integration (Day 2–3)

- Implement `Agent` subclass with `on_enter` for non‑interruptible disclosures (Mini‑Miranda, recording notice).
- Configure `AgentSession` with `MultilingualModel()` turn detection, endpointing delays, false interruption recovery.
- Implement AMD and voicemail handling in the call-control layer with FDCPA‑compliant voicemail.
- Implement outbound calling via `ctx.api.sip.create_sip_participant()`.
- Implement `FlushSentinel`‑based LLM‑to‑TTS sentence‑level streaming.
- Demonstrate at least one full voice call with correct state transitions, barge‑in, and non‑interruptible disclosure.

### Milestone 4 – Analytics UI, Semantic Search, Reliability & Polish (Day 3)

- Build transcript reconstruction API (`GET /api/conversations/{id}`).
- Build minimal conversations list + detail UI plus deterministic scenario test runner.
- Add timeouts, retries, graceful call termination, and durable outbox processing on failures.
- Implement fast pre‑response filler pattern (if time permits).
- Implement post‑call LLM evaluation scoring (if time permits).
- Optional stretch: semantic search API or semantic override detection via pgvector.
- Prepare scripted demo scenarios (one voice call + one JSON simulation walkthrough + one override rule demo + one warm-transfer / escalation demo).

---

## 11. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Telephony/LiveKit latency instability** | JSON simulation endpoint always available as demo fallback (5.2.4). Documented Plan B Twilio Media Streams fallback with concrete architecture (5.2.1). |
| **LLM suggesting invalid transitions** | Orchestrator explicitly validates transitions against the state machine adjacency map before applying. |
| **LLM meandering off‑script** | Hard‑coded override rules execute *before* LLM for opt‑out/wrong‑number/hardship/dispute. Tools are State‑Scoped via `@function_tool` filtering. Per‑state prompt fragments keep the LLM focused. |
| **STT accuracy on financial data (dates, amounts)** | Use Deepgram Nova‑3 with `keywords` boosting for financial terms. Agent must verbally confirm date/amount before recording promise‑to‑pay. |
| **Protected borrower data leaks before right-party verification** | Prompt context is split into public vs protected layers. Loan/account context is injected only after verification succeeds. |
| **Database blocking the Hot Path** | Keep active state in memory, but persist only critical control-plane records synchronously and push non-critical enrichment to an outbox worker. |
| **Identity verification confusion** | Explicitly documented as simulated in PRD and demo script; protected context still remains gated until the simulated verification step completes. |
| **FDCPA/TCPA violations in demo** | Mini‑Miranda delivered as non‑interruptible segment. Hardship/dispute phrases trigger immediate safe handling. Pre‑call validation pipeline blocks illegal calls. |
| **False VAD triggers at call start** | AEC warmup (~3s) naturally covered by non‑interruptible Mini‑Miranda disclosure. `false_interruption_timeout=2.0s` with auto‑resume. |
| **40–60% of outbound calls hitting voicemail** | AMD detection is modeled as a call-control/runtime event. FDCPA‑compliant voicemail script (no debt details). `VOICEMAIL_LEFT` and `NO_ANSWER` outcomes tracked. |
| **LLM calling tools twice after barge‑in** | Idempotent tool calls with business-key constraints and `tool_call_id` deduplication. Call-control actions also carry idempotency keys. |
| **Overbuilding low-signal vector features** | Keep pgvector features optional until workflow state, transfer behavior, and scenario testing are complete. |
| **Prompt bloat from long borrower call histories** | Use compact structured memory blocks from recent conversations rather than long free-form summaries. |

---

## References

1. [How to Build AI Voice Agents for Debt Collection](https://smallest.ai/blog/build-ai-voice-agents-debt-collection)
2. [Feather | Human like AI Calls](https://www.featherhq.com/industries/financial-services)
3. [How to Implement AI Voice Agents for Debt Collection](https://www.vodex.ai/blog-posts/how-to-implement-ai-voice-agents-for-debt-collection-a-practical-guide)
4. [How Feather's AI agents had real conversations with ...](https://www.linkedin.com/posts/aahansawhney_in-lending-speed-wins-our-ai-called-10000-activity-7318755392467914753-67zU)
5. [AI Voice for Debt Collection: How to Optimize Your ...](https://moveo.ai/blog/ai-voice-for-debt-recovery)
6. [Feather | Human like AI Calls](https://www.featherhq.com)
7. [We automated our collections calls using voice AI](https://www.reddit.com/r/automation/comments/1l50xk7/we_automated_our_collections_calls_using_voice_ai/)
8. [Building Multi-Agent Conversations with WebRTC & LiveKit](https://dev.to/cloudx/building-multi-agent-conversations-with-webrtc-livekit-48f1)
9. [Live conversations with AI using ChatGPT and WebRTC](https://livekit.com/blog/meet-kitt)
10. [Best AI Voice Agent for Inbound Calls and Sales](https://www.featherhq.com/blog/best-ai-voice-agent-inbound-sales-support)
11. [How Call Centers Use AI Voice Calling for Debt Collection?](https://www.tabbly.io/blogs/ai-voice-calling-debt-collection)
12. [Voice AI Agents for Lending](https://www.lendflow.com/solutions/voice-ai)
13. [Blog: A Deep Dive Into LiveKit, the Open Source Platform Powering ...](https://www.sakthisanthosh.in/blogs/2025/1/)
14. [How to Set Up Voice AI Agents Using LiveKit + Twilio (Step ...](https://www.youtube.com/watch?v=2snWgQ6Pyac)
15. [Loan Collection AI Voice Agent & Workflow Automation](https://www.unleashx.ai/loan-collection/)
16. [LiveKit Agents Framework — Build Voice AI Agents](https://docs.livekit.io/agents/)
17. [FDCPA Guidelines for AI Voice Agents in Debt Collection](https://smallest.ai/blog/fdcpa-guidelines-voice-ai-debt-collection)
18. [FCC Confirms TCPA Applies to AI Voice Technologies (2024)](https://www.fcc.gov/document/fcc-confirms-tcpa-applies-ai-technologies-generate-human-voices)
19. [Engineering for Real-Time Voice Agent Latency](https://cresta.com/blog/engineering-for-real-time-voice-agent-latency)
20. [The Voice AI Stack for Building Agents in 2026](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents)