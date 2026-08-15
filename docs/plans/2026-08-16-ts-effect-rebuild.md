# Feather-Lite v2 — TypeScript + Effect rebuild plan

**Date:** 2026-08-16 · **Supersedes:** `SPEC.md §19` phasing (the Python tree under `backend/` is now the reference implementation) · **Inputs:** `PRD.md`, `SPEC.md`, `docs/reviews/2026-08-16-plan-vs-implementation-review.md`, user decisions (time not a constraint; TS+Effect preferred and a signal; live clickable demo if possible; free infra).

---

## 0. Outcome we are building toward

A Feather interviewer opens one URL and can:

1. See the operator console: past conversations, transcript + event timeline, replay snapshot, scenario runner with the 12 mandatory scenarios green.
2. Click **"Call me in the browser"** → the collections agent joins a LiveKit room, delivers a non-interruptible Mini-Miranda, verifies right party, negotiates a promise-to-pay with a real LLM, records it durably, and hangs up — with barge-in working and every turn/tool/transition visible live in the console.
3. (If a phone number is configured) **"Dial my phone"** → outbound PSTN via LiveKit SIP, AMD → voicemail path if unanswered.
4. Read the code: a pure domain package (state machine, overrides, replay, pre-call policy) that is unit-tested and shared by the API and the voice worker; an Effect control plane with typed errors and swappable LLM/telephony layers; a LiveKit worker whose *LLM node is the orchestrator*.

Everything is free. The console (Cloudflare Pages) is always on; the API + voice worker run as Node processes on the laptop behind a Cloudflare Tunnel for the demo, or on an Oracle Always-Free VM for 24/7. The console shows API and agent-worker liveness.

---

## 1. Architecture

```
                 ┌──────────── Cloudflare (free): Pages for the console, Tunnel for the API ───────┐
                 │                                                                                │
   Interviewer ──┤  Pages: operator console (conversations, timeline, scenarios,                   │
   (browser)     │  "call me in the browser" via LiveKit JS client)                                │
                 │        │ fetch  https://api.<domain>  (cloudflared tunnel → Node process)        │
                 │        ▼                                                                        │
                 │  apps/server (Node 22): Effect HttpApi via @effect/platform-node                 │
                 │    • POST /calls/start            pre-call policy → workflow/attempt/conversation │
                 │    • POST /conversations/:id/turn  orchestrator: override → LLM → validate →     │
                 │                                    tools → durable events → SSE text stream      │
                 │    • POST /conversations/:id/signal amd_result | no_input | barge_in | hangup    │
                 │    • GET  /conversations, /conversations/:id, /replay, /scenarios, /scenarios/:id/run
                 │    • POST /voice/sessions          room + dispatch + token (browser or SIP)      │
                 │    • in-process schedulers (Effect fibers): scheduled actions + outbox jobs      │
                 │        │ @effect/sql-pg                    │ fetch                               │
                 │        ▼                                   ▼                                     │
                 │   Neon Postgres (free, ap-southeast-1)  OpenAI (LLM), Langfuse Hobby (traces)     │
                 └────────────────────────────────────────────────────────────────────────────────┘
   The Node process runs on the laptop for the demo, or on an Oracle Always-Free ARM VM for 24/7.
   Stretch: the same HttpApi deployed to Cloudflare Workers + Hyperdrive (CPU budget permitting).
                          ▲  HTTPS (typed HttpApiClient, SSE for turns)
                          │
        ┌─────────────────┴───────────────────────────────────────────┐
        │  apps/voice-worker  (Node 22, @livekit/agents 1.6)           │
        │   • per-conversation voice.Agent whose llmNode() streams     │
        │     the control-plane turn response (framework does TTS,     │
        │     barge-in truncation, metrics)                            │
        │   • onEnter: Mini-Miranda + recording notice, allowInterruptions=false
        │   • voice.AMD after SIP answer → signal amd_result           │
        │   • userAwayTimeout → signal no_input (2-strike close)       │
        │   • agent_false_interruption / speech interrupted → signal barge_in
        │   • outbound: SipClient.createSipParticipant(waitUntilAnswered)
        └──────────────┬──────────────────────────────────────────────┘
                       │ WebRTC / SIP
                       ▼
                 LiveKit Cloud (free "Build" project; Inference for STT/TTS)
                       ▲                     ▲
              browser participant       PSTN via SIP trunk (Twilio trial number, optional)

Shared by both runtimes:  packages/domain  (pure: enums, state machine, overrides, tool matrix,
                          TurnDecision schema, event schema, replay reducer, pre-call policy,
                          transcript assembly, date/amount normalisation)
```

