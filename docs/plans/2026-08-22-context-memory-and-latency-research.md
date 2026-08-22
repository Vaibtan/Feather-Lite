# Context misses and end-to-end latency — research findings

2026-08-22. Scope: two questions against the v2 TypeScript tree as it stands at `4da5df3`.

1. During real browser calls the agent **periodically loses track of things said earlier in the
   same call**. Why, and what fixes it?
2. Where do the milliseconds go between *borrower stops speaking* and *agent audio starts*, and
   which knobs are worth turning?

Conventions: every codebase claim cites `file:line`; every external claim cites a primary source
(vendor docs, or the installed SDK's own type/source files, which are shipped by the vendor and are
the authority for the version actually pinned here — `@livekit/agents@1.6.4`,
`@livekit/agents-plugin-deepgram@1.6.4`, per `apps/voice-worker/package.json:22-25`).

---

## 1. Problem statement

The turn prompt is assembled server-side. `apps/voice-worker/src/feather-agent.ts:123-149` overrides
`llmNode` and deliberately sends the framework almost nothing: it reads only the last user message
and the previous assistant message out of `chatCtx`, then POSTs `{turn_id, user_text, playout}` to
the control plane. The comment at `feather-agent.ts:124-125` states the intent plainly — "the control
plane owns the conversation history". So *all* in-call memory is whatever
`packages/control-plane/src/services/Orchestrator.ts` chooses to put in the prompt. If the agent
forgets something, it was dropped there.

---

## 2. Diagnosis

### 2.1 Primary cause — the transcript is hard-windowed to 12 entries, with no summarization

`packages/control-plane/src/services/Orchestrator.ts:483`:

```ts
const transcript = buildTranscript(t1.events).slice(-12).map((e) => ({ speaker: e.speaker, text: e.text }));
```

That array becomes `DeciderInput.recentTranscript` (`Orchestrator.ts:501`,
`packages/control-plane/src/services/types.ts:23-24`), and
`packages/control-plane/src/llm/prompts.ts:125` maps it one-for-one into the chat messages that
follow the system prompt. Nothing else carries in-call dialogue.

`buildTranscript` (`packages/domain/src/transcript.ts:31-53`) emits **one entry per speaker turn** —
`USER_TURN_FINAL` → BORROWER, `AGENT_TURN` → AGENT. Entries therefore alternate, so
`slice(-12)` is roughly **six exchanges**. The opening Mini-Miranda is itself entry #1 (appended as
an `AGENT_TURN` with `turn_id: "opening"`, `Orchestrator.ts:773`), so it falls out of the window
almost immediately.

There is no summarization anywhere. The only compaction in the codebase is `buildMemoryBlock`
(`packages/domain/src/context.ts:95-118`), and it summarizes **prior conversations**, not the
current one — it reads `final_outcome`, `ended_at`, and `final_outcome_metadata` off completed rows
fetched by `conv.priorConversations({... limit: 5 })`
(`packages/control-plane/src/services/ContextBuilder.ts:66`). It never touches the live call.

What *does* survive past 12 entries is only the structured slots the domain model happens to have:
`state`, `pendingProposal`, `context` (public/protected/memory), `heardAgentText`
(`types.ts:13-29`). Everything the borrower says that does not land in one of those slots —
"I get paid on the 15th", "my hours got cut", "don't call me before six", "I already disputed this
with your colleague" — exists **only** in the transcript array. Past six exchanges it is gone, and
the model cannot recover it.

This matches the reported symptom precisely, including the word *periodic*: short calls never
exhibit it, and long calls only lose the free-form facts, never the state machine or the proposal.

### 2.2 Amplifier — superseded turns burn window slots and leave orphan borrower lines

`apps/voice-worker/src/feather-agent.ts:149` always sends `supersede: true`. On the control-plane
side the three-phase turn appends `USER_TURN_FINAL` **in T1**, right after claiming the turn
(`Orchestrator.ts:443-454`), before the LLM is called. Supersession is only detected later, in T2
(`Orchestrator.ts:534-538`), which finishes the turn as `SUPERSEDED` and returns `null` — **without
ever appending a matching `AGENT_TURN`**.

Consequence: every superseded turn permanently contributes one BORROWER entry to
`buildTranscript` with no agent reply after it. Under a burst of barge-in the prompt therefore sees
several consecutive borrower lines, each consuming one of the twelve slots, and the *effective*
conversational memory drops well below six exchanges exactly when the call is most chaotic. This is
the mechanism that makes an otherwise-steady 12-entry window feel intermittent.

### 2.3 Contributing — barge-in rewrites agent history down to what was heard

`packages/domain/src/transcript.ts:41-49` prefers the played-out text over the generated text when a
turn was interrupted: `text: playout?.interrupted ? playout.heard_text : e.payload.text`. That is
the right call for a truthful ledger (and ADR 0003 depends on it), but it means the agent's own
context also loses the tail of any interrupted line — including the second half of two-part
questions like "what amount, and by what date?" (`prompts.ts:76`). Separately, `heardAgentText` is
only ever computed for the **immediately preceding** agent turn (`Orchestrator.ts:486-491`,
rendered at `prompts.ts:114`), so older truncations leave no trace that anything was cut.

