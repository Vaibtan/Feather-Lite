# Feather-Lite Implementation Specification

## 1. Purpose

This document converts the product/design intent in `PRD.md` into an implementation-grade engineering specification.

This spec is the source of truth for:

- module boundaries
- schema and event contracts
- runtime invariants
- implementation order
- acceptance criteria
- deterministic test coverage

If `SPEC.md` and `PRD.md` diverge during implementation, update both together. `SPEC.md` should remain closer to the code and deployment reality.

---

## 2. Scope

### 2.1 In Scope

- Single-tenant prototype of a collections-oriented voice AI platform
- Outbound call flow with JSON simulation fallback
- Stateful call runtime with explicit outcomes
- Durable workflow execution and call attempt tracking
- Right-party contact gating before protected context is exposed
- Telephony call control primitives: voicemail, hangup, warm transfer placeholder
- Transcript/event timeline reconstruction
- Deterministic scenario testing harness
- Basic admin/QA APIs and minimal UI

### 2.2 Out of Scope for Initial Build

- Multi-tenant auth and billing
- Advanced campaign management / dialer optimization
- Full legal/compliance rules engine
- Production-scale human routing infrastructure
- Generic RAG/knowledge platform
- Semantic QA search and vector retrieval

Out-of-scope items may be added later only after the core runtime is stable.

---

## 3. Engineering Principles

### 3.1 Non-Negotiable Invariants

- Protected borrower/account context must not be injected into prompts before right-party verification succeeds.
- `CALL_STARTED`, `STATE_TRANSITION`, outcome writes, callback scheduling, and suppression writes must be durable before the system claims success to the caller.
- Telephony control actions are runtime operations, not free-form LLM tools.
- The state machine is authoritative; the LLM cannot invent new states or bypass adjacency rules.
- Every call must be reconstructible from durable records even if the process crashes mid-session.
- JSON simulation must exercise the same orchestration path as voice wherever practical.

### 3.2 Build Priorities

1. Deterministic control plane
2. Durable eventing and replayability
3. Safe conversation behavior
4. Telephony/runtime correctness
5. Observability and testing
6. Stretch intelligence features

---

## 4. Recommended Repository Structure

This structure is recommended even if the first implementation is small.

> **Status note (2026-08-21).** The Python layout below is what this spec recommended for v1. The
> shipped system is v2 (TypeScript + Effect) and does not follow it — see the repository map in the
> README for the actual tree. Kept here as the original requirement.

```text
backend/
  app/
    api/
      routes_calls.py
      routes_conversations.py
      routes_testing.py
      routes_admin.py
    core/
      config.py
      logging.py
      db.py
      enums.py
      errors.py
    models/
      borrower.py
      contact_point.py
      loan.py
      agent_version.py
      workflow_execution.py
      call_attempt.py
      conversation.py
      conversation_event.py
      scheduled_action.py
    schemas/
      calls.py
      conversations.py
      testing.py
      admin.py
      events.py
    services/
      workflow_service.py
      conversation_service.py
      state_machine.py
      tool_dispatcher.py
      call_control.py
      compliance_guardrails.py
      transcript_service.py
      replay_service.py
      scenario_runner.py
    voice/
      agent_runtime.py
      prompt_builder.py
      session_state.py
      livekit_adapter.py
      stt_adapter.py
      tts_adapter.py
    workers/
      outbox_worker.py
      summary_worker.py
    migrations/
    tests/
      unit/
      integration/
      scenarios/
frontend/
  app/
    conversations/
    scenarios/
docs/
  PRD.md
  SPEC.md
```

If the codebase stays flatter, preserve the same conceptual separation.

---

## 5. System Decomposition

### 5.1 API Service

Responsibilities:

- expose HTTP endpoints
- validate requests
- create workflow executions and call attempts
- serve conversation detail, transcripts, and scenario results

Must not:

- hold conversation business logic inline in route handlers
- directly encode telephony state transitions

### 5.2 Workflow Orchestrator

Responsibilities:

- create and manage `workflow_executions`
- create `call_attempts`
- enforce pre-call validation
- determine next scheduled action after an outcome
- coordinate callback and retry semantics across attempts

### 5.3 Voice Runtime

Responsibilities:

- own live session state
- run the state machine
- build prompts
- dispatch LLM tools
- translate LLM suggestions into validated transitions
- coordinate with call-control

### 5.4 Call Control Module

Responsibilities:

- AMD result handling
- voicemail drop
- hangup
- warm transfer stub / integration point
- provider event idempotency

Must not:

- be exposed as a general-purpose LLM tool surface

### 5.5 Persistence + Eventing Layer

Responsibilities:

