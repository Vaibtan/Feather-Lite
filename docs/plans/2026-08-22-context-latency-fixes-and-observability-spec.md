# Spec: context-miss fixes, latency wins, and Langfuse observability

2026-08-22. For the implementing session: this spec turns the findings of
`docs/plans/2026-08-22-context-memory-and-latency-research.md` (the **research doc**) into changes.
Read that document's §2 (diagnosis), §3.1–3.2, §4.1–4.4, §4.6 and §4.8 before touching code — it
carries the `file:line` evidence and primary-source citations for everything below, and this spec
does not repeat them.

**Explicitly out of scope, by the user's decision — do not implement, do not partially implement:**

- **Cross-call memory** (research §3.3): no wrap-up table, no pgvector, no external memory service.
- **Preemptive generation** (research §4.5): leave `preemptiveGeneration: { enabled: false }` and
  its comment in `apps/voice-worker/src/agent.ts` exactly as they are. No `/turn/preview` endpoint.

## Ground rules

1. **Nothing is done until it has been run.** Every phase ends with the verification listed for it.
   Report what passed and what failed, with output — never an optimistic summary.
2. **One behavioural change per commit**, reasoning in the commit message. The repo convention is to
   run the `code-review` skill on the diff before a commit lands.
3. **Verify every library API against current docs** (`find-docs` / `ctx7`) before using it — the
   pinned versions are `@livekit/agents@1.6.4`, `@livekit/agents-plugin-deepgram@1.6.4`; for
   Langfuse the current JS SDK generation must be checked, it has had major-version rewrites.
4. **Known-failing test:** `pnpm test:db` is 27/28. `packages/control-plane/test/db/workers.test.ts`
   (~line 134) pins `now = 2026-08-16T09:00:00Z`, and the calendar has passed it. Pre-existing;
   the user has not yet approved fixing it — ask before touching it, and do not count it against
   your phases. Everything else must stay green: `pnpm check` (92 domain + 27 control-plane unit),
   the other 27 DB tests including 20/20 scenarios.
5. **Voice verification** is `pnpm --filter @feather-lite/voice-worker fake-borrower` against the
   local stack (Docker Postgres + LiveKit, `STT_TTS_PROVIDER=plugins`, Deepgram STT+TTS). It must
   end `voice/sim equivalence: PASS`. Run recipes are in `README.md`; environment gotchas that will
   bite you:
   - Before any voice run: `Get-NetTCPConnection -RemotePort 7880 -State Established` must show
     exactly one Node PID (the current worker). A stale worker from an earlier session stays
     registered with the SFU and silently steals agent dispatches. Kill stale PIDs and their
     children.
   - `.env` is read once at boot — restart server and worker after any change. Never print `.env`.
   - HTTP 422 `ACTIVE_CONVERSATION` → `curl -X POST http://127.0.0.1:8080/api/demo/reset`.
   - Start long-running processes with the Bash tool + `run_in_background`; `Start-Process pnpm`
     fails on this machine.
6. **Latency A/B protocol** (research §4.8): measure before and after each latency change, one
   change at a time, with `pnpm loadtest:tier2 -- --calls 5`. N must stay ≤5 — N=10 is CPU-bound on
   this laptop and drowns the signal. Compare per-turn response latency (Phase 1 adds the metric),
   not call `durationMs`.

## Phase 0 — starting state

Check `git status` first. If the working tree still holds the uncommitted Deepgram-Aura TTS swap
(`apps/voice-worker/src/speech.ts`, `scripted-call.ts`, `package.json`, `pnpm-lock.yaml`,
`.env.example`, `README.md`) plus the research doc and this spec, commit that baseline before any
phase work — the Aura swap is verified (fake-borrower equivalence PASS on 2026-08-22) and must not
be mixed into phase commits. `skills-lock.json` may also show modified: that is a pre-existing open
item the user has not decided on — leave it unstaged.

## Phase 1 — measurement first: per-turn response latency in the harness

The composite metric *borrower-stops-speaking → first agent audio frame* does not exist yet, and
without it no latency claim in later phases is checkable. Research §4.8 locates the edit:
`apps/voice-worker/src/tracer/scripted-call.ts` already tracks `agentSpeakingAt` (≈line 183) and
`speak()` returns after playout (≈lines 212–217). Stamp a timestamp when each `speak()` returns,
diff against the next `agentSpeakingAt` transition, and report per-turn latencies in the
`fake-borrower` / `fake-borrower-fleet` summaries (and include them in the fleet's JSON output next
to the existing fields).