### 2.4 Contributing — cross-call memory and account facts are gated off in early states

`packages/domain/src/context.ts:70-81` (`visibleContext`) nulls both `protectedContext` and `memory`
unless `protectedContextUnlocked && PROTECTED_CONTEXT_STATES.has(state)`, and
`PROTECTED_CONTEXT_STATES` is only `{DISCUSSING_PAYMENT, CONFIRMING_OUTCOME}`
(`packages/domain/src/stateMachine.ts:68-71`). This is a deliberate FDCPA control and should stay,
but it does mean that during `GREETING`/`VERIFYING_IDENTITY` the model has no memory of prior calls
at all, which can read as "it forgot" to a borrower it spoke to last week.

### 2.5 Considered and largely ruled out — interim/final STT mismatch dropping turns

Worth stating because it *was* real, in a different configuration. ADR 0006 records
`transcriptionDelayMs` of 5137 / 10504 / 18239 ms under LiveKit Inference STT, against 200–500 ms
for direct Deepgram (`docs/adr/0006-self-hosted-livekit-for-local-dev.md:91-95`); at those delays
the 12 s `userAwayTimeout` fired first and whole turns were scored as silence. That is why
`STT_TTS_PROVIDER=plugins` exists (`apps/voice-worker/src/speech.ts:42-48`). In `plugins` mode the
Deepgram STT plugin runs with `interimResults: true`, `endpointing: 25`, `noDelay: true`
(plugin defaults, `@livekit/agents-plugin-deepgram/dist/stt.js:16-33`) and turns are committed
normally. Also, preemptive generation is off (`apps/voice-worker/src/agent.ts:118`), so `llmNode`
fires once per *confirmed* turn only — there is no interim-text path that could inject a partial
utterance. Verdict: not the current cause, but §2.2 shows the ledger is still sensitive to
turn churn.

### 2.6 Verdict

**The evidence favours §2.1 — the fixed 12-entry window with no summarization — amplified by §2.2.**
The fix is cheap and local; see §3.

---

## 3. Axis 1 — context and memory

### 3.0 Sizing the problem first