- durable entity writes
- event append with monotonic `sequence_no`
- outbox pattern for async/non-critical work
- replay queries

### 5.6 Scenario Runner

Responsibilities:

- replay scripted user turns against the same orchestrator used by runtime
- assert final outcome
- assert state path
- assert expected tools and call-control actions

### 5.7 Admin / QA Surface

Responsibilities:

- list conversations
- show transcript
- show event timeline
- run and inspect deterministic scenarios

---

## 6. Core Domain Model

### 6.1 Entities

#### `borrowers`

Purpose:

- logical borrower identity

Required fields:

- `id`
- `name`
- `preferred_language`
- `timezone`
- `status`
- `created_at`
- `updated_at`

Notes:

- `status` must support at least `ACTIVE`, `OPT_OUT`, `DECEASED`

#### `contact_points`

Purpose:

- concrete callable contact method

Required fields:

- `id`
- `type`
- `value`
- `is_valid`
- `consent_status`
- `timezone_override`
- `created_at`
- `updated_at`

Notes:

- `value` should use E.164 formatting for phone numbers
- wrong number writes mutate this table, not `borrowers`

#### `borrower_contact_points`

Purpose:

- relationship between borrower and contact point

Required fields:

- `borrower_id`
- `contact_point_id`
- `priority`
- `relationship`

#### `loans`

Purpose:

- account context discussed after verification

Required fields:

- `id`
- `borrower_id`
- `principal`
- `balance_due`
- `due_date`
- `status`
- `delinquency_days`
- `last_promise_date`

#### `agent_versions`

Purpose:

- track deployed prompt/config versions

Required fields:

- `id`
- `name`
- `prompt_hash`
- `status`
- `created_at`

Notes:

- every conversation must point at one concrete `agent_version_id`

#### `workflow_executions`

Purpose:

- multi-attempt borrower journey

Required fields:

- `id`
- `borrower_id`
- `loan_id`
- `workflow_type`
- `status`
- `current_attempt_no`
- `scheduled_for`
- `created_at`
- `updated_at`

#### `call_attempts`

Purpose:

- single telephony attempt

Required fields:

- `id`
- `workflow_execution_id`
- `contact_point_id`
- `direction`
- `provider_call_id`
- `attempt_status`
- `started_at`
- `ended_at`

#### `conversations`

Purpose:

- one AI-driven interaction attached to a call attempt

Required fields:

- `id`
- `call_attempt_id`
- `borrower_id`
- `agent_version_id`
- `started_at`
- `ended_at`
- `final_outcome`
- `final_outcome_metadata`
- `channel`
- `transfer_target`
- `protected_context_unlocked`

#### `conversation_events`

Purpose:

- durable append-only event log per conversation

Required fields:

- `id`
- `conversation_id`
- `sequence_no`
- `type`
- `payload`
- `created_at`

#### `scheduled_actions`

Purpose:

- deferred workflow actions

Required fields:

- `id`
- `workflow_execution_id`
- `action_type`
- `due_at`
- `status`
- `payload`

### 6.2 Required Indexes

- `borrowers(status)`
- `contact_points(value)` unique where appropriate
- `borrower_contact_points(borrower_id, priority)`
- `workflow_executions(borrower_id, status)`
- `call_attempts(workflow_execution_id, started_at desc)`
- `call_attempts(contact_point_id, started_at desc)`
- `conversations(call_attempt_id)` unique
- `conversations(borrower_id, started_at desc)`
- `conversation_events(conversation_id, sequence_no)` unique
- `scheduled_actions(workflow_execution_id, status, due_at)`

### 6.3 Required Constraints

- one conversation per call attempt
- monotonic `sequence_no` per conversation
- idempotency keys on tool and call-control side effects
- `contact_points.consent_status` and borrower opt-out rules enforced before outbound calls

---

## 7. Enumerations

These should live in code as explicit enums.

### 7.1 Conversation States

- `GREETING`
- `VERIFYING_IDENTITY`
- `DISCUSSING_PAYMENT`
- `CONFIRMING_OUTCOME`
- `VOICEMAIL`
- `THIRD_PARTY_OR_WRONG_PARTY`
- `WARM_TRANSFER_PENDING`
- `OPT_OUT`
- `WRONG_NUMBER`
- `ESCALATED`
- `ENDING`
- `COMPLETED`

### 7.2 Outcomes

- `PROMISE_TO_PAY`
- `CALLBACK_SCHEDULED`
- `WRONG_NUMBER`
- `OPT_OUT`
- `ESCALATED`
- `DISPUTED`
- `VOICEMAIL_LEFT`
- `THIRD_PARTY_CONTACT`
- `NO_ANSWER`
- `FAILED`