### Package layout (pnpm workspaces)

```
packages/
  domain/          pure Effect Schema + functions; vitest; zero IO
  contracts/       HttpApi definition (shared by server + clients); Schemas for requests/responses/SSE frames
  control-plane/   Effect services + Layers: Persistence (@effect/sql-pg), Orchestrator, TurnDecider
                   {Scripted, OpenAI}, Tools, CallControl, Workflow, Scheduling, Outbox, Tracing
                   {Noop, Langfuse}, Metrics; HttpApi implementation; cron entry
apps/
  server/                Node entry: HttpApi server + in-process schedulers; serves console in dev
  voice-worker/          @livekit/agents worker (separate process; same repo, shares domain+contracts)
  console/               static console (vanilla TS + Vite; LiveKit client for browser calls) → Pages
  edge/ (stretch)        wrangler project mounting the same HttpApi as a Workers fetch handler
backend/                 Python reference (kept until parity, then removed)
docs/adr/                decisions below as ADRs
```

---

## 2. Decisions (ADRs — one paragraph each; full ADRs in `docs/adr/`)

**D1 — The control plane owns the conversation loop; the voice worker is a media adapter.**
Same as the Python design and required by SPEC §3.1/§10.5 ("both paths produce identical events"). The `POST /conversations/:id/turn` endpoint runs override-check → `TurnDecider` (LLM) → adjacency/tool validation → tool execution → durable event append → response. Simulation, scenario runner and voice all call this. *Alternative considered:* LiveKit-native per-state `voice.Agent` subclasses with `llm.handoff()` — elegant, but the state machine authority would live in the Node worker (not on the always-on URL), the scenario suite could not run against a deterministic decider without livekit-agents in the loop, and events would differ between paths. Rejected for v2; noted as a possible v3 experiment.

**D2 — The voice worker overrides `Agent.llmNode()` to stream the control-plane turn.**
`llmNode(chatCtx, toolCtx, settings)` returns a `ReadableStream<string>`; we open the SSE turn stream and yield text deltas. The framework then does TTS streaming, interruption handling (including truncating the assistant message to what was actually heard, which we forward as `heard_text` on the next turn), state events and metrics — natively. Non-interruptible turns (readbacks) and disclosures use `session.say(text, {allowInterruptions:false})`; the turn response carries `speak_mode`. *Alternative:* `onUserTurnCompleted` + `say()` + `StopResponse` (what the Python did) — loses native barge-in bookkeeping and preemptive generation.

**D3 — Postgres on Neon (free, `ap-southeast-1`) with `@effect/sql-pg` (wraps node-postgres); local Docker Postgres for dev/tests.**
The 12 scenarios and the workflow model are relational (frequency caps, active-conversation checks, `SKIP LOCKED` claims, cross-conversation lists). Neon free: 0.5 GB, 100 CU-h/month, autosuspend after 5 min (a keep-warm ping runs while "demo mode" is on). Region chosen for proximity to the laptop/worker. *Stretch:* Durable Object per conversation as serializer/event-log cache if the Workers port happens.

**D4 — Hosting: one Node process (`apps/server`) behind a free Cloudflare Tunnel; console on Cloudflare Pages.**
Cloudflare Workers Free caps CPU at **10 ms per invocation** — too tight for Effect + Postgres + streaming an LLM turn, and impossible for a scenario run in one request. Because `@effect/platform` HttpApi is runtime-agnostic (`HttpApiBuilder.toWebHandler` exists), the same `packages/control-plane` can later be mounted as a Workers fetch handler (`apps/edge`, stretch) if measured CPU fits; nothing in the design depends on where it runs. For the interview the Node process runs on the laptop (tunnel gives the public URL); for always-on, Oracle Cloud Always Free (Ampere A1, 2 OCPU/12 GB, $0) is the documented target — the voice worker can live on the same VM, making the *whole* demo always-on. Console on Pages stays up regardless and shows API/worker liveness.

**D5 — Telephony: browser WebRTC is the primary demo path; PSTN is optional and best-effort.**
LiveKit Build (free) includes SIP, 1 free US local number (LiveKit Phone Numbers) and 1,000 third-party-SIP minutes; outbound to a non-US number is metered. Twilio trial trunks only dial verified numbers in the account's sign-up country. We wire `createSipParticipant(waitUntilAnswered)` + `voice.AMD` and make the trunk/number configuration env-driven; the demo script treats PSTN as a bonus.

