# ADR 0008 — Playout truth, cross-call memory, and three measured rejections

- Status: accepted (2026-08-23)
- Related: [ADR 0003](0003-three-phase-turn-transaction.md),
  [ADR 0006](0006-self-hosted-livekit-for-local-dev.md),
  [ADR 0007](0007-prompt-shape-observability-and-the-flux-revert.md);
  research `docs/plans/2026-08-22-context-memory-and-latency-research.md`

## Context

An overnight verification pass ran the full voice pipeline repeatedly against the new Langfuse
waterfall and found two real defects the previous session's four clean runs had never surfaced, plus
three optimization hypotheses that the instrumentation could now answer instead of leaving to
argument. Everything below was decided by a measured run, and the numbers are in the commit messages
of the changes they justify.

## Decision 1 — the harness speaks the reference's semantics, and the prompt stops contradicting itself

The first live failure was not a bug in the pipeline at all. The scripted borrower barged in with
"I can pay on Friday" while the simulation reference line is "I can pay **550** on Friday" — so
voice/sim equivalence silently depended on GPT-4.1 inferring an unstated amount. The prompt made
that a coin flip by demanding both "(or a date with the full balance implied): propose" and "If they
only give a date, ask what amount. Do not guess." On the failing run the model chose to clarify — a
perfectly compliant reading — and the scripted borrower, deaf to questions, let the call die through
two no-input strikes as NO_ANSWER.

Three positions fell out of this:

- **Equivalence tests the pipeline, not the model's tolerance for underspecified input.** The
  borrower now speaks the same amount+date the reference carries. A harness line that only passes
  when the LLM guesses generously is a flake, not a test.
- **The product behavior is decided, not left ambiguous**: a date-only offer to pay proposes the
  full balance. The read-back + explicit-yes confirmation is the safety net that makes this not
  "guessing" — the borrower hears the exact amount and date and must say yes before anything is
  recorded. It also saves a full turn on the common path.
- **The harness answers a clarifying question once** ("The full balance. 550 dollars.") instead of
  timing out, because an extra DISCUSSING_PAYMENT turn changes neither the state path nor the tool
  sequence — the equivalence contract is unchanged, and a real borrower would answer.

## Decision 2 — playout truth comes from the audio pipeline, not the chat item

The second failure was silent in the worst sense. The read-back turn produced **zero audio**: the
Deepgram TTS plugin opens a fresh websocket per synthesis and awaits "open" with no timeout, so a
hung connect blocked until the framework's 10 s watchdogs force-closed the speech. The framework
then handed over a chat item that looked played-in-full — `interrupted: false`, full text — and the
worker reported exactly that. The ledger recorded the borrower as having heard a read-back that was
never spoken, which is precisely the state the fully-heard guard exists to prevent, fed to it by its
own reporter.

Two changes, one policy:

- **A pnpm patch** gives the plugin's websocket connect a 4 s timeout that rejects with
  `APITimeoutError` — an `APIError` with `retryable: true`, so the framework's existing retry loop
  (maxRetry 3, first retry at 100 ms) turns a stall into a ~5 s-worst-case recovery instead of 53
  seconds of silence.
- **The worker cross-checks the chat item against `tts_metrics`.** A turn whose TTS never produced
  a first byte is reported as `heard_text: "", interrupted: true`, which routes into the guard's
  existing recovery: reject the confirmation, repeat the read-back.

The policy has a measured exemption: **interrupted items are trusted as-is**. A barge-in aborts the
TTS stream, and the instrumented run showed its `tts_metrics` arriving only *after* the truncated
item is reported — the first version of this fix gated on metrics for those too and regressed every
barge-in's heard-text to empty. The item's playback-truncated text is already the audio truth for an
interruption; the metrics check exists for the one case the framework gets wrong, the
uninterrupted-looking stall.

Known residual, documented rather than fixed: `reportPlayout` attributes items by `currentTurnId`
at delivery time, so an item delivered after the next turn's `llmNode` has run would be attributed
to the wrong turn. Eight instrumented runs all showed the safe ordering (item first, next turn
second), and the `llmNode` barge-in fallback covers the other order; a per-item turn mapping is the
clean fix if this ever fires.

## Decision 3 — cross-call memory is a ledger projection in the row that already flows

`buildMemoryBlock` reduced five prior conversations to outcome enums plus one promise. What a
collector needs on attempt #3 — what the borrower said, what they disputed or claimed, what they
promised — was all already in the ledger, so the research's §3.3 Postgres-native route was built as
is: the SUMMARY outbox job (which already walks the events post-call) persists a `wrap_up` into
`conversations.final_outcome_metadata`, the jsonb that already flows through `priorConversations`
into the memory block. No migration, no second database, no LLM extraction, nothing on the live
turn's critical path, and the memory stays behind the right-party gate like the rest of the
metadata. A pure `priorCallNote()` renders one clamped line per prior call; dispute and hardship
lines quote the borrower verbatim from the `transcript_excerpt` the override path already stored.

The in-call twin (§3.2 `call_facts`) was deliberately **not** built: with the window at 100 entries
a 60–90 s call fits in the prompt whole, so the projection would duplicate what the transcript
already provides. External memory services stay rejected per §3.4 (their own docs put ingestion
minutes out-of-band, which cannot serve a next call placed 20 minutes later, let alone this one).

## Decision 4 — three hypotheses closed by measurement

- **Speculative preemptive generation: rejected.** The research ranked it #3 expecting to overlap
  the LLM call with "the remaining endpointing wait". The waterfall says that window barely exists
  on this stack: the audio-native turn detector commits ~80–150 ms after the final transcript on
  single-fragment turns, and multi-fragment turns (every barge-in) would preempt on partial text
  and be discarded — a wasted ledger-visible call. The read-only `/turn/preview` design stays the
  correct shape if the window ever widens (e.g. a slower STT), but building it tonight would have
  bought ~150 ms for a new consistency surface.
- **`queueSizeMs` 1000 → 200: rejected.** The 1.7.0 changelog's "prebuffer" wording suggested the
  1.6.4 room-audio queue delays onset by up to a second. Measured: no change (mean 3202 ms vs
  3027–3646 ms baselines). The queue is a ring-buffer bound against frame discard, not an onset
  delay. Reverted.
- **Cache-floor prefix: kept, with an honest claim.** The persona grew three state-independent
  sections (compliance, speaking style, tool discipline — real guidance, and the speaking-style
  rules are genuinely wanted) putting the tools+persona prefix past OpenAI's 1,024-token floor, and
  `prompt_cache_key` moved from the conversation id to `decider:<state>` because the key routes to
  a cache shard and per-conversation keys scattered byte-identical prefixes across shards.
  Measured: the next call's GREETING turn now reuses the prefix (`cached_tokens` 1024,
  cross-conversation); deeper turns still miss because `tools` change per state; and cached
  requests showed **no TTFT improvement** at these prompt sizes. The claim is cost (0.75× on cached
  input) and early engagement — not latency. Decide-latency variance on identical prompts was
  0.8–4.6 s; OpenAI's tail, not prefill, owns the turn's worst case.

## Open measurement question

Tonight's tier-2 N=5 fleet ran p50 3039 ms / p95 3916 ms against the 2145 ms p50 recorded on
2026-08-23 daytime, with per-stage numbers (EOU ~580, decide 0.8–1.4 s, TTS TTFB ~400) individually
similar to before. The new first-audio metric (RMS onset) confirms the transcript-based measurement
tracks real audio within ~100 ms, so the gap is real but unattributed — candidates are provider-side
nighttime latency and the six extra Docker services now running. Re-measure in daytime conditions
before treating either number as the baseline.