### 7.3 Workflow Types

- `PAYMENT_REMINDER`
- `CALLBACK_FOLLOWUP`
- `ESCALATION_FOLLOWUP`

### 7.4 Call Attempt Status

- `INITIATED`
- `ANSWERED`
- `NO_ANSWER`
- `VOICEMAIL`
- `COMPLETED`
- `FAILED`

### 7.5 Event Types

- `CALL_STARTED`
- `CALL_CONTROL`
- `AMD_RESULT`
- `NO_INPUT`
- `USER_TURN`
- `USER_TURN_FINAL`
- `AGENT_TURN`
- `TOOL_CALLED`
- `TOOL_RESULT`
- `STATE_TRANSITION`
- `TRANSFER_REQUESTED`
- `TRANSFER_COMPLETED`
- `CALL_ENDED`

---

## 8. State Machine Specification

### 8.1 Allowed Transition Graph

```text
GREETING -> VOICEMAIL
GREETING -> VERIFYING_IDENTITY
VERIFYING_IDENTITY -> THIRD_PARTY_OR_WRONG_PARTY
VERIFYING_IDENTITY -> DISCUSSING_PAYMENT
DISCUSSING_PAYMENT -> CONFIRMING_OUTCOME
DISCUSSING_PAYMENT -> WARM_TRANSFER_PENDING
DISCUSSING_PAYMENT -> WRONG_NUMBER
DISCUSSING_PAYMENT -> OPT_OUT
CONFIRMING_OUTCOME -> ENDING
VOICEMAIL -> ENDING
THIRD_PARTY_OR_WRONG_PARTY -> ENDING
WARM_TRANSFER_PENDING -> ENDING
OPT_OUT -> ENDING
WRONG_NUMBER -> ENDING
ESCALATED -> ENDING
ENDING -> COMPLETED
```

Override transitions allowed from any state:

- `* -> OPT_OUT`
- `* -> WRONG_NUMBER`
- `* -> ESCALATED`

### 8.2 State Entry Behavior

#### `GREETING`

- deliver Mini-Miranda
- deliver recording disclosure
- do not include protected account context

#### `VERIFYING_IDENTITY`

- ask lightweight confirmation
- do not discuss balance, due date, delinquency, or prior commitments

#### `DISCUSSING_PAYMENT`

- only enter after `protected_context_unlocked = true`
- inject protected account context and compact prior structured memory

#### `CONFIRMING_OUTCOME`

- read back exact amount/date/time
- require confirmation before recording outcome

#### `VOICEMAIL`

- use constrained voicemail script
- never expose debt details

#### `WARM_TRANSFER_PENDING`

- stop collections negotiation
- initiate transfer flow or safe handoff fallback

### 8.3 Exit Conditions

- `VERIFYING_IDENTITY -> DISCUSSING_PAYMENT` only if right-party verified
- `CONFIRMING_OUTCOME -> ENDING` only if outcome write committed
- `VOICEMAIL -> ENDING` only after voicemail action logged
- `WARM_TRANSFER_PENDING -> ENDING` only after transfer attempt recorded

### 8.4 Override Rules

Keyword-based deterministic rules must run before the LLM:

- opt-out phrases
- wrong-number / wrong-party phrases
- hardship / distress phrases
- debt dispute phrases

If multiple rules match in one turn, apply precedence:

1. `OPT_OUT`
2. `DISPUTED`
3. `HARDSHIP / ESCALATED`
4. `WRONG_NUMBER`

Rationale:

- suppression and compliance-safe termination take precedence over ordinary routing

---

## 9. Context Injection Rules

### 9.1 Public Context

Allowed before verification:

- agent name
- company/brand
- caller number identity
- workflow type
- local time / allowed contact window
- attempt count
- generic script instructions

### 9.2 Protected Context

Allowed only after verification:

- due amount
- due date
- loan status
- delinquency bucket
- previous promise-to-pay details
- callback commitments
- prior right-party contact facts

### 9.3 Prompt Builder Contract

Prompt builder input:

- current state
- public context
- protected context optional
- compact prior structured memory optional
- allowed tools

Prompt builder output:

- system prompt text
- dynamic instructions
- tool allowlist

Acceptance criteria:

- no protected fields are present in prompt logs prior to verification
- prompt builder has unit tests proving this

### 9.4 Normalized Turn Decision Contract

The spec must define a provider-independent turn contract for the orchestrator.

Required normalized shape:

```json
{
  "message": "string",
  "tool_call": {
    "name": "record_promise_to_pay",
    "tool_call_id": "uuid",
    "args": {}
  },
  "intent_satisfied": true,
  "suggested_next_state": "CONFIRMING_OUTCOME"
}
```