A collections call is short: SPEC's happy path is `GREETING → VERIFYING_IDENTITY →
DISCUSSING_PAYMENT → CONFIRMING_OUTCOME → ENDING`, and the tier-2 fleet measured p50 call duration
of 52–90 s (`docs/loadtest/README.md`, Tier 2 table). Even a pathological 30-turn call is on the
order of one to two thousand tokens of transcript. gpt-4.1's context window is 1,047,576 tokens
(<https://developers.openai.com/api/docs/models/gpt-4.1>). **The entire call fits in the prompt with
four orders of magnitude to spare.** Any retrieval mechanism for *in-call* memory is therefore
solving a problem this system does not have. That single fact should drive the ranking below, and
it is the honest answer to "should we add a memory layer for this?".

### 3.1 Quick fix — raise the window, drop orphan turns, and cache-align the prompt

Three edits, all inside `Orchestrator.ts` / `prompts.ts`:

**(a) Widen or remove the window.** `Orchestrator.ts:483` — `slice(-12)` should become something
like `slice(-100)`, i.e. effectively the whole call. Cost: ~1–2k prompt tokens on a long call.
At gpt-4.1's $2/M input rate (<https://developers.openai.com/api/docs/models/gpt-4.1>) that is
fractions of a cent per turn. This alone removes the reported symptom.

**(b) Stop letting superseded turns pollute the transcript.** Either move the `USER_TURN_FINAL`
append out of T1 into T2 (so it only lands for turns that actually complete), or have
`buildTranscript` skip `USER_TURN_FINAL` events whose `turn_id` has a `TURN_SUPERSEDED` event
(`Orchestrator.ts:432`). The second is a smaller, safer change and keeps T1's claim semantics
intact.

**(c) Restructure the prompt for OpenAI prompt caching.** Today the system message is message #0 and
is *volatile*: it embeds `CURRENT STATE`, the per-state `stateGuidance` block, and
`local_time_description` (`prompts.ts:104-107`), which is rendered down to the **minute** by
`ContextBuilder.describeLocalTime` (`ContextBuilder.ts:27-45`). OpenAI caches only exact prefix
matches, and explicitly instructs: "Place static content like instructions and examples at the
beginning of your prompt, and put variable content, such as user-specific information, at the end"
(<https://developers.openai.com/api/docs/guides/prompt-caching>). Because the volatile content sits
in message #0, the cacheable prefix collapses to zero every time the minute rolls over or the state
changes. Moving the persona + `RULES` block into a stable leading system message, and pushing state
/ time / account into a short message appended *after* the history, makes the prefix
append-only and cache-friendly.

Two honest caveats on (c): OpenAI **does not publish a latency-reduction figure** for prompt caching
— the guide quantifies only cost (cached input billed at 0.1× the uncached rate, cache writes at
1.25×) and describes the latency benefit qualitatively. And caching requires ≥1,024 tokens of prefix
(same page); the static system text plus the tool schemas
(`prompts.ts:44-51`, `packages/domain/src/tools.ts:85-98`) is in that neighbourhood but not
comfortably above it, so measure `usage.prompt_tokens_details.cached_tokens` before claiming a win.
Note also that `tools` must be byte-identical to stay in the prefix (same page), and
`toolSpecsFor(state, ...)` changes them per state — so caching will naturally re-warm at each state
transition regardless.

### 3.2 Medium — a structured in-call fact block (the honest "production" answer at this scale)

Rather than summarizing prose, extend the thing the architecture is already good at: the ledger.
Today the only in-call structured state reaching the prompt is `pendingProposal`
(`types.ts:22`, `Orchestrator.ts:500`). A small `call_facts` projection — hardship stated,
disputed y/n, preferred callback window, stated pay date, third party present — written as events in
T2 alongside `TOOL_RESULT` (`Orchestrator.ts:404`) and rendered as a few deterministic lines in the
system prompt, would make the important facts *immune* to any window and auditable in the ledger.
This is strictly better than LLM summarization for a regulated domain: it is deterministic,
replayable through `packages/domain/src/replay.ts`, and testable in the existing
`packages/control-plane/test/` suites.

Rolling LLM summarization is the conventional alternative and is **not** recommended here: it adds a
second model call to the turn's critical path (or a stale async one), it is non-deterministic in a
compliance context, and per §3.0 it compresses something that already fits.

### 3.3 Production-grade — cross-call memory, where a real gap does exist

The genuine memory gap in this system is **across calls**, not within one. `buildMemoryBlock`
(`context.ts:95-118`) currently reduces the last five conversations to: a list of outcome enums, the
last promise amount/date, the last callback timestamp, and the last right-party-contact date. That
is thin for collections. What a collector actually needs on attempt #3 is: *what the borrower said
last time*, whether they disputed, what hardship they claimed, what they promised and whether they
broke it.

Two credible routes, in increasing cost:

- **Postgres-native, no new infrastructure.** The events are already there
  (`conv.listEvents`, `buildTranscript`), so a per-conversation wrap-up record — outcome plus a
  handful of extracted facts, written once at `finalize` — is a batch job on the existing ledger and
  costs the live turn nothing. If free-text recall over prior calls is later wanted, pgvector over
  stored transcripts is the incremental step and stays inside the existing `@effect/sql-pg` stack.
- **A dedicated memory service.** See §3.4.

### 3.4 External memory layers — assessment

**The decisive finding: none of these can serve as in-call memory, by their own documentation.**
Zep states that "turns are ingested and knowledge is extracted asynchronously, so facts from the
current turn are not searchable within that same turn", and that "ingestion can take a few minutes"
(<https://help.getzep.com/retrieving-memory>, <https://help.getzep.com/v3/ecosystem/livekit-memory>).
Graphiti's `add_episode` docstring instructs callers to run it out-of-band — "It is recommended to
run this method as a background process, such as in a queue"
(<https://github.com/getzep/graphiti>, `graphiti_core/graphiti.py`). So for §2's symptom — the agent
forgetting something said 90 seconds ago on the *same call* — these systems are architecturally
incapable of helping. That settles axis 1's main question.

**Zep / Graphiti.** Graphiti is a Python temporal knowledge-graph library
(<https://github.com/getzep/graphiti>). It requires a graph store — Neo4j 5.26, FalkorDB 1.1.2, or
Amazon Neptune + OpenSearch Serverless; Kuzu is documented as deprecated. **There is no Postgres
path**, so adopting it means standing up a second database next to the existing `@effect/sql-pg`
ledger. It is **Python-only** — no official TS/JS SDK for Graphiti itself; the README's own
comparison table attributes Python/TypeScript/Go SDKs to *Zep*, the hosted product, not to Graphiti
(<https://github.com/getzep/graphiti#zep-vs-graphiti>). Ingestion calls an LLM several times per
episode (node extraction, dedup, edge extraction, contradiction resolution); **no ingestion latency
or cost figure is published**. The temporal model is the genuinely interesting part and is a good
conceptual fit for collections: edges carry `valid_at` / `invalid_at` / `expired_at`, and a
superseded fact is invalidated rather than deleted (`graphiti_core/edges.py`), which is exactly the
shape of "promised $200 on Aug 1, superseded by $150 on Aug 15, disputed on Aug 20".

Hosted Zep does have an official TypeScript SDK, `@getzep/zep-cloud`
(<https://help.getzep.com/adding-memory>), and returns a prompt-ready "Context Block" string from
`thread.getUserContext(threadId)` with a published **P95 < 200 ms** retrieval latency
(<https://help.getzep.com/retrieving-memory>) — vendor-authored. Zep also publishes a LiveKit
integration, but it is **Python-only** (`zep-livekit`,
<https://help.getzep.com/v3/ecosystem/livekit-memory>), so it is not reusable from this TS worker.
Zep's headline benchmark (2.58–3.20 s vs 28.9–31.3 s full-context, arXiv:2501.13956) is
vendor-authored and measured against long multi-session histories, not a 60-second call — it does
not transfer to this system.

**mem0.** Official npm package `mem0ai`, actively maintained, with documented parity quirks vs
Python (<https://docs.mem0.ai>). The important recent change: after the v3 rewrite, **graph memory
was removed from the open-source SDK and is now a hosted-Platform-only feature**, along with
Temporal Reasoning and Memory Decay (<https://docs.mem0.ai/platform/platform-vs-oss>,
<https://docs.mem0.ai/migration/oss-v2-to-v3>). The OSS write path is now single-pass ADD-only —
"one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten" — which removes the
supersession semantics that make it interesting for broken promises. Published p50 latency for the
new pipeline is 0.88–1.09 s; **no p95 is published** for it. All figures vendor-authored.

**LiveKit's own position.** There is no official LiveKit memory guide. The only mention anywhere on
docs.livekit.io is a single bullet on the External data and RAG page —
"**Mem0**: Self-improving memory layer for AI agents" — with no LiveKit-authored sample
(<https://docs.livekit.io/agents/logic/external-data/>). Zep is not mentioned on docs.livekit.io at
all. Both vendors' LiveKit integration guides live on their own sites, not LiveKit's.

**pgvector**, by contrast, is v0.8.6, supports HNSW (`USING hnsw (embedding vector_l2_ops) WITH
(m = 16, ef_construction = 64)`, query-time `hnsw.ef_search` default 40), and documents the tradeoff
as "better query performance than IVFFlat… but has slower build times and uses more memory"
(<https://github.com/pgvector/pgvector>). It runs inside the Postgres this project already operates.

**Conclusion.** For in-call memory: not applicable, per the vendors' own async-ingestion docs. For
cross-call memory: the honest engineering answer at this scale is a structured wrap-up table plus
optional pgvector recall (§3.3), because it avoids a second database, avoids per-turn LLM extraction
cost, and — decisively for collections — avoids the multi-minute ingestion lag that would lose a
promise-to-pay made 20 minutes before the next attempt dials. The right way to carry this into a
design discussion is to name Graphiti's bi-temporal `valid_at`/`invalid_at` edge-invalidation model
as the correct *conceptual* answer for supersession, and then explain why a `superseded_by` column
buys the same semantics here without the Neo4j dependency and the Python boundary.

### 3.5 Ranked recommendation

| Rank | Change | Effort | Effect on context misses |
|---|---|---|---|
| 1 | Widen `slice(-12)` (§3.1a) | one line | removes the primary cause |
| 2 | Exclude superseded `USER_TURN_FINAL` from the transcript (§3.1b) | small | removes the amplifier |
| 3 | Cache-align the prompt (§3.1c) | moderate | no memory effect; cost + latency hygiene |
| 4 | Structured `call_facts` projection (§3.2) | medium | makes key facts window-proof and auditable |
| 5 | Richer cross-call wrap-up in `buildMemoryBlock` (§3.3) | medium | fixes the *real* memory gap |
| — | External graph/vector memory service (§3.4) | high | **not recommended** — cannot serve in-call memory at all (async ingestion), and loses to Postgres on cross-call at this scale |

---

## 4. Axis 2 — end-to-end latency

### 4.1 What is already optimal (verified, so it is not re-recommended)

- **LLM is streamed.** `packages/control-plane/src/llm/LlmClient.ts:62-98` sets `stream: true` and
  normalizes content and tool-call argument deltas; `OpenAITurnDecider` emits `TextDelta` chunks as
  they arrive (`OpenAITurnDecider.ts:64-92`) and the orchestrator forwards them as `delta` frames
  (`Orchestrator.ts:513-516`) into the `ReadableStream<string>` returned by `llmNode`
  (`feather-agent.ts:45-47`). Streaming tool-call argument fragments are the documented Chat
  Completions behaviour (<https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events>).
- **TTS is streaming WebSocket, sentence-tokenized.** The Deepgram plugin declares
  `capabilities.streaming: true` (`@livekit/agents-plugin-deepgram/dist/tts.js:26`) and exposes a
  `SynthesizeStream` with `FLUSH_MSG` / `CLOSE_MSG` control frames
  (`.../dist/tts.d.ts`), i.e. the `wss://api.deepgram.com/v1/speak` endpoint whose `Flush`/`Clear`/
  `Close` semantics are documented at
  <https://developers.deepgram.com/reference/text-to-speech/speak-streaming>. Sentence chunking is
  worth locating precisely, because it is *not* where one would expect: the core `Agent.default.ttsNode`
  only wraps the TTS in a `BasicSentenceTokenizer` when `tts.capabilities.streaming` is **false**, so
  for Deepgram that branch is skipped entirely and the raw `llmNode` stream is piped straight into
  `tts.stream()`. The chunking instead happens inside the Deepgram plugin's own `SynthesizeStream`,
  which runs `opts.sentenceTokenizer.stream()` (default `SentenceTokenizer({ minSentenceLength: 8 })`)
  and emits one `{"type":"Speak"}` WebSocket message per sentence boundary
  (`@livekit/agents-plugin-deepgram/dist/tts.d.ts`, `.../dist/tts.js`). Net effect is the desired one:
  synthesis starts before the LLM finishes. **No change needed here** — worth verifying because
  sentence-streaming is the most commonly recommended "fix" and it is already in place.