**Done when:** `fake-borrower` prints a response-latency line per turn and still ends
`equivalence: PASS`. Record the numbers — they are the baseline for Phases 4–5.

## Phase 2 — context-miss fixes (research §2, §3.1a+b)

The diagnosed cause: the turn prompt carries only `slice(-12)` transcript entries (~6 exchanges),
and superseded turns burn window slots with orphan borrower lines.

1. **Widen the window** — `packages/control-plane/src/services/Orchestrator.ts:483`, `slice(-12)` →
   `slice(-100)`. A whole collections call fits in the prompt (research §3.0).
2. **Exclude superseded turns from the transcript** — prefer the smaller change from research
   §3.1b: `buildTranscript` (or its call site) skips `USER_TURN_FINAL` events whose `turn_id` has a
   matching `TURN_SUPERSEDED` event. Keep T1's claim semantics untouched. Add a unit test in
   `packages/domain` (transcript) and/or a control-plane test: a superseded turn's borrower line
   does not appear in `DeciderInput.recentTranscript`.

Optional confirmation before coding, if Langfuse credentials are configured in `.env`: pull one
trace of a long call and confirm an early borrower statement is absent from the LLM input
(research §5, last-but-one bullet). Do not block on this if no traces exist yet — the static
evidence is strong.

**Done when:** new tests pass, `pnpm check` green, 20/20 scenarios still pass, and a `fake-borrower`
run ends `PASS`. If any scenario fixture asserts on transcript windowing, update it deliberately and
say so in the commit message.

## Phase 3 — cache-aligned prompt (research §3.1c)

Restructure the decider prompt in `packages/control-plane/src/llm/prompts.ts` so the OpenAI-cached
prefix survives across turns: persona + `RULES` + anything static in a leading system message;
volatile content (`CURRENT STATE`, `stateGuidance`, `local_time_description`, account facts) moved
to a short message **after** the transcript history. Two constraints from the research doc:
the cacheable prefix must exceed 1,024 tokens to cache at all, and `tools` change per state
(`toolSpecsFor`), so the cache naturally re-warms at each state transition — both are fine, just
don't fight them.

Measure instead of assuming: log `usage.prompt_tokens_details.cached_tokens` from the OpenAI
response in `LlmClient.ts` (this also feeds Phase 6) and confirm non-zero cached tokens on
consecutive turns within one state, with `TURN_DECIDER=openai`.

**Done when:** prompt-shape unit tests (there are existing prompt tests in control-plane — extend
them) pass; a live `TURN_DECIDER=openai` conversation shows `cached_tokens > 0` on a follow-up turn;
scenarios still 20/20 (they use the scripted decider and must be unaffected).

## Phase 4 — turn-detector swap: delete the deprecated text EOU path (research §4.3)

In `apps/voice-worker/src/agent.ts` (≈lines 114–116): remove the
`turnDetection: new livekitPlugin.turnDetector.MultilingualModel()` override **and** the explicit
`endpointing: { minDelay: 500, maxDelay: 3000 }` — both must go, or the old endpointing values
silently cancel the win. The session then auto-provisions the audio-native `inference.TurnDetector`
with the 300/2500 streaming defaults. Remove the now-unused `@livekit/agents-plugin-livekit` import
if nothing else uses it (check: it may still provide other pieces — verify before removing the
dependency itself).

Confirm with `find-docs` that nothing else in 1.6.4 needs to change for the local (non-Cloud)
inference path; the research doc verified the detector runs on-device via
`@livekit/local-inference` and works without LiveKit Cloud, but verify the model weights download /
cache step on first run (watch the worker log; HuggingFace cache already holds the older EOU
models).

**Done when:** worker boots with **no** deprecation warning about the text-based turn detector,
`fake-borrower` ends `PASS`, and the Phase 1 metric shows the before/after per-turn latency at
N≤5 (expected ~200 ms improvement from endpointing alone; report whatever is actually measured,
including a regression if that is what the numbers say).

## Phase 5 — Deepgram Flux `STTv2` (research §4.4), gated on validation

Swap the STT construction in `apps/voice-worker/src/speech.ts` (plugins branch) from
`new deepgram.STT({ model: "nova-3", ... })` to the already-installed `STTv2` (Flux,
`flux-general-en`). Verify the exact constructor options against the installed
`@livekit/agents-plugin-deepgram/dist/stt_v2.d.ts` and current Deepgram/LiveKit docs (`find-docs`)
— including how Flux's built-in end-of-turn interacts with the Phase 4 auto-provisioned detector
(the framework may need the detector disabled or set to STT-driven mode when the STT itself emits
turn boundaries; the docs, not assumptions, decide this).