Field rules:

- `message`: required string, may be empty only for tool-only or transfer-only turns
- `tool_call`: nullable, at most one call in the initial implementation
- `intent_satisfied`: required boolean
- `suggested_next_state`: nullable enum value from the allowed conversation states

Validation rules:

- `suggested_next_state` must be validated against the state machine adjacency map
- `tool_call.name` must be in the state-scoped allowlist
- `tool_call.args` must pass tool schema validation before execution
- the orchestrator may reject the decision and end or recover safely if validation fails

Implementation decision:

- The orchestrator consumes this normalized contract on every turn.
- On the JSON simulation path, this may be produced directly via structured LLM output.
- On the LiveKit voice path, native function-calling may still be used for actual tool execution, but the runtime must adapt provider/framework behavior into this same normalized `TurnDecision` object before state transition validation is applied.

Rationale:

- keeps the orchestrator provider-agnostic
- preserves compatibility with LiveKit native tool calling
- makes scenario tests deterministic
- keeps the PRD contract explicit rather than implicit in framework behavior

---

## 10. Tooling Specification

### 10.1 LLM-Callable Domain Tools

Required tools:

- `lookup_contact_profile(contact_point_id)`
- `get_account_context(borrower_id)`
- `record_promise_to_pay(borrower_id, date, amount, notes)`
- `schedule_callback(borrower_id, datetime)`
- `record_opt_out(subject_id, scope, reason)`
- `record_wrong_party_contact(contact_point_id, notes)`

### 10.2 Tool Rules

- tools must return structured JSON
- tools must validate state eligibility before executing
- tools must reject when required fields are missing
- tools must include idempotency keys
- successful tool outputs must be reflected in `conversation_events`
- tool execution on voice path may be driven by LiveKit native function-calling, but post-tool orchestration must still flow through the normalized turn contract in section 9.4

### 10.3 Call-Control Operations

Not LLM tools:

- `handle_amd_result`
- `drop_voicemail`
- `warm_transfer`
- `hangup_call`
- `place_on_hold`

These are invoked by orchestrator/runtime code only.

### 10.4 Tool Acceptance Criteria

- duplicate tool invocations do not create duplicate business records
- invalid tool use in the wrong state fails closed
- outcome-committing tools durably write before success is surfaced to the caller

### 10.5 LLM Output Contract

Both runtime paths must normalize their output into the `TurnDecision` contract defined in Section 9.4. Two runtime paths produce conversation events. Both must generate identical `conversation_events` for the same input sequence.

#### Voice path (LiveKit Agents native)

- LLM tool dispatch is handled by the framework via `@function_tool` decorators
- State transition suggestions are extracted via session event handlers (`@session.on("function_calls_collected")` or equivalent)
- The orchestrator validates suggested transitions against the adjacency map before applying
- The framework manages streaming token → TTS dispatch internally

#### Simulation path (`POST /api/conversations/{id}/simulate_turn`)

- LLM returns structured JSON per turn:

```json
{
  "message": "string — spoken text",
  "tool_call": { "name": "string", "args": {} } | null,
  "intent_satisfied": true | false,
  "suggested_next_state": "string" | null
}
```

- The orchestrator parses the response, validates `suggested_next_state` against the adjacency map, executes the tool if present, and returns the result
- This path bypasses STT/TTS but exercises the same state machine, override rules, context injection, and tool dispatch logic

#### Acceptance criteria

- A scripted scenario run via simulation and via voice (with deterministic STT input) must produce the same state path, tool calls, and final outcome

### 10.6 Tool-State Eligibility

| Tool | Eligible States |
|---|---|
| `lookup_contact_profile` | `GREETING`, `VERIFYING_IDENTITY` |
| `get_account_context` | `DISCUSSING_PAYMENT`, `CONFIRMING_OUTCOME` |
| `record_promise_to_pay` | `CONFIRMING_OUTCOME` |
| `schedule_callback` | `DISCUSSING_PAYMENT`, `CONFIRMING_OUTCOME` |
| `record_opt_out` | `OPT_OUT` |
| `record_wrong_party_contact` | `THIRD_PARTY_OR_WRONG_PARTY`, `WRONG_NUMBER` |

Acceptance criteria:

- tool invocation in a non-eligible state must fail closed with an error event logged to `conversation_events`
- this matrix must be enforced identically in both voice and simulation paths

---

## 11. Event Model

### 11.1 Event Append Rules

Every event append must:

- be tied to a `conversation_id`
- carry a strictly increasing `sequence_no`
- be written inside a transaction with the associated business mutation when applicable

### 11.2 Minimum Required Payloads