- **Deepgram STT is already tuned aggressively.** Plugin defaults are `interimResults: true`,
  `smartFormat: true`, `noDelay: true`, `endpointing: 25`, `utteranceEndMs: null`
  (`@livekit/agents-plugin-deepgram/dist/stt.js:16-33`), and `speech.ts:80` overrides none of them.
  Deepgram's own default for `endpointing` is 10 ms
  (<https://developers.deepgram.com/docs/endpointing>), so 25 ms is already near the floor;
  `utterance_end_ms` would *add* delay and Deepgram states values below 1000 ms "will not offer you
  any benefits" (<https://developers.deepgram.com/docs/utterance-end>). Nothing to win here.
- **The control-plane HTTP hop is cheap.** Tier-1 measured TTFT p50 of 19 ms at C=10 and 36 ms at
  C=50 with the scripted decider (`docs/loadtest/README.md`, Tier 1 table). The turn transaction is
  not the latency problem below the ~70–85 turns/s knee.

### 4.2 Where the milliseconds actually are

Ordered by what the code forces to happen serially after the borrower stops speaking:

1. **Deepgram streaming STT** — documented 150–300 ms transcription latency, 200–500 ms total
   client-side (<https://developers.deepgram.com/docs/measuring-streaming-latency>); ADR 0006
   independently measured 200–500 ms for direct Deepgram on this hardware
   (`docs/adr/0006-self-hosted-livekit-for-local-dev.md:92-93`).
2. **End-of-turn decision** — see §4.3; currently *serialized after* transcription, plus a flat
   500 ms.
3. **Control-plane turn + LLM TTFT** — `ttft_ms` is already on every `turn_end` frame
   (`feather-agent.ts:158`, `README.md:172-173`).
4. **Deepgram Aura-2 TTS TTFB** — Deepgram publishes a worked example rather than a spec: 616 ms
   TTFB, 277 ms once SSL handshake is excluded, 406 ms synthesis, 745 ms total
   (<https://developers.deepgram.com/docs/text-to-speech-latency>). Treat as illustrative; there is
   **no published Aura-2 TTFB SLA number** and no published WS-vs-REST delta.

### 4.3 Win #1 — replace the text EOU model with audio-native end-of-turn

`apps/voice-worker/src/agent.ts:115` pins
`turnDetection: new livekitPlugin.turnDetector.MultilingualModel()`. That class is **text-based**:
its signature is `predictEndOfTurn(chatCtx: llm.ChatContext, timeoutMs?: number)`
(`@livekit/agents-plugin-livekit/dist/turn_detector/multilingual.d.ts`,
`.../base.d.ts`). It consumes the chat context, so **it cannot decide the turn is over until STT has
produced text** — the EOU decision is serialized behind transcription rather than overlapping it.

**It is also formally deprecated, and the installed package says so at runtime.** Importing it emits
a `console.warn` from `@livekit/agents-plugin-livekit/dist/turn_detector/index.js:6`:

> "The text-based turn detector from @livekit/agents-plugin-livekit is deprecated. The audio EOT
> detector in `@livekit/agents` inference (TurnDetector) replaces it and runs natively on-device via
> @livekit/local-inference. This text-based path will be removed in a future release."

LiveKit's docs put a version on that: "the text turn detector is deprecated and slated for removal
in version 2.0 of the LiveKit Agents SDK"
(<https://docs.livekit.io/agents/build/turns/turn-detector/>). The same page publishes the text
model's cost as **~50–160 ms per turn**, and it is that page's only per-turn latency figure — no
directly comparable number is published for the audio detector, which is described qualitatively as
reaching "state-of-the-art end-of-turn accuracy without relying on a transcript" in under 500 MB of
RAM.

`@livekit/agents@1.6.4` ships the audio-native replacement, available since 1.4.7 for Node
(same page). Three findings, all confirmable in the installed package:

- `inference.TurnDetector` is an **audio** EOT detector — "Audio end-of-turn detector with
  `turn-detector-v1` → `turn-detector-v1-mini` (cloud → local) fallback"
  (`@livekit/agents/dist/inference/eot/detector.d.ts:1-3`). The local variant runs in-process via
  `LocalTransport`, buffering "the last ~1.2 s" of PCM with "no per-frame IPC"
  (`.../dist/inference/eot/transports.d.ts`), backed by `@livekit/local-inference@0.2.6`, whose own
  API doc states inference is "~10 ms" and runs on libuv's worker pool so "the main event loop stays
  responsive" (`@livekit/local-inference/index.d.ts:1-11`). **This works without LiveKit Cloud**,
  which matters for the self-hosted profile of ADR 0006.
- **Passing `turnDetection` explicitly opts out of the better default.** The 1.6.4 docs for
  `TurnHandlingOptions.turnDetection` state that when it is `undefined`, "the session
  auto-provisions a default `inference.TurnDetector`"
  (`@livekit/agents/dist/voice/turn_config/turn_handling.d.ts:29-36`). The repo overrides that with
  the text model.
- **Swapping the detector is necessary but not sufficient — the explicit endpointing keys must go
  too.** 1.6.4 defines `streamingEndpointingOptions = { minDelay: 300, maxDelay: 2500 }`, described
  as "Tighter endpointing defaults used when the turn detector is a streaming ('audio model')
  detector. Keys the caller does not provide fall back to these"
  (`@livekit/agents/dist/voice/turn_config/endpointing.d.ts:37-48`; resolution logic at
  `.../turn_config/utils.d.ts:10-17`), and the selection is a class check against
  `BaseStreamingTurnDetector`. `MultilingualModel` extends `EOUModel`, not
  `BaseStreamingTurnDetector`, so today's session would resolve to 500/3000 anyway — the values at
  `agent.ts:116` are redundant rather than harmful *as currently configured*. But because
  `agent.ts:116` supplies both keys explicitly, they would continue to win after a detector swap and
  silently cancel the improvement. LiveKit's docs state the intended post-swap behaviour directly:
  "the session commits sooner with shorter endpointing delays: min_delay of 0.3 seconds and max_delay
  of 2.5 seconds" (<https://docs.livekit.io/agents/build/turns/turn-detector/>).

Additionally, `EndpointingOptions.minDelay` is documented as applying "after the STT end-of-speech
signal, so it can be **additive** with the STT provider's endpointing delay"
(`.../endpointing.d.ts:14-21`) — i.e. the current 500 ms stacks on top of Deepgram's 25 ms, it does
not absorb it. `mode` also defaults to `"fixed"` (`.../endpointing.d.ts:8-11`) and the repo never
sets it, so the EOU model's probability is not being used to shorten the wait at all.

**Expected magnitude: ~200 ms** from the endpointing default alone (500 → 300), plus removal of the
serialization of EOU behind transcription. **Cost: deleting two lines** — drop the `turnDetection`
override and the explicit `endpointing` object from `agent.ts:114-116`.

### 4.4 Win #2 — Deepgram Flux (STTv2), which folds turn detection into the STT

Not previously on the table, and it is **already installed**. `@livekit/agents-plugin-deepgram@1.6.4`
exports an `STTv2` class documented as "Deepgram STTv2 using the Flux model for streaming
speech-to-text… uses Deepgram's V2 API (`/v2/listen`) which provides turn-based transcription"
(`@livekit/agents-plugin-deepgram/dist/stt_v2.d.ts`). Its options include `eotThreshold`,
`eagerEotThreshold` and `eotTimeoutMs`, and the models are `flux-general-en` / `flux-general-multi`
(`.../dist/models.d.ts:3`).

With Flux the end-of-turn decision comes from the transcription model itself, eliminating the
separate detector *and* the framework's additive endpointing wait. Deepgram documents that "Flux can
reduce agent response latency by 200–600 ms compared to traditional STT+VAD approaches", with EOT
detection in 100–500 ms (<https://developers.deepgram.com/docs/flux/voice-agent-eager-eot>).

Caveats worth stating: Flux is a different model from nova-3, so accuracy and pricing must be
re-validated for collections audio before adopting it; `flux-general-en` is English-only (fine —
`speech.ts:80` already pins `language: "en"`). The **eager** path (`eagerEotThreshold`) surfaces as
`SpeechEventType.PREFLIGHT_TRANSCRIPT` (`@livekit/agents/dist/stt/stt.d.ts:34-41`), which the
framework consumes *only* to trigger preemptive generation
(`@livekit/agents/dist/voice/audio_recognition.js:812,843`) — so it is unavailable until §4.5 is
resolved. The non-eager Flux EOT benefit does not depend on that.

**Expected magnitude: 200–600 ms (vendor-documented). Cost: a constructor swap in `speech.ts`, plus
accuracy re-validation.** This is the largest single documented win available.

### 4.5 Win #3 — preemptive generation, but only behind a read-only speculative path

`agent.ts:118` sets `preemptiveGeneration: { enabled: false }`, with the comment "one control-plane
turn per confirmed user turn". Note that **1.6.4's default is `enabled: true`** —
`defaultPreemptiveGenerationOptions = { enabled: true, preemptiveTts: false, maxSpeechDuration:
10000, maxRetries: 3 }`
(`@livekit/agents/dist/voice/turn_config/preemptive_generation.d.ts:31-36`). The repo is explicitly
opting out of a default. LiveKit describes the benefit qualitatively — it "speculatively starts an
LLM response before the user's end of turn is confirmed, reducing perceived latency in back-and-forth
conversation" — and publishes **no millisecond figure**
(<https://docs.livekit.io/agents/build/audio/>). Structurally the win is the overlap of the LLM call
with the remaining endpointing wait.

**It would in fact engage this repo's custom `llmNode`.** `AgentActivity.onPreemptiveGeneration()`
routes into the same `generateReply` pipeline as a confirmed turn, which invokes `agent.llmNode(...)`
— it is not a separate code path. The one gate is that `session.llm` must be a real `llm.LLM`
instance, and `RemoteOrchestratorLLM extends llm.LLM`
(`apps/voice-worker/src/tracer/remote-orchestrator-llm.ts:8`), so the gate passes.

**Which is precisely why it is unsafe to just flip on, and the reason connects both axes of this
document.** Because `llmNode` *is* a POST to `/turn` (`feather-agent.ts:149`), a preemptive
invocation is a ledger-mutating write: T1 claims the turn and appends `USER_TURN_FINAL` before any
supersession check (`Orchestrator.ts:435-454`). LiveKit documents that when the transcript, chat
context, tools, or tool choice change by the time the turn is confirmed, "the speculative response is
discarded and regenerated" — a second, full LLM call — and warns that "preemptive generation
increases LLM token usage" (<https://docs.livekit.io/agents/build/audio/>). With `maxRetries: 3`, a
single user turn could therefore append up to three speculative `USER_TURN_FINAL` events carrying
partial transcripts, each of which then feeds `buildTranscript` and consumes a window slot — i.e.
enabling it naively would directly worsen §2.2.

The correct shape is a **speculative, read-only decide path**: a `/turn/preview` (or a `speculative:
true` flag) that runs the decider against a snapshot without claiming the turn or appending events,
caches the result by `(conversation_id, user_text)`, and lets the real `/turn` return the cached
decision when the confirmed text matches. Medium-to-large effort, but it is the architecturally
honest version and is a good thing to be able to describe in a design discussion.

### 4.6 Smaller, cheaper knobs

- **`service_tier`.** OpenAI documents per-request opt-in via `service_tier: "fast"` (or
  `"priority"`) on Chat Completions, claiming "significantly lower and more consistent latency
  compared to Standard processing", at a price premium
  (<https://developers.openai.com/api/docs/guides/priority-processing>). One field in the params
  object at `LlmClient.ts:62-69`. No reliably-verifiable multiplier — see §5.
- **Model choice.** `DISCUSSING_PAYMENT` and `CONFIRMING_OUTCOME` use `gpt-4.1`; every other state
  already uses `gpt-4.1-mini` (`packages/control-plane/src/config.ts:33-44`). OpenAI publishes **no
  quantified latency comparison** between the two — both model pages carry the identical qualitative
  phrase "low latency without a reasoning step"
  (<https://developers.openai.com/api/docs/models/gpt-4.1>,
  <https://developers.openai.com/api/docs/models/gpt-4.1-mini>). `gpt-4.1-nano` exists and is
  documented to excel at "instruction following and tool calling"
  (<https://developers.openai.com/api/docs/models/gpt-4.1-nano>), which is exactly what
  `CONFIRMING_OUTCOME` does (a yes/no read-back → `record_promise_to_pay`). Worth an A/B, but treat
  any latency claim as unmeasured until run locally.
- **Filler / acknowledgement utterances: recommended against.** Deepgram's own voice-agent prompting
  guidance advises against stalling phrases, framing it as "latency is the stall"
  (<https://developers.deepgram.com/docs/prompting-voice-agents>). Given the FDCPA copy constraints
  in `prompts.ts:101-102`, adding filler is also a compliance surface. Skip.
- **Predicted Outputs: not applicable.** OpenAI's guide lists `tools` among the parameters that do
  not work with Predicted Outputs
  (<https://developers.openai.com/api/docs/guides/predicted-outputs>), and every turn here is
  tool-enabled (`LlmClient.ts:70-74`). Disqualified outright.

### 4.7 Ranked latency recommendations

| Rank | Change | Expected magnitude | Primary source |
|---|---|---|---|
| 1 | Deepgram Flux `STTv2` in place of nova-3 + separate detector | 200–600 ms | <https://developers.deepgram.com/docs/flux/voice-agent-eager-eot> |
| 2 | Drop the deprecated `MultilingualModel` **and** the explicit endpointing overrides; take the auto-provisioned audio `inference.TurnDetector` and the 300/2500 streaming defaults | ~200 ms from endpointing, plus the text model's published ~50–160 ms/turn, plus de-serializing EOU from transcription | <https://docs.livekit.io/agents/build/turns/turn-detector/>; `agents/dist/voice/turn_config/endpointing.d.ts:37-48`; `.../inference/eot/detector.d.ts:1-3` |
| 3 | Speculative read-only preemptive generation (§4.5) | ≈ endpointing delay + part of LLM TTFT; **no vendor ms figure published** | <https://docs.livekit.io/agents/build/audio/> |
| 4 | Cache-aligned prompt (§3.1c) | latency unquantified by OpenAI; cost 0.1× on cached input | <https://developers.openai.com/api/docs/guides/prompt-caching> |
| 5 | `service_tier: "fast"` | unquantified | <https://developers.openai.com/api/docs/guides/priority-processing> |
| 6 | `gpt-4.1-nano` for `CONFIRMING_OUTCOME` | unquantified | <https://developers.openai.com/api/docs/models/gpt-4.1-nano> |

### 4.8 Making each of these measurable with the existing harness

Three of the four components are **already instrumented** and simply not aggregated:

- `agent.ts:132-137` logs `eou_metrics` with `endOfUtteranceDelayMs` and `transcriptionDelayMs`, and
  `tts_metrics` with `ttfbMs`. Field meanings, from the 1.6.4 source (`agents/src/metrics/base.ts`,
  mirrored in `dist/voice/audio_recognition.d.ts:18-33`): `endOfUtteranceDelayMs` is the time
  "between the end of speech from VAD and the decision to end the user's turn";
  `transcriptionDelayMs` is the "time taken to obtain the transcript after the end of the user's
  speech"; `ttfbMs` is TTS "time to first byte in milliseconds". Together these are exactly the
  §4.2 components 1, 2 and 4. Caveat: the published typedoc pages under
  `docs.livekit.io/reference/agents-js/...` are stale for these interfaces (they show older,
  non-`Ms`-suffixed names and 404 on direct fetch) — the shipped source is the authority for the
  pinned version.
- `ttft_ms` rides every `turn_end` frame and is persisted per turn in `conversation_turns.result`
  (`feather-agent.ts:158`, `README.md:172-173`).

The **missing** measurement is the composite: borrower-stops-speaking → first agent audio frame. The
`fake-borrower` harness is one small edit away from it. `apps/voice-worker/src/tracer/scripted-call.ts`
already records `agentSpeakingAt = Date.now()` when agent frames arrive (line 183) and `speak()`
returns only after `await source.waitForPlayout()` (lines 212-217). Stamping a timestamp at each
`speak()` return and diffing against the next `agentSpeakingAt` transition yields exactly the
target metric, per turn, with no new infrastructure. This is also the "latency waterfall" the README
lists as not built (`README.md:172-173`).

Suggested protocol: run `pnpm loadtest:tier2 -- --calls 5` (the level `docs/loadtest/README.md`
records as "green and repeatable") before and after each change, one change at a time, and compare
per-turn response latency distributions rather than the call `durationMs` that is reported today.
Note that tier-2 at N=10 is already CPU-bound on this laptop (`docs/loadtest/README.md`, Tier 2),
so latency A/Bs must be run at N≤5 or the CPU ceiling will dominate the signal.

---

## 5. What I could not verify

- **A head-to-head audio-vs-text turn-detector latency number.** LiveKit publishes ~50–160 ms per
  turn for the *text* model but **no comparable figure for the audio detector**
  (<https://docs.livekit.io/agents/build/turns/turn-detector/>). The ~10 ms figure quoted in §4.3 is
  `@livekit/local-inference`'s own statement about raw model inference time, not an end-to-end EOT
  claim, and the ~200 ms is arithmetic on the two documented default sets. So the §4.7 rank-2
  magnitude is a composed estimate, not a vendor benchmark.
- **A primary-source end-to-end latency budget.** No page on docs.livekit.io decomposes
  user-stops-speaking → agent-audio-starts into per-component milliseconds. The only primary
  statements are the target — "Voice conversations feel natural when end-to-end response latency
  stays under one second" — and the qualitative note that pipelines "accumulate latency across
  stages but reduce it through streaming"
  (<https://docs.livekit.io/agents/models/pipelines/>). LiveKit delegates the numeric breakdown to a
  blog post, which is out of scope for this document. The breakdown therefore has to come from this
  system's own `eou_metrics` / `tts_metrics` / `ttft_ms`, per §4.8.
- **OpenAI's latency reduction from prompt caching.** Not published as a number; only the 0.1× /
  1.25× cost figures are quantified.
- **gpt-4.1 vs gpt-4.1-mini vs nano latency.** No OpenAI-published comparison.
- **`service_tier` speedup multipliers.** Figures such as "2.5× faster" circulate from OpenAI's own
  marketing channels but could not be re-fetched from the live docs page during this research; only
  the qualitative "significantly lower and more consistent latency" wording is confirmed.
- **Aura-2 TTFB as a spec.** Only Deepgram's worked example (616 / 277 / 406 / 745 ms) exists; there
  is no published SLA number and no published WS-vs-REST delta.
- **Whether `no_delay=true` saves a measurable amount.** Deepgram describes it qualitatively and
  publishes no ms figure. (Moot here — the plugin already sets it.)
- **Whether Flux's accuracy is acceptable for this domain.** Untested; the 200–600 ms figure is
  Deepgram's own claim about their own model.
- **Preemptive generation's saving.** LiveKit publishes no ms figure
  (<https://docs.livekit.io/agents/build/audio/>).
- **Every memory-vendor latency and accuracy number in §3.4 is vendor-authored** — Zep's
  P95 < 200 ms and its arXiv:2501.13956 benchmark, mem0's p50 figures and arXiv:2504.19413. None is
  independently verified, and both benchmarks measure long multi-session histories rather than a
  60-second call, so they do not transfer to this system. Graphiti publishes **no** ingestion
  latency or cost figure at all. mem0's own docs also carry an unreconciled accuracy discrepancy
  between its README and its migration guide.
- **Whether the `slice(-12)` window is in fact the cause.** The reasoning in §2 is static analysis
  of the prompt-assembly path; I did not reproduce a context miss on a live call, and I did not
  inspect Langfuse traces of a failing conversation. Reading one real trace and confirming that an
  earlier borrower statement is absent from `input.messages` would convert this from a strong
  inference into a demonstrated fact, and is the cheapest next step.
- **All measurements in this document are from prior runs** recorded in `docs/loadtest/README.md`
  and ADR 0006. I did not execute any load test, call, or benchmark as part of this research.