Do **not** touch `eagerEotThreshold` — the eager path only feeds preemptive generation, which is
out of scope.

This is a model swap, so it is gated: run `fake-borrower` at least 3 times and `loadtest:tier2 --
--calls 5` once; all runs must be equivalence-green (STT accuracy regressions show up as failed
tool paths or wrong outcomes). If Flux fails equivalence repeatedly, revert the swap, keep the
findings in the phase report, and leave nova-3 in place — Phase 4 alone is still a win.

**Done when:** either (a) Flux is in with 3/3 + fleet green and measured before/after latency, or
(b) a documented revert with the failure evidence. Both are acceptable outcomes; pretending (a)
happened when (b) did is not.

## Phase 6 — Langfuse observability, monitoring, and telemetry

Goal: every real call produces one coherent, inspectable trace, and the latency components from
research §4.2 are captured per turn instead of scattered across log lines.

1. **Audit what exists.** The control plane already has Langfuse tracing (grep
   `packages/control-plane` for it; `README.md` and `.env.example` name the env keys). Map what is
   currently emitted (spans? generations? which attributes?) before adding anything.
2. **Verify the SDK generation.** Check the installed Langfuse package version against current
   Langfuse docs via `find-docs` — the JS SDK moved to an OpenTelemetry-based architecture in a
   major release; do not write against the wrong generation's API. If an upgrade is warranted,
   propose it to the user first (scope decision), otherwise build on the installed version.
3. **Trace shape.** One Langfuse trace (or session) per `conversation_id`; per turn: a span for the
   three-phase turn with `state`, `tool`, `outcome`, `superseded` attributes; a nested generation
   for the OpenAI call carrying model, prompt/completion tokens, and the
   `cached_tokens` figure from Phase 3; TTFT as the generation's completion-start. The scripted
   decider path should stay traceable (cheap spans, no generation) so load tests produce traces
   too — but check with the user before letting `loadtest:tier1 --concurrency 100` flood Langfuse;
   consider sampling or an env kill-switch (`LANGFUSE_ENABLED=false` or equivalent) as part of this
   phase.
4. **Worker-side telemetry.** The worker already logs `eou_metrics` (`endOfUtteranceDelayMs`,
   `transcriptionDelayMs`) and `tts_metrics` (`ttfbMs`) at `apps/voice-worker/src/agent.ts:132-137`,
   and `ttft_ms` already rides every `turn_end` frame and is persisted in
   `conversation_turns.result`. Close the loop: send the per-turn EOU/STT/TTS numbers to the
   control plane (the worker already talks to it every turn — piggyback on an existing call or the
   heartbeat path rather than inventing a new channel) and persist them next to `ttft_ms`, so one
   row holds the full per-turn latency decomposition: EOU delay, transcription delay, decide TTFT,
   TTS TTFB. Attach the same numbers to the turn's Langfuse span.
5. **Surface it.** With the decomposition persisted, add the latency waterfall to the console —
   `README.md` lists "latency waterfall panel" under *Not built*; this phase builds it. Keep it
   simple: per-turn stacked bars for a selected conversation on the existing transcript/timeline
   view or Status page, reading from a small API endpoint over the persisted turn metrics. If this
   panel looks like it will balloon, stop and ask the user how much console work they want.

**Done when:** a `fake-borrower` run produces a Langfuse trace showing the full turn tree with the
latency attributes and non-null `cached_tokens` (when `TURN_DECIDER=openai`); the per-turn latency
decomposition is queryable in Postgres for that conversation; the console shows the waterfall for
it; `pnpm check` and scenarios remain green. If no Langfuse credentials are present in `.env`, ask
the user for them before this phase — do not stub it out and call it done.

## Reporting

- Update `docs/plans/PROGRESS.md` with a row for this work, and the `README.md` status table
  honestly (measured numbers, not the research doc's expectations; move "latency waterfall panel"
  out of *Not built* only if Phase 6 step 5 actually shipped).
- If the decider prompt contract changed materially (Phase 3) or the STT model changed (Phase 5),
  consider a short ADR via the `domain-modeling` skill; ADR 0006 is the template for tone.
- Final summary to the user: per phase — what changed, what was measured (before/after), what was
  deviated from or reverted, and what remains open.