#### `CALL_STARTED`

```json
{
  "workflow_execution_id": "uuid",
  "call_attempt_id": "uuid",
  "contact_point_id": "uuid",
  "channel": "voice"
}
```

#### `STATE_TRANSITION`

```json
{
  "from": "VERIFYING_IDENTITY",
  "to": "DISCUSSING_PAYMENT",
  "triggered_by": "RIGHT_PARTY_CONFIRMED"
}
```

#### `TOOL_CALLED`

```json
{
  "name": "record_promise_to_pay",
  "tool_call_id": "uuid",
  "args": {
    "amount": 500,
    "date": "2026-03-25"
  }
}
```

#### `CALL_CONTROL`

```json
{
  "action": "WARM_TRANSFER",
  "idempotency_key": "uuid",
  "target": "collections_queue"
}
```

### 11.3 Replay Requirements

Replay must be able to recover:

- last known state
- whether protected context was unlocked
- final outcome if already committed
- tools already executed
- call-control actions already attempted

---

## 12. API Specification

### 12.1 `POST /api/calls/start`

Purpose:

- create workflow execution and first call attempt
- run pre-call validation

Request:

```json
{
  "borrower_id": "uuid",
  "contact_point_id": "uuid"
}
```

Validation checks:

- borrower not opted out
- contact point valid
- contact point not opted out
- local time in allowed window
- frequency cap not exceeded
- no active conversation
- no conflicting pending scheduled action

Success response:

```json
{
  "conversation_id": "uuid",
  "workflow_execution_id": "uuid",
  "call_attempt_id": "uuid"
}
```

Failure response:

```json
{
  "error": "Pre-call validation failed",
  "validation_failures": ["TCPA_TIME_WINDOW"]
}
```

### 12.2 `POST /api/conversations/{id}/simulate_turn`

Purpose:

- run orchestrator path without telephony

Request:

```json
{
  "user_text": "I can pay on Friday"
}
```

Response:

```json
{
  "agent_text": "I can help with that.",
  "new_state": "CONFIRMING_OUTCOME",
  "tool_called": null,
  "call_control_action": null,
  "outcome": null
}
```

### 12.3 `GET /api/conversations`

Purpose:

- list conversations for admin view

Required fields in response:

- `conversation_id`
- `borrower_name`
- `started_at`
- `ended_at`
- `final_outcome`
- `duration`
- `channel`

### 12.4 `GET /api/conversations/{id}`

Purpose:

- show conversation detail

Response sections:

- conversation metadata
- transcript
- event timeline

### 12.5 `POST /api/testing/scenarios/{scenario_id}/run`

Purpose:

- run deterministic scenario test

Response:

```json
{
  "scenario_id": "wrong-party-contact",
  "passed": true,
  "expected_state_path": ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING"],
  "actual_state_path": ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING"],
  "final_outcome": "THIRD_PARTY_CONTACT"
}
```

---

## 13. Telephony and Media Specification

### 13.1 Live Session Requirements

- LiveKit session for voice path
- streaming STT (Deepgram Nova-3)
- streaming TTS (ElevenLabs)
- SileroVAD + `MultilingualModel()` for semantic turn detection
- non-interruptible disclosures via `allow_interruptions=False`

#### Barge-in Contract

On VAD speech detection during agent playback:

1. Cancel current `SpeechHandle` — TTS playback stops immediately, in-flight LLM generation is cancelled via cancellation token propagation
2. Append partial TTS output (what the borrower actually heard) to LLM context as a truncated assistant message, preserving conversational coherence
3. Process new user utterance from the beginning of the pipeline

Adaptive interruption detection:

- Backchannels ("uh-huh," "okay," "mm-hmm") must NOT trigger speech cancellation
- Configured via `min_interruption_words` threshold on `AgentSession`
- `min_interruption_duration=0.5` — ignore sub-500ms sounds

AEC warmup protection:

- For the first ~3 seconds of a call, echo cancellation is calibrating — the agent's own audio can cause false VAD triggers
- This is naturally covered by the non-interruptible Mini-Miranda disclosure at call start

Non-interruptible segments:

- During non-interruptible playback, VAD continues to detect speech but does NOT trigger TTS stop or LLM cancellation
- User audio is buffered and processed after the segment completes
- Applies to: Mini-Miranda, recording disclosure, verbal confirmation readbacks

### 13.2 AMD Handling

- AMD result enters system as runtime/provider signal
- if machine detected, transition to `VOICEMAIL`
- if unanswered, mark attempt `NO_ANSWER` and terminate

### 13.3 Warm Transfer

Initial implementation may be a stub, but the interface must exist.

Required contract:

