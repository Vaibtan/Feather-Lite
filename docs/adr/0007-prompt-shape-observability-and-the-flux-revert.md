# ADR 0007 — Prompt shape, per-turn observability, and why Flux was reverted

- Status: accepted (2026-08-23)
- Related: [ADR 0001](0001-conversation-loop-in-the-control-plane.md),
  [ADR 0003](0003-three-phase-turn-transaction.md),
  [ADR 0006](0006-self-hosted-livekit-for-local-dev.md);
  spec `docs/plans/2026-08-22-context-latency-fixes-and-observability-spec.md`;
  research `docs/plans/2026-08-22-context-memory-and-latency-research.md`

## Context

Two complaints drove this pass. The agent periodically lost track of things said earlier in the same
call, and nobody could say where the milliseconds between "borrower stops speaking" and "agent
starts talking" actually went.

The first had a one-line cause: the turn prompt carried `slice(-12)` transcript entries, about six
exchanges, with no summarisation anywhere. Structured state survived; everything the borrower said in
free text did not. The second was not a mystery so much as an absence — the components were all
being measured (the worker logs end-of-utterance and transcription delay and TTS time-to-first-byte;
the control plane records decide TTFT) and none of them were ever brought together.

Fixing either one meant deciding three things that outlast the fix.

## Decision 1 — the prompt is ordered for the cache, and the ledger is not rewritten to suit it

The decider prompt is now:

```
[0]    system   persona + phone manner + RULES     identical on every turn
[1..n]          the transcript so far              append-only
[n+1]  system   state, guidance, time, account     rewritten every turn
[n+2]  user     what the borrower just said
```

The volatile block used to be message #0, carrying `CURRENT STATE` and a local time rendered down to
the minute — so the cacheable prefix collapsed every time the minute rolled over. OpenAI caches on
exact prefix matches and says to put static content first and variable content last
(<https://developers.openai.com/api/docs/guides/prompt-caching>). This layout does that, and
everything before the volatile block now only grows.

Measured, not assumed: `cached_tokens` reaches 1792 then 1920 on follow-up turns of a long call, and
stays 0 on short ones, whose whole prompt never reaches OpenAI's 1,024-token floor. `prompt_cache_key`
(the conversation id) is set because a probe showed it decides whether caching engages at all at this
call length — without it the cache took four turns to warm, with it two.

The window itself went from 12 entries to 100, which is the whole call. A collections call is 52–90 s
and a pathological one is one to two thousand transcript tokens, against a 1,047,576-token context.
Retrieval for *in-call* memory would be solving a problem this system does not have.

The second half of that decision matters more. Superseded turns leave orphan borrower lines — the
three-phase turn appends `USER_TURN_FINAL` in T1 and only detects supersession in T2, so a barge-in
leaves a borrower line with no agent reply after it. Those lines are excluded **from the decider's
transcript only**. The console transcript and the outbox summary still show them, because the
borrower did say those words and the ledger is a record of the call, not an input to the model.
Rewriting history to improve a prompt is the wrong trade in a regulated domain.

## Decision 2 — one turn, one span, and the trace waits for the whole waterfall

Tracing moved to the current Langfuse JS SDK generation (`@langfuse/tracing` + `@langfuse/otel` v5,
OpenTelemetry-based). The unscoped `langfuse` v3 package the code used is the legacy SDK by the
vendor's own README. The shape is one Langfuse session per conversation, one span per three-phase
turn carrying `state` / `tool` / `outcome` / `superseded`, and a nested generation per model call
with tokens and `cached_tokens`.

The load-bearing decision is that **a turn's span is not emitted when the turn ends.** Half the
latency decomposition is measured by the voice worker and reported afterwards (end-of-utterance
delay, transcription delay, TTS time-to-first-byte), so emitting at `turn_end` would publish a span
that is missing the part anyone would open it to see. A turn is buffered until its worker metrics
arrive, or until the call ends by any path — a turn, a no-input strike, a hangup or no-answer
signal. Start and end times are recorded explicitly, so deferring emission distorts nothing.

Consequences worth stating plainly:

- Every path that ends a call has to release the buffer. Missing one does not lose a span loudly; it
  leaves it buffered until the process exits, which on a long-running server means never. That is
  why `finalizeTracingIfEnded` is applied to `processSignal` and `processNoInput` as well as the
  turn path.
- The buffer is bounded (500 turns, oldest flushed first). An observability buffer must not be able
  to become a memory leak in the process that serves calls.
- Tracing failures are caught and logged and never reach the call, which is the same rule the
  previous implementation had and the one worth keeping.

The worker's numbers reach the control plane as a `turn_metrics` signal — an existing channel, not a
new one — and are merged into `conversation_turns.result` next to `ttft_ms`, so one row holds the
whole waterfall and the console can draw it without talking to Langfuse at all.

A related bug fell out of this: TTFT was computed as `Date.now() - startedMs` where `startedMs` came
from the Effect clock, which `VirtualClock` shifts for seeded history and scenarios. Real timestamp
minus virtual timestamp gave seeded rows a "TTFT" of several days. Ledger timestamps stay on the
virtual clock; elapsed time is now measured on the wall clock.

## Decision 3 — nova-3 stays; Deepgram Flux was tried and reverted

Deepgram Flux (`STTv2`, `flux-general-en`) folds end-of-turn into the transcription model and is
vendor-documented as saving 200–600 ms. It was implemented with the STT-driven turn detection its
docs require (`turnDetection: "stt"`, `endpointing: { minDelay: 0 }`) and **reverted**.

Transcription accuracy was not the problem — every scripted line came back verbatim. The problem was
timing against a rule this system deliberately has. With Flux the borrower's confirmation turn was
committed before the non-interruptible read-back had finished playing, so the fully-heard guard
correctly refused to record a promise the borrower had not heard in full: `TOOL_REJECTED`
`INVALID_ARGS`, the agent repeated the read-back, and the call ended `FAILED` instead of
`PROMISE_TO_PAY`. Four runs out of four, including one with `minDelay: 300`, which rules out the
endpointing as the cause.

The guard is not negotiable — it is the thing that stops the system recording a commitment the
borrower did not make — so the STT that races it loses. Revisiting Flux means first deciding how a
turn that arrives during a non-interruptible segment should be held, which is a design question about
the read-back, not a model swap.

## Consequences

- The decider prompt has a contract now: message 0 is stable, the volatile block is second-to-last,
  and the borrower's current line is last. Anything added to the prompt has to choose a side, and
  putting a per-turn value in message 0 silently costs the cache.
- Turn spans are eventually-emitted, not immediately-emitted. Reading Langfuse during a live call
  shows the turn one step behind; the ledger does not lag.
- Cross-call memory and preemptive generation were explicitly out of scope for this pass and remain
  unbuilt; research §3.3 and §4.5 are the standing write-ups.