**D6 — LLM: OpenAI called from the control plane with tool-calling + a `set_turn_outcome` structured trailer; per-state model selection is config** (`gpt-4.1-mini` for GREETING/VERIFYING/VOICEMAIL/ENDING; `gpt-4.1` for DISCUSSING/CONFIRMING; overridable via env). Deterministic `ScriptedTurnDecider` Layer for scenarios/CI. Sentence-boundary chunking of the streamed message feeds SSE (`FlushSentinel` semantics).

**D7 — Tracing: Langfuse (free Hobby tier) via its JS SDK from the Worker; Noop layer in tests.** Metrics: counters/histograms in memory per isolate + a `metrics_snapshots` table written by cron for the console.

**D8 — Effect 3.22 (stable), not the 4.0 RC (`4.0.0-rc.109` on 2026-08-16).** `Effect.Service` classes, `Schema.TaggedError` at boundaries / `Data.TaggedError` internally, `effect/Schema`, `@effect/platform` 0.97 HttpApi (`HttpApiBuilder`, `HttpApiClient`), `@effect/sql` 0.52 + `@effect/sql-pg` 0.53, `@effect/vitest`. Node 22, pnpm.

**D10 — Sources for the platform facts above:** [LiveKit pricing](https://livekit.com/pricing) · [LiveKit Phone Numbers](https://blog.livekit.io/introducing-livekit-phone-numbers-zero-to-ringing-in-60-seconds/) · [Neon plans](https://neon.com/docs/introduction/plans) · [Neon regions](https://neon.com/docs/introduction/regions) · [Twilio trial limits](https://support.twilio.com/hc/en-us/articles/360036052753-Twilio-Free-Trial-Limitations) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) · [`HttpApiBuilder.toWebHandler`](https://github.com/effect-ts/effect/blob/main/packages/platform/src/HttpApiBuilder.ts) · [`@effect/sql-pg` wraps `pg`](https://registry.npmjs.org/@effect/sql-pg).

**D9 — Keep the Python schema and event contracts byte-compatible where sensible** so the review's gap matrix and the SPEC stay meaningful; migrations are rewritten as SQL files applied by a small Effect migrator (`@effect/sql` `Migrator`).

---

## 3. What "state machine is authoritative, LLM is the conversationalist" looks like in code

- `domain/state.ts`: `ConversationState` literal union; `ADJACENCY: Record<State, ReadonlySet<State>>`; `transition(current, suggested): Either<InvalidTransition, State>`; `OVERRIDES` with precedence; `TOOL_STATE_MATRIX`; `toolAllowed`.
- `domain/turn.ts`: `TurnDecision = Schema.Struct({ message, toolCall: Schema.NullOr(ToolCall), intentSatisfied, suggestedNextState: Schema.NullOr(State) })`.
- `control-plane/TurnDecider.ts`: `interface TurnDecider { decide(ctx: TurnContext): Stream<TurnChunk, TurnDeciderError> }` where `TurnChunk = TextDelta | Decision`. Layers: `ScriptedTurnDecider` (table-driven; the current Python stub's behaviour, minus its bugs, kept only for scenarios) and `OpenAITurnDecider`.
- `control-plane/Orchestrator.ts` (`processTurn`): load+lock conversation → append `USER_TURN_FINAL` (+ `heard_text` truncation note if barge-in) → `matchOverride` → if hit, deterministic branch (tools + transfer + outcome) → else stream decider; buffer message deltas out over SSE immediately; on `Decision`: `transition()` validate (reject → recover: stay in state, log `TURN_DECISION_REJECTED` event, speak safe fallback), `toolAllowed` (fail closed, event logged), execute tool in the same transaction as `TOOL_CALLED/TOOL_RESULT`, set outcome, append `STATE_TRANSITION`, `AGENT_TURN`, finalize if terminal, commit, then emit SSE trailer `{new_state, tool, outcome, end_call, speak_mode}`. **Trailer is sent only after commit** (durable-before-claim).
- Prompt builder (`control-plane/Prompts.ts`) is *used* (unlike Python): public context always; protected context + compact cross-call memory (last 5 conversations for the borrower → `{recent_outcomes, last_promise, last_callback}`) only when `protectedContextUnlocked`. Unit test asserts no protected field appears in the prompt before unlock — as a property test over all states.

Right-party verification is no longer a substring check: the `VERIFYING_IDENTITY` prompt instructs the model to call `confirm_right_party({confirmed: boolean, reason})` — a *state-scoped tool* — and only that tool flips `protectedContextUnlocked`. Third-party/wrong-party phrasings route to `record_wrong_party_contact`. The override rules stay in front of the LLM and are expanded (normalised contractions, ~15 phrases per class, unit-tested against the review's probe list).

---

## 4. Phases

Each phase ends with: tests green (`pnpm test`), typecheck clean, a commit, and a line in `docs/plans/PROGRESS.md`.

### Phase 0 — Monorepo & toolchain (S)
pnpm workspaces, TypeScript strict, ESLint (effect plugin), vitest + `@effect/vitest`, `.gitattributes` (LF), root scripts, CI (GitHub Actions: typecheck + unit tests; DB tests against a Postgres service container). **Done when:** `pnpm -r test` runs an empty suite in every package.

### Phase 1 — `packages/domain` (M)
Enums; state machine + overrides + tool matrix; `TurnDecision`, `ToolCall`, event payload Schemas (all 15 event types + `TURN_DECISION_REJECTED`, `TOOL_REJECTED`); replay reducer; transcript assembly; pre-call policy as a pure function `evaluatePreCall(input) → readonly Failure[]` (TCPA window in borrower TZ, 7-in-7, consent/validity, opt-out, active conversation, scheduled conflict); amount/date normalisation (ISO dates, `Decimal` strings). **Done when:** ≥60 unit tests incl. exhaustive adjacency table, override precedence, replay of Python-shaped event fixtures, prompt-context gating property, review probe list.

### Phase 2 — Persistence + control-plane core (L)
SQL migrations (11 tables, indexes, constraints as in SPEC §6.2/6.3, + `metrics_snapshots`, `agent_heartbeats`); `@effect/sql-pg` client Layer; repositories; `appendEvent` with per-conversation lock and monotonic `sequence_no`; `startCall` (workflow reuse, attempt increment, CALL_STARTED/GREETING/AGENT_TURN); Orchestrator with `ScriptedTurnDecider`; tools (6 + `confirm_right_party`) idempotent by `tool_call_id`; call-control signals (amd_result → VOICEMAIL flow, no_input 2-strike, barge_in, hangup/no_answer) with `action_id` idempotency; finalize + outbox enqueue in-transaction; scheduled actions (create/cancel/claim `SKIP LOCKED`/process incl. reschedule-to-next-window when TCPA fails); outbox worker (summary/evaluation/vector-stub); replay endpoint. **Done when:** the 12 mandatory scenarios (ported, plus `right-party-third-party-phrasings`, `invalid-llm-transition-recovered`, `tool-in-wrong-state-fails-closed`) pass in vitest against a real Postgres, and each asserts event-timeline shape + replay.

### Phase 3 — HttpApi + Node server + public URL (M)
`packages/contracts` HttpApi; `HttpApiBuilder` handlers; SSE turn endpoint; error mapping (`PreCallRejected`→422 with `validation_failures`, `NotFound`→404, `ConversationCompleted`→409, `Upstream`→503); in-process schedulers as supervised fibers; `apps/server` with `@effect/platform-node`; config from env (`Config`); Neon project + migrations applied; `cloudflared` tunnel config; smoke script against the public URL. **Done when:** `POST /calls/start` + `simulate_turn` + scenarios run green against the public URL; `/healthz`, `/readyz` public.

### Phase 4 — Real LLM (M)
`OpenAITurnDecider`: streaming chat completions with tools; per-state model + tool allowlist; sentence chunker; malformed/empty/refusal handling (named errors → safe scripted fallback + `TURN_DECISION_REJECTED`); Langfuse tracing (trace per conversation, span per turn with state/model/TTFT/tokens); prompt builder with cross-call memory. **Done when:** a JSON simulation of the happy path completes with GPT; leak test (no protected fields in prompts before unlock) green; latency panel shows TTFT per turn.

### Phase 5 — Voice worker (L)
`@livekit/agents` worker: dispatch by `agent_name`; room metadata → conversation; `onEnter` disclosures; `llmNode` override streaming SSE; `speak_mode` handling; `userAwayTimeout` → `no_input`; false-interruption/barge-in signals; end-call → wait playout → delete room; heartbeat to control plane; **browser call** end-to-end from the console. Then SIP: `createSipParticipant(waitUntilAnswered)` + `voice.AMD` → `amd_result` signal → voicemail script or proceed. **Done when:** one recorded browser call completes PTP with barge-in visible in the timeline; SIP call to the user's phone completes or hits voicemail correctly (if trunk configured).

### Phase 6 — Console (M)
Static app on Pages: conversations list (paginated), detail (transcript / timeline / replay / trace link), scenario runner (run all → pass matrix), live view of an in-progress call (poll or SSE), "Call me in the browser" (LiveKit JS client using the token endpoint), "Dial my phone", agent-worker liveness, metrics panel. **Done when:** an interviewer can run the whole demo from the URL without a terminal.

### Phase 7 — Hardening & docs (M)
Timeouts/retries (`Schedule`) for OpenAI, Langfuse, LiveKit API; idempotent webhooks; chaos scenario (kill worker mid-call → replay resumes); README with architecture, ADR index, demo script, cost sheet; remove `backend/` once parity is confirmed (or keep as `legacy/`).

### Stretch (only after Phase 6): Durable Object per conversation; Cloudflare Queues for outbox; semantic override safety net; post-call LLM-as-judge; Effect 4 spike branch.

---

## 5. Error & rescue registry (control plane; the shape every new codepath must fit)

| Codepath | What can go wrong | Error (typed) | Rescue | Caller sees | Logged/traced |
|---|---|---|---|---|---|
| `startCall` | policy failure | `PreCallRejected{failures}` | none | 422 + `validation_failures` | event-less; log + metric `calls_rejected{reason}` |
| `startCall` | borrower/contact missing | `NotFound` | none | 404 | log |
| `processTurn` | conversation already ended | `ConversationCompleted` | none | 409 | log |
| `processTurn` | LLM timeout / 5xx | `TurnDeciderUnavailable` | retry once (Schedule), then scripted fallback turn, state unchanged | SSE fallback text + trailer `degraded:true` | event `TURN_DECISION_REJECTED{reason}` + trace |
| `processTurn` | malformed/empty/refusal | `TurnDeciderInvalidOutput` | same as above | same | same |
| `processTurn` | invalid suggested transition | `InvalidTransition` | stay in state, safe re-prompt | trailer `degraded:true` | event `TURN_DECISION_REJECTED` |
| `processTurn` | tool not allowed in state | `ToolNotAllowed` | fail closed, no side effect | trailer | event `TOOL_REJECTED` |
| `processTurn` | tool args invalid | `ToolArgsInvalid` | fail closed | trailer | event `TOOL_REJECTED` |
| any write | Postgres unavailable | `PersistenceError` | retry (Schedule, jitter) then 503 | 503 | log + metric |
| `voice/sessions` | LiveKit API failure | `TelephonyError` | rollback DB, cleanup room/dispatch | 503 | log |
| worker `llmNode` | control plane unreachable | (worker) | say scripted apology, `hangup` signal when reachable, end | — | worker log |
| cron scheduled action | TCPA fails at due time | `PreCallRejected` | reschedule to next 8:00 local; after 3 → CANCELED with reason | — | scheduled_action payload |
| outbox job | processor throws | `OutboxJobFailed` | retry ×3 backoff → FAILED | — | log |

Silent-failure rule: no `catch → continue` without an event or a metric.

---

## 6. Deferred (tracked, not forgotten)
- TODO-1 Durable Object per conversation (stretch).
- TODO-2 Cloudflare Queues for outbox (stretch).
- TODO-3 Semantic override safety net (pgvector or embeddings API).
- TODO-4 Post-call LLM-as-judge scores → Langfuse.
- TODO-5 Effect 4 migration spike.
- TODO-6 Multi-loan borrowers (currently one loan per borrower).
- TODO-7 Auth on operator endpoints (a shared bearer token env is enough for the demo; add before sharing publicly).
- TODO-8 Always-on hosting for the voice worker (Oracle Always Free).

## 7. Risks
| Risk | Mitigation |
|---|---|
| Neon cold starts (autosuspend 5 min) add ~0.5–1 s to the first request | keep-warm ping every 4 min while demo mode is on; local Postgres for dev |
| LiveKit Build limits: 1,000 agent-session min/mo, $2.50 Inference credit (~50 min STT+TTS), 5 concurrent sessions | ample for demos; plugins for Deepgram/Cartesia keys if credit runs out |
| Public URL depends on the laptop being up | console on Pages always up; liveness indicators; Oracle Always-Free VM as the always-on option (TODO-8) |
| Workers Free 10 ms CPU cap (if the edge port is attempted) | measure with `wrangler dev`; it's a stretch, never the primary path |
| OpenAI cost | mini models for scripted states; each demo call ≈ $0.02–0.05 |
| Effect ramp / API drift | pin versions; ctx7 docs per API; small vertical slices |
| Worker offline during interview | console shows liveness; simulation + scenarios never depend on it |

## 8. Progress log
See `docs/plans/PROGRESS.md` (created in Phase 0).