- requested target
- transfer started timestamp
- transfer result
- transfer-related event log

### 13.4 Silence / No Input

- first `NO_INPUT`: prompt “Are you still there?”
- second consecutive `NO_INPUT`: safe close and end call

---

## 14. Workflow Logic

### 14.1 Workflow Creation

When starting an outbound call:

- create or reuse workflow execution
- increment attempt number
- create call attempt
- create conversation

### 14.2 Outcome-Driven Next Actions

#### After `PROMISE_TO_PAY`

- record structured promise metadata
- optionally schedule follow-up verification action

#### After `CALLBACK_SCHEDULED`

- create `scheduled_actions` row with requested callback time

#### After `NO_ANSWER`

- create retry action if policy allows

#### After `OPT_OUT`

- create suppression record via borrower/contact point state update
- cancel pending retry/callback scheduled actions if required

#### After `WRONG_NUMBER`

- mark contact point invalid
- avoid future attempts to that contact point

#### After `THIRD_PARTY_CONTACT`

- log contact as third-party reached; contact point remains valid (unlike wrong-number)
- optionally schedule retry at a different time window
- do not create suppression record (number is valid, borrower may answer next time)

#### After `ESCALATED` / `DISPUTED`

- create human follow-up action

### 14.3 Scheduled Action Worker

Initial MVP may run this manually or synchronously via API-driven simulation, but the abstraction must exist.

Required behavior:

- claim due actions
- mark `CLAIMED`
- execute action
- mark `DONE` or return to `PENDING` on retryable failure

---

## 15. Reliability Design

### 15.1 Transaction Boundaries

Must be atomic:

- outcome write + related event append
- callback write + related event append
- suppression write + related event append
- transfer request write + related event append

Need not be atomic with call audio transport:

- transcript assembly
- summary generation
- evaluation jobs

### 15.2 Outbox Pattern

Use an outbox table or equivalent durable queue for:

- summary generation
- future vector embedding jobs
- post-call evaluation jobs

Do not rely on bare `asyncio.ensure_future()` for business-critical persistence.

### 15.3 Idempotency

Apply idempotency keys to:

- tool calls
- provider webhooks
- transfer actions
- voicemail drop

Acceptance criteria:

- replayed webhook or repeated tool invocation does not duplicate side effects

---

## 16. Security and Compliance Controls

### 16.1 Minimum Controls

- mask sensitive fields in logs
- store secrets in environment variables
- never store real card data
- restrict voicemail content
- enforce local-time contact window

### 16.2 Right-Party Gating

Implementation requirements:

- protected context flag in session state
- protected context flag in persistent conversation row
- prompt builder tests
- state machine validation

### 16.3 Disclosure Delivery

Must be:

- verbatim
- non-interruptible
- logged in events

### 16.4 Compliance Overrides

Must be deterministic:

- opt-out
- wrong number
- hardship
- dispute

---

## 17. Observability

### 17.1 Required Tracing

- LLM trace per turn
- prompt and tool metadata
- latency metrics
- provider call identifiers

### 17.2 Required Metrics

- calls started
- calls connected
- voicemail rate
- right-party verification success rate
- outcome distribution
- average response latency
- tool success/failure count
- scenario pass rate

### 17.3 Required Logs

- state transitions
- tool calls/results
- call-control actions
- validation failures
- replay failures

---

## 18. Deterministic Scenario Suite

Each scenario must define:

- seed data
- user turns
- expected state path
- expected tools
- expected call-control actions
- expected final outcome

### 18.1 Mandatory Scenarios

- `happy-path-promise-to-pay`
- `happy-path-callback-scheduled`
- `wrong-number-immediate`
- `wrong-party-during-verification`
- `opt-out-immediate`
- `hardship-escalation`
- `debt-dispute-escalation`
- `voicemail-drop`
- `no-input-timeout`
- `barge-in-during-agent-speech`
- `duplicate-tool-call-idempotent`
- `protected-context-not-exposed-before-verification`

### 18.2 Scenario Acceptance Criteria

- 100% pass rate locally before merge
- each scenario asserts event timeline shape, not just final outcome
- at least one scenario asserts replay from event log

---

## 19. Phased Implementation Plan

> **Status note (2026-08-16).** The phase statuses below were written for the Python v1
> implementation (`backend/`) and were audited in
> `docs/reviews/2026-08-16-plan-vs-implementation-review.md` (several "Complete" claims were
> found to be Partial: LLM not wired, no real voice call, protected context leaking into the
> "prompt", override matcher not covering the spec's phrasings). The shipped system is **v2 in
> TypeScript + Effect**, tracked in `docs/plans/PROGRESS.md` and summarised in the README; the
> Python tree served as the reference implementation until parity was confirmed and was removed in
> Phase 8 (it remains in git history). Mapping of v2 to this plan:
>
> | SPEC phase | v2 status | Where |
> |---|---|---|
> | 1 Skeleton & schema | Complete | `packages/control-plane/src/db` (11 tables + `conversation_turns`, `agent_heartbeats`), migrations on boot, seed via `POST /api/demo/seed` |
> | 2 State machine & orchestrator | Complete | `packages/domain` (92 tests), `Orchestrator.processTurn` three-phase turn; prompt builder actually used by the OpenAI decider; leak test |
> | 3 Durable eventing & outcome writes | Complete | `appendEvent` under row lock, tool idempotency by `tool_call_id`, turn idempotency by `turn_id`, replay endpoint/view |
> | 4 Workflow execution & scheduled actions | Complete | `Workflow.startCall` (pre-call policy, workflow reuse, retry supersede), `Scheduling` worker with TCPA reschedule |
> | 5 Voice runtime & call control | Complete for browser WebRTC; **Partial** for PSTN (SIP path wired, no trunk verified) | `apps/voice-worker`, `POST /api/voice/sessions`, AMD/voicemail/no-input/barge-in/hangup signals; a real automated voice call verified |
> | 6 Admin APIs & scenario runner | Complete | 18-route HttpApi with OpenAPI, 20 scenarios (the 12 mandatory + 8 hardening) via API and vitest |
> | 7 UI & observability | Complete for UI, tracing, counters; **Partial** for latency panel | `apps/console` (5 views), Langfuse tracing layer, `/api/system/status` durable ledger counts |
> | 8 Hardening | **Partial** | timeouts/retries on OpenAI + LiveKit bootstrap, rate limits/daily cap, negative-path scenarios (decider unavailable, invalid transition, wrong-state tool); no automated crash/restart replay test |

Status legend:

- `Complete`: implemented and locally verified
- `Partial`: substantial implementation exists, but acceptance criteria are not fully satisfied
- `Not Started`: planned but not yet implemented

### Phase 1: Project Skeleton and Schema

Status: `Complete`

Checklist:

- [x] create backend project structure
- [x] define enums and shared constants
- [x] add DB connection layer
- [x] write initial migrations for all core tables
- [x] seed minimal borrower/contact/loan data
- [x] add repository/data-access layer

Done criteria:

- migrations run cleanly on fresh database
- seed script succeeds
- entities can be created/read in integration tests

### Phase 2: State Machine and Orchestrator

Status: `Complete`

Checklist:

- [x] implement state enum and adjacency map
- [x] implement state transition validator
- [x] implement session state dataclass
- [x] implement deterministic override matcher
- [x] implement prompt builder with public/protected split
- [x] implement normalized `TurnDecision` schema and validator
- [x] implement tool dispatch framework

Done criteria:

- JSON simulation can run through happy path without telephony
- invalid transitions are rejected
- protected context remains unavailable before verification

### Phase 3: Durable Eventing and Outcome Writes

Status: `Complete`

Checklist:

- [x] implement event append helper with `sequence_no`
- [x] enforce transactional writes for outcomes and related events
- [x] add idempotency support for tool actions
- [x] implement replay service

Completion notes:

- tool and call-control side effects now enforce idempotency through persisted event identifiers
- duplicate tool invocation is covered by the deterministic scenario suite
- replay is exercised for completed and in-flight conversations

Done criteria:

- event timeline reconstructs full happy path
- duplicate tool calls are safe
- replay restores last known state for completed scenarios

### Phase 4: Workflow Execution and Scheduled Actions

Status: `Complete`

Checklist:

- [x] implement `POST /api/calls/start`
- [x] implement pre-call validation service
- [x] implement workflow execution creation/reuse rules
- [x] implement next-action creation for callbacks, retries, escalations
- [x] add scheduled action worker abstraction

Completion notes:

- workflow executions are reused for follow-up attempts when appropriate
- callbacks, retries, and escalation follow-ups are persisted as scheduled actions
- scheduled action worker claims, executes, and retries actions durably

Done criteria:

- outbound start endpoint returns workflow, attempt, and conversation ids
- callback scheduling creates durable next action
- opt-out and wrong number block inappropriate future attempts

### Phase 5: Voice Runtime and Call Control

Status: `Complete`

Checklist:

- [x] implement LiveKit adapter
- [x] implement session bootstrap
- [x] implement disclosure delivery
- [x] implement LiveKit-to-`TurnDecision` adaptation layer
- [x] implement AMD handling path
- [x] implement voicemail path
- [x] implement warm transfer stub and event contracts
- [x] implement silence/no-input handling

Completion notes:

- LiveKit bootstrap against the configured project has been verified from the backend
- voicemail, no-answer, no-input, barge-in, and warm-transfer runtime events are normalized and persisted
- the voice worker now uses an explicit adapter layer instead of bypassing the orchestrator contract

Done criteria:

- LiveKit bootstrap and worker handoff are validated against the configured project
- voicemail path produces expected events and outcome
- call-control actions are logged and idempotent

### Phase 6: Admin APIs and Scenario Runner

Status: `Complete`

Checklist:

- [x] implement conversations list endpoint
- [x] implement conversation detail endpoint
- [x] implement transcript assembly service
- [x] implement scenario definitions
- [x] implement scenario runner endpoint

Completion notes:

- the full mandatory scenario suite is implemented
- scenario responses assert state path, tool calls, call-control actions, event types, and replay results
- scenario list and runner APIs back the operator-facing UI

Done criteria:

- admin APIs return correct metadata and transcript
- all mandatory scenarios run via API

### Phase 7: UI and Observability

Status: `Complete`

Checklist:

- [x] build minimal conversations UI
- [x] build event timeline view
- [x] build scenario runner UI
- [x] integrate Langfuse or equivalent tracing
- [x] emit basic metrics and structured logs

Completion notes:

- operator-facing HTML surfaces exist for conversations and scenarios
- structured JSON logs are emitted around call lifecycle and worker execution
- in-memory tracing and metrics endpoints cover outcomes, latency, tool execution, and scenario activity

Done criteria:

- operator can inspect calls and run scenarios without touching the DB

### Phase 8: Hardening

Status: `Complete`

Checklist:

- [x] add retry policies and timeout handling
- [x] add crash/restart replay tests
- [x] add negative-path scenario coverage
- [x] add outbox worker for non-critical jobs

Completion notes:

- durable outbox and scheduled-action workers are implemented
- replay coverage includes completed and in-flight conversations
- negative-path coverage exists for invalid state/tool usage, duplicate invocations, and transport/bootstrap failures

Done criteria:

- crash simulation does not lose authoritative outcomes
- scenario suite remains green

---

## 20. Deferred Extensions

These are explicitly deferred until the core platform is stable:

- cross-call vector retrieval
- policy/knowledge RAG
- semantic QA search
- post-call LLM evaluation
- prompt A/B testing
- shadow deployments
- multi-tenant tenant-scoped knowledge bases

When added later, they must integrate through existing seams:

- outbox worker
- prompt builder
- structured memory block
- admin/QA surface

---

## 21. Resolved Decisions and Open Questions

### 21.1 Resolved

- **SQL toolkit:** SQLAlchemy Core + AsyncEngine (asyncpg) for queries and transactions. Alembic for migrations. Explicit SQL / repository methods for critical paths (durable outcome writes, event appends with `sequence_no`). No heavy ORM object graphs in the runtime loop.
- **LLM output contract:** LiveKit native `@function_tool` dispatch for voice path; structured JSON schema for simulation path. Both must produce identical `conversation_events` (see Section 10.5).
- **Third-party contact outcome:** `THIRD_PARTY_CONTACT` is a distinct outcome from `WRONG_NUMBER`. Contact point remains valid; retry may be scheduled at a different time (see Section 14.2).
- **Per-state model selection:** SPEC is model-agnostic. PRD prescribes gpt-4o-mini for scripted states, gpt-4o for complex states. Implementation should support per-state model switching; specific model choices are configuration, not architecture.

### 21.2 Open Questions

These should be resolved before deep implementation if possible.

- Warm transfer in v1 is a runtime control path with durable logging and handoff events. Provider-level bridge transfer remains a follow-on integration when telephony infrastructure is added.
- What exact policy should govern callback retry windows?
- Will inbound calls be supported in v1 or only outbound + simulation?
- What deployment target is expected first: local Docker, cloud VM, or container platform?

If unanswered, implementation should pick pragmatic defaults and record them in this file.

---

## 22. Build Readiness Checklist

Current status for ongoing implementation:

- [x] PRD and SPEC are aligned
- [x] schema entities and enums are frozen for phase 1
- [x] runtime invariants are understood by all contributors
- [x] mandatory scenarios are fully defined
- [x] acceptance criteria are agreed
- [x] deferred items are clearly marked and not leaking into the critical path

Current verification snapshot:

- [x] complete Phase 5 call-control correctness
- [x] complete Phase 4 scheduled-action execution
- [x] complete Phase 6 mandatory scenario coverage
- [x] complete Phase 7 observability baseline
- [x] complete Phase 8 hardening and crash/restart validation
