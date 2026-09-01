# Novel methods for the voice agent — research findings

2026-08-30. Scope: what the 2024–2026 literature offers this system on **quality, context
management and latency**, checked against the pipeline as it exists at `5dc57d7` and against the
knobs the pinned SDK actually exposes. Every codebase claim cites `file:line`; every SDK claim cites
the installed `@livekit/agents@1.6.4` / `@livekit/agents-plugin-deepgram@1.6.4` `dist/` files, which
are the authority for the version pinned here; every research claim cites the paper by arXiv id.
Papers were found with the `pwc` CLI (Papers With Code catalog); abstracts and, for the three the
recommendations lean on, full text were read.

The companion spec is `2026-08-30-turn-taking-and-conversation-quality-spec.md`.

---

## 1. What is already settled, and is not re-proposed here

The two earlier research passes and ADRs 0007–0010 closed a long list by measurement. None of the
following is re-proposed, and the spec does not touch them:

| Closed | Where | Why |
|---|---|---|
| Speculative / preemptive generation | ADR 0008 D4 | the overlap window is ~80–150 ms on this stack |
| Deepgram Flux (STTv2) | ADR 0007 D3 | commits the borrower's "yes" before the read-back finishes; the fully-heard guard then rejects the promise, 4/4 |
| In-call `call_facts`, LLM summarisation, external memory (Zep/mem0/Graphiti) | ADR 0008 D3, research 08-22 §3 | a call fits in the prompt whole; vendors ingest asynchronously |
| `queueSizeMs`, filler utterances, Predicted Outputs | ADR 0008 D4, research 08-22 §4.6 | measured no effect / compliance surface / incompatible with tools |
| MOS model, production WER, approximated promise-kept | ADR 0009 D3 | no honest measurement exists |
| Language rewrite, driver swap, `listEventsUnchecked`, `next_sequence_no` | ADR 0010 | measured |

What *is* open, from the prior work: "how a turn that arrives during a non-interruptible segment
should be held" (ADR 0007 D3, named as the precondition for ever revisiting Flux), `tts_connect_ms`
(spec 08-27 W6, "the next spec can decide"), and native VAD (W11, Phase 7 of the 08-27 spec, still
the largest single efficiency win and not part of this document).

---

## 2. The pipeline as it stands (facts the recommendations depend on)

- **Turn detection** is the audio-native `inference.TurnDetector` (`v1-mini`, in-process), auto-
  provisioned because `agent.ts:201-215` sets no `turnDetection`; endpointing therefore resolves to
  the streaming defaults `minDelay 300 / maxDelay 2500`, `mode: "fixed"`
  (`@livekit/agents/dist/voice/turn_config/endpointing.js:8-13`).
- **The EOU probability is used as a binary switch, not a delay curve.** `audio_recognition.js`
  `runEOUDetection()` (~`:1006-1069`) waits `minDelay` unless `endOfTurnProbability <
  unlikelyThreshold`, in which case it waits `maxDelay`. `unlikelyThreshold` for `en` on the local
  model is **0.36** (`inference/eot/languages.js:2-17`) and is overridable per language via
  `TurnDetectorOptions.unlikelyThreshold` (`detector.d.ts:10-40`). `mode: "dynamic"` does *not*
  consume the probability either — it is an EMA of the borrower's own inter-utterance rhythm
  (`endpointing.js:114-160`). There is no "adaptive" endpointing in 1.6.4.
- **Interruption** (`agent.ts:213`): `mode: "adaptive"`, `falseInterruptionTimeout: 2000`,
  `resumeFalseInterruption: true`, `discardAudioIfUninterruptible: false`; `minDuration` (default
  **500 ms**) and `minWords` (default 0) are not set (`interruption.js:1-10`).
  - `"adaptive"` is the ML overlap classifier in `inference/interruption/interruption_detector.js`.
    **It streams audio to a LiveKit inference endpoint over a websocket** — it is hosted inference,
    resolved from `LIVEKIT_INFERENCE_URL` / `LIVEKIT_API_KEY`, and is "disabled by default in
    production mode" unless explicitly requested (`agent_activity.js:3416-3457`). The repo
    requests it explicitly. **Whether it is actually running on the self-hosted profile has never
    been checked**; `InterruptionMetrics.numRequests` (`metrics/base.d.ts:197-213`) would say.
  - `discardAudioIfUninterruptible: false` means that during a non-interruptible `say()` the
    borrower's audio is **not** replaced with silence (`agent_activity.js:824-849`,
    `audio_recognition.js:285-292`) — it is transcribed and can commit a turn while the read-back is
    still playing. That is the mechanism behind the Flux failure in ADR 0007, and it is latent with
    nova-3 too: it just loses the race today.
  - A false interruption pauses the agent's audio and resumes it only when the false-interruption
    timer fires after VAD end-of-speech with no committed turn (`agent_activity.js:3458-3557`) — a
    backchannel therefore costs up to `falseInterruptionTimeout` (2 s) of dead air.
- **STT**: Deepgram nova-3 via the plugin; `keyterm`, `keywords`, `numerals`, `endpointing`,
  `utteranceEndMs`, `dictation` are all forwarded to the websocket query
  (`plugin-deepgram/dist/stt.js:218-244`). The repo sets none of them (`speech.ts:80`).
- **TTS**: Deepgram Aura-2 over a websocket opened **per `stream()` call**, no pool, no prewarm
  (`plugin-deepgram/dist/tts.js:65-67, 224-243`); sentence-chunked by
  `SentenceTokenizer({ minSentenceLength: 8 })` (`tts.js:16,28-30`), configurable.
- **Interim transcripts are available**: `UserInputTranscribed { transcript, isFinal:false }`
  fires on every interim (`voice/events.d.ts:55-65`, `audio_recognition.js:852`). Nothing consumes
  them today.
- **Decider**: `gpt-4.1-mini` everywhere except `DISCUSSING_PAYMENT`/`CONFIRMING_OUTCOME`
  (`gpt-4.1`), `temperature 0.3`, `maxTokens 220`, `prompt_cache_key = decider:<state>`; no
  `service_tier` (`config.ts:99-112`, `OpenAITurnDecider.ts:54-63`). Deterministic overrides
  (`matchOverride`) already short-circuit the model for opt-out / dispute / hardship / wrong-number
  (`Orchestrator.ts:495-521`).
- **Per-turn waterfall** in `conversation_turns.result`: `eou_delay_ms`, `transcription_delay_ms`,
  `ttft_ms`, `tts_ttfb_ms`, `tts_audio_ms`; the harness adds response latency (borrower falls
  silent → agent audio onset, RMS-confirmed) and WER against the exact text it spoke.
- **Evaluation**: the fleet borrower is **scripted** (WAV-cached lines, one clarification answer);
  the judge is binary per dimension with evidence quotes, and judge-vs-human agreement is a plain
  proportion over labelled calls (`Quality.ts:345-367`).

---

## 3. The literature, by theme, with an applicability verdict

### 3.1 Turn-taking: end-of-turn, hold, backchannel, false barge-in

| Paper | What it contributes | Applies here? |
|---|---|---|
| **LLM-Enhanced Dialogue Management for Full-Duplex SDS** (2502.14145, Tencent, 2025) | A 0.5B "semantic VAD" emitting four control tokens — `Start-Speaking`, `Continue-Listening` (query incomplete), `Continue-Speaking` (unintentional barge-in: acknowledgment, backchannel, speech to someone else), `Start-Listening` (real interruption). The dialogue engine is invoked only on `Start-Speaking`. | **Yes, as a decision taxonomy**, not as a model. The four states are exactly the decisions this pipeline makes implicitly and never records: commit / wait / resume / yield. A text-side classifier over the final transcript can produce the `wait` and `resume` decisions cheaply (§4.1). |
| **Easy Turn** (2509.23938) | Open bimodal turn model predicting `complete / incomplete / backchannel / wait`; 1,145 h open trainset; beats TEN Turn Detection and Smart Turn v2. | Same taxonomy; the model itself is a second EOU model next to LiveKit's, and swapping detectors is its own fleet baseline (ADR 0010 D1). Not adopted. |
| **JAL-Turn** (2603.26515) | Turn-taking shares the frozen ASR encoder, so it runs in parallel with recognition at zero added latency; Japanese customer-service data. | Confirms the direction LiveKit already took (audio-native, parallel). Nothing to build. |
| **Phoenix-VAD** (2509.20410), **SpeculativeETD** (2503.23439) | Streaming semantic endpointing; local cheap GRU + server wav2vec for the hard cases. | Architecture already in place (local `v1-mini`, cloud `v1` fallback). Nothing to build. |
| **Voice Activity Projection** (2401.04868, 2403.06487) | Predicts *future* voice activity from stereo audio, real-time on CPU. | The general form of what `TurnDetector` does. Reference only. |
| **FireRedChat** (2509.06502) | Personalised VAD to suppress false barge-ins from non-primary speakers; **defines the three system metrics**: barge-in `T90` (ms of user speech until 90 % of true barge-ins are honoured), **false barge-in rate** (agent stops when the primary speaker is silent), end-of-turn accuracy, end-to-first-audio latency. | **Yes — the metric definitions.** This system has no turn-taking metrics at all; §4.4 adopts these. |
| **τ-Voice** (2603.13686, ICML 2026) | Extends τ²-bench to full-duplex voice with a tick-based, wall-clock-decoupled user simulator (personas/accents, G.711 8 kHz, frame drops, burst noise, "hold on", coughs, LLM-decided interruptions and backchannels). Metrics: response rate, **yield rate (agent stops within 2 s)**, response latency, **yield latency**, agent-interruption rate, **selectivity** (ignores backchannels / vocal tics / non-agent-directed speech). Finding: voice agents keep 30–45 % of their text capability; turn-taking alone costs 7 pp, accents 10 pp; 79–90 % of failures are agent behaviour. | **Yes — as the shape of the missing evaluation tier** (§4.4). The scripted fleet borrower never interrupts, never backchannels, never says "hold on", never has a third party pick up. |
| **Talking Turns** (2503.01174), **FD-Bench** (2507.19040) | Supervised turn-taking judge trained on human-human data; interruption-handling metrics under noise. | Reference for what to measure; τ-Voice's definitions are simpler and sufficient. |
| **Still Between Us?** (2604.17358, ACL 2026) | Third-party interruption benchmark; models take the "semantic shortcut" and respond to speech not directed at them. | **Domain-critical**: FDCPA forbids disclosing the debt to a third party. `THIRD_PARTY_OR_WRONG_PARTY` exists as a state but no harness scenario exercises a mid-call third-party voice. Goes into the simulator scenarios (§4.4). |
| **Backchannel/dialogue-context alignment** (2604.16622) | Backchannel form is context-sensitive. | Reference only. |

### 3.2 Speculation and parallelism inside the turn

| Paper | Contribution | Applies here? |
|---|---|---|
| **RelayS2S** (2603.23346) | Fast path drafts a short response **prefix** at turn commit and streams it to TTS; slow cascaded path continues conditioned on the committed prefix; a verifier gates the handoff. P90 onset ≈ S2S with 99 % of cascaded quality. | The mechanism, not the models: **for a fraction of turns the correct response is knowable without the model**. The read-back confirmation ("yes" in `CONFIRMING_OUTCOME`), the amount re-statement, the "hold on" acknowledgment. §4.2 builds the deterministic fast path with the LLM as the fallback rather than the continuation, because a compliance domain cannot let a fast-path prefix be contradicted by the slow path mid-sentence. |
| **Stream RAG** (2510.02044, ICML 2026) | Predict tool queries *while* the user is still speaking; 20 % lower tool latency. | The tool here is Postgres and the hop is 20–40 ms; nothing to prefetch. What *can* run on interims is the fast-path intent classifier (§4.2), so its answer is ready when the turn commits. |
| **LiveMind** (2406.14319) | Infer on incomplete input; large model reasons, small model emits. | API-bound; no access to the prefill. The small-emits-large-reasons shape is the cascade below. |
| **OrchestraLLM** (2311.09758), **Cascade routing** (2410.10347, ICML 2025), **Hybrid LLM** (2404.14618) | Route easy instances to a small model with a quality estimator; escalate otherwise; "good quality estimators are the critical factor". | The per-state model split already exists (`config.ts:99-112`). The cascade principle applies per *turn*, and the quality estimator this domain has is unusual: **state-machine determinism**. In `CONFIRMING_OUTCOME` the acceptable responses are enumerable. §4.2. |
| **PSLM / Speak While You Think** (2406.12428, 2309.11210) | Start synthesis on the first clause, not the first sentence. | Cheap knob: the Deepgram plugin's `minSentenceLength: 8` and its tokenizer are configurable (§4.5). |

### 3.3 Context management

| Paper | Contribution | Applies here? |
|---|---|---|
| **Plans Don't Persist** (2606.22953, Snowflake) | Agent-critical information is context-resident, not internalised; evicting it collapses task success. | Confirms the design: `pendingProposal`, state and the fact block are structured and re-rendered every turn (`prompts.ts:161-178`), never left to the transcript. Nothing to change. |
| **Recursive summarisation / SGMem / ReMEMBER / Context-Folding** (2308.15022, 2509.21212, 2608.09043, 2510.11967) | Long-horizon memory under a budget. | A call is 1–2k tokens; ADR 0008 D3 stands. Cross-call memory is the `wrap_up` projection. Not applicable. |
| **Structured Uncertainty guided Clarification** (2511.08798) | Uncertainty over *tool arguments*, EVPI-chosen clarifying questions; 1.5–2.7× fewer questions. | The read-back **is** this system's clarification mechanism, and ADR 0008 D1 decided date-only offers imply the full balance. What is missing is the *input-side* half: if STT is unsure about the amount, the read-back is built on a wrong number and the borrower has to catch it. §4.3 puts the uncertainty where it originates. |
| **"Sorry, I Didn't Catch That"** (2602.12249), **Contextual NE revision** (2506.10779), **Contextual biasing with LLMs** (2309.00723) | ASR fails on short high-stakes utterances (44 % on street names across 15 commercial models); errors are systematically worse for non-native speakers; a few hundred contextual examples cut entity errors ~30–60 %. | **Yes.** Collections turns on amounts, dates and a name, and the WER gate is word-level — a call with WER 0.05 that turned "five fifty" into "five fifteen" passes the gate and records the wrong promise. Deepgram's `keyterm`/`keywords`/`numerals` are the zero-cost version of contextual biasing and are already wired through the plugin (§4.3). |

### 3.4 Evaluation and the judge

| Paper | Contribution | Applies here? |
|---|---|---|
| **Trust or Escalate** (2407.18370, ICLR 2025) | Selective evaluation: estimate judge confidence, **abstain** below a threshold, and the accepted verdicts carry a provable human-agreement guarantee; cascade cheap→strong judges. | **Yes.** The judge is binary with evidence quotes (ADR 0009 D2) but every verdict is accepted. Abstention turns "judge agreement 83 %" into "agreement 95 % on the 80 % it was sure about, 20 % queued for a human" — and the human labels the operator already writes become the calibration set (§4.6). |
| **How to Correctly Report LLM-as-a-Judge Evaluations** (2511.21140, ICML 2026) | Plug-in bias correction using the judge's estimated sensitivity/specificity from a labelled calibration set, with confidence intervals reflecting both sets; adaptive allocation of calibration labels. | **Yes**, and it is a pure function. The Quality page's pass rates are raw judge proportions; the correction and its CI are a few lines in `domain` once the labelled set exists (§4.6). |
| **No Free Labels** (2503.05061) | A judge that cannot answer the question cannot grade it; giving it a reference closes most of the gap. | Already done: the judge receives the deterministic evaluator's ledger facts (ADR 0009 D2). Confirms. |
| **Lost in Simulation** (2601.17087, ACL 2026), **Mind the Sim2Real Gap** (2603.11245, COLM 2026), **SimulatorArena** (2510.05444, EMNLP 2025) | LLM-simulated users are too cooperative, stylistically uniform, never frustrated; success rates vary ±9 pp across simulator LLMs; AAVE and Indian-English speakers get systematically worse outcomes; **persona-conditioned** simulators reach ρ≈0.7 with human ratings. | The design constraints for §4.4: personas are mandatory, the simulator's numbers are reported as *its own* segment and never mixed with scripted or real calls, and it does not gate anything until a human has labelled a sample of its calls. |
| **τ-bench / τ²-bench** (2406.12045, 2506.07982) | pass@k over verifiable end state under domain policy. | The equivalence gate is this system's pass@1. The simulator tier reports pass@k over the *outcome* (`PROMISE_TO_PAY` recorded vs not) and policy compliance from the evaluator. |

### 3.5 Negotiation and the collections domain

| Paper | Contribution | Applies here? |
|---|---|---|
| **EQ-Negotiator** (2503.21080, 2511.03370) | HMM over debtor emotional state + game-theoretic policy; a 7B model with it out-recovers models 10× larger in *simulated* credit negotiation; adversarial debtor strategies (cheating, threatening, playing the victim). | The adversarial debtor catalogue is a good source of **simulator personas**. The "measured anger" policy is not — in a regulated collections call the agent's tone is a compliance surface (`prompts.ts` RULES), and the judge's `empathy_professionalism` dimension exists to catch exactly that. |
| **Deal or No Deal (or who knows)** (2402.03284), **Forecasting derailment with deferral** (2605.29243, ACL 2026) | Calibrated outcome forecasting mid-conversation; decouple the *decision* to act from the likelihood estimate by simulating whether recovery is plausible. | A per-turn "this call is heading to ESCALATED" signal that triggers `request_human` earlier is attractive and **premature**: with no labelled corpus of this system's calls the forecaster has nothing to calibrate against. Recorded as future work behind the simulator tier, which produces the corpus. |
| **Bayesian persuasion in dialogue** (2510.13387), **MERIT** (2602.10467) | Strategic message design. | Out of scope; FDCPA constrains message content, not strategy, but the judge would need a new dimension to police it. Not proposed. |

### 3.6 Tool calling

| Paper | Contribution | Applies here? |
|---|---|---|
| **Constraint Tax** (2606.25605) | With tools and a JSON-schema constraint both enabled, open-weight models stop calling tools (grammar masks make tool tokens unreachable). | The turn path uses tools without `response_format`; the judge uses `response_format` without tools (`LlmClient.ts:132-135, 167`). The two are never combined here, and should not be — noted as a rule for the spec. |
| **Schema-first tool APIs** (2603.13404), **ToolPRM** (2510.14703) | Tool misuse/recovery under budget. | Covered by the domain's tool-arg schemas and `TOOL_REJECTED` path. Nothing to add. |

---

## 4. Ranked recommendations

Ordered by (measured or vendor-documented magnitude) × (confidence it transfers) ÷ effort. Each
names its gate. Nothing here relaxes the four gates of the 08-27 spec (equivalence, WER ≤ 0.20,
SLO verdict, evaluator compliance).

### 4.1 Hold and resume — make the four turn decisions explicit, and stop losing the read-back race

**Problem.** Three behaviours are implicit today. (a) A borrower who says "hold on, let me get my
card" gets a reply after 300 ms, because nothing distinguishes *query incomplete / wait* from
*query complete*. (b) A "yeah" or "mm-hm" during an interruptible agent line pauses the agent for
up to 2 s before the false-interruption timer resumes it. (c) A "yes" spoken during the
non-interruptible read-back is transcribed (`discardAudioIfUninterruptible: false`) and commits a
turn while the read-back is still playing; the guard then rejects the promise and the agent repeats
the read-back — the ADR 0007 failure mode, which nova-3 only avoids by being slower than Flux.

**Method** (taxonomy from 2502.14145 / 2509.23938; hold semantics from ADR 0007's open question):

- The control plane's turn contract gains a **turn disposition**: `respond | wait | resume |
  held`. `wait` is returned when the final transcript matches a small, tested lexicon of hold
  requests ("hold on", "one second", "let me check", trailing "and…") — the control plane appends
  the borrower line to the ledger, emits `turn_end` with no speech, and asks the worker to extend
  the away timer once. `resume` is the same classifier run by the **worker** on the interim
  transcript of an in-flight interruption: a pure-backchannel interim ("yeah", "okay", "right",
  "mm-hm", "uh-huh") resumes the paused audio immediately instead of waiting for the 2 s timer.
- **`held`**: when a turn arrives while a non-interruptible segment has not yet reported playout,
  T1 does not claim it; the control plane parks it (bounded by the segment's `tts_audio_ms` plus a
  margin) and processes it when the playout signal lands, so the fully-heard guard sees the
  read-back as heard and the borrower's "yes" records the promise on the first attempt. This is the
  design decision ADR 0007 named as the precondition for revisiting Flux, and it is worth having
  regardless of Flux: it removes one repeated read-back per race, which is ~8 s of call time and
  the most annoying thing a borrower can hear.
- `discardAudioIfUninterruptible` stays `false` (the borrower's words during the read-back are
  still evidence and still belong in the ledger), which is why `held` must exist at all.

**Gate.** N=5 equivalence green twice; the new turn-taking metrics (§4.4) show the false-
interruption resume delay p50 drop from ~2 s to < 300 ms on backchannel turns and zero
guard-rejected promises on the "yes during read-back" scenario; `eou_delay_ms` p95 unchanged.
**Why now:** the pieces are all present — interim events, the paused-speech machinery, the playout
signal — and none of them are joined.

### 4.2 Deterministic fast path with cascade fallback for enumerable turns

**Problem.** The largest fixed cost in every turn is decide TTFT, 0.8–1.4 s p50 (ADR 0008). In
`CONFIRMING_OUTCOME` the borrower's next line is almost always "yes" / "no" / a corrected amount or
date, and the correct action is fully determined by the state machine and the pending proposal.
The model is paid a second to agree with a `switch` statement.

**Method** (cascade routing, 2410.10347; RelayS2S's "the prefix is knowable at commit", 2603.23346;
built on the existing `matchOverride` seam, `Orchestrator.ts:495-521`):

- A pure **intent classifier** in `domain`, per state, over the normalised final transcript:
  `CONFIRMING_OUTCOME → affirm | deny | amend(amount|date) | unclear`; `DISCUSSING_PAYMENT →
  hold-request (§4.1) | unclear`; every other state → `unclear`. Rules only — the same normaliser
  the WER gate already uses (contractions, number words, currency) — and a confidence that is
  either 1 or 0; anything with a trailing clause, a number the classifier cannot parse, or a
  negation ambiguity is `unclear`.
- `affirm` in `CONFIRMING_OUTCOME` executes `record_promise_to_pay` through the existing tool path
  (guard included) and speaks the existing confirmation script; `deny` returns to
  `DISCUSSING_PAYMENT` with the existing renegotiate line; `amend` with a parseable value rebuilds
  the proposal and re-issues the read-back. `unclear` goes to the model exactly as today.
- Every fast-path turn is recorded as such (`conversation_turns.result.decider = "fast_path"` and
  the Langfuse span carries it), so the SLO segment and the Quality page can show the model and the
  fast path separately and the equivalence harness can assert which turns took which path.
- Optionally the classifier runs on **interim** transcripts too, so the answer is ready at commit;
  that is a worker-side prefetch, not a ledger write, and is only worth doing if the measured
  fast-path TTFT is not already ≈ 0.

**Gate.** 20/20 scenarios plus new scenarios per intent class; N=5 equivalence green; turn p50 on
fast-path turns < 700 ms (EOU + TTS only) with the model-path p50 unchanged; **zero** fast-path
`TOOL_REJECTED`. **Expected magnitude:** −0.8 to −1.2 s on roughly one turn in four of a happy-path
call, and the read-back confirmation is the turn the borrower is most impatient on.

### 4.3 Contextual ASR biasing and an entity-level accuracy gate

**Problem.** WER is the wrong gate for collections: the words that matter are the amount, the
date, and the borrower's name (2602.12249: commercial ASR at 44 % on short named entities; worse
for non-native speakers). A misheard amount survives the WER gate and becomes a wrong read-back.

**Method** (contextual biasing, 2309.00723 / 2506.10779; no new model):

- Per-session Deepgram options, already forwarded by the plugin (`stt.js:218-244`):
  `keyterm` with the borrower's first and last name and the creditor name; `numerals: true`;
  `keywords` for the month names and the amount vocabulary the account implies (balance, minimum,
  round figures near it). The values come from the same protected context the prompt already gates
  behind right-party verification — the worker receives them on the session bootstrap, not per
  turn, and only after `confirm_right_party`.
- The harness computes **entity error rate** next to WER: for each scripted line carrying an
  amount, date or name, whether the STT final contains it after normalisation. A new `stt.entity_er`
  score, gated at 0 for amounts on the fleet run (an amount error is a wrong promise, not a
  degraded transcript).
- Amount/date read-back already exists; §4.2's `amend` path is where a caught error is corrected in
  one turn.

**Gate.** Entity error rate on amounts = 0 across N=5 twice with the noise-augmented simulator
lines (§4.4); WER not worse. **Magnitude:** unknown until measured — that is the point of the
metric.

### 4.4 Tier 3: a persona-conditioned borrower simulator with turn-taking metrics

**Problem.** Every fleet number comes from one cooperative scripted borrower with studio audio
who never interrupts, never backchannels, never asks the agent to wait, never has a spouse pick
up, and never speaks with an accent. τ-Voice's headline (2603.13686) is that this is exactly the
condition under which voice agents look 30–45 % better than they are, and that turn-taking and
accents are the two factors that cost most.

**Method** (τ-Voice's simulator shape; Sim2Real's constraints; FireRedChat's metric definitions):

- `apps/load-test` (or the tracer) gains a `sim-borrower` that composes three things the harness
  already has — WAV lines, the RMS onset detector, the equivalence runner — with: **personas** (a
  fixed set of ≥ 5 TTS voices/accents, deterministic per seed), **audio degradation** (G.711 8 kHz
  round trip, SNR-targeted background noise, burst noise, frame drops with a Gilbert–Elliott model,
  all seeded), and a **turn-taking policy** that is scripted, not LLM-decided, so runs are
  reproducible: interrupt at offset *t* into the agent's line, backchannel at *t*, say "hold on"
  once, a third-party voice answers one turn. LLM-generated borrower text is a later option and is
  segmented separately if added (Sim2Real).
- **Metrics per call**, per FireRedChat / τ-Voice, written as scores so they land on the Quality
  page: `turn.response_rate`, `turn.yield_rate` (agent silent within 2 s of a real interruption),
  `turn.yield_latency_ms`, `turn.false_interrupt_rate` (agent stopped for a backchannel/noise),
  `turn.agent_interrupt_rate` (agent spoke before the borrower finished), `turn.selectivity`
  (ignored backchannels / non-directed speech), plus the `T90` barge-in latency from the
  interrupt-offset sweep. All are harness metrics with the same honesty labelling as WER.
- **Scenarios** the scripted borrower cannot produce: yes-during-read-back (§4.1), backchannel
  mid-line, hold request, third-party pickup (`THIRD_PARTY_OR_WRONG_PARTY` must be reached and no
  balance disclosed — a compliance score, not a latency one), accent × noise ablations.
- Reported as its own segment. Never mixed into the voice+openai SLO window (ADR 0010 D3).

**Gate.** The tier runs green on the current system for the *clean* persona (so it is a
regression instrument from day one); the realistic conditions produce a number, not a pass/fail,
until a human has labelled 20 of its calls. **This tier is what makes 4.1–4.3 measurable at all.**

### 4.5 Small latency knobs, each an A/B

- **First-clause TTS**: `sentenceTokenizer` with a smaller `minSentenceLength` (or a first-chunk
  clause split on `,`/`—`) for the *first* chunk of a turn only. Gate: `tts_ttfb_ms`/first-audio
  onset p50 improves; the chars/s heuristic does not flag more outliers.
- **`unlikelyThreshold`** for `en` (0.36 default): a sweep of 0.25 / 0.36 / 0.45 on N=5 against
  `eou_delay_ms` p95 *and* the agent-interrupt rate from §4.4. This is the one EOU knob that exists;
  it trades hesitation tolerance against latency and has never been touched.
- **`interruption.minDuration`** (500 ms default) and `minWords`: a backchannel is usually
  < 400 ms; raising `minDuration` to ~700 ms is the zero-code version of §4.1's resume path and
  should be measured first, because if it is enough the classifier is unnecessary.
- **`tts_connect_ms`** (W6): instrument the per-stream websocket connect; if ≥ 100 ms p50, a
  per-session warm socket is the next spec's decision with the ADR 0008 caveats.
- **`service_tier: "priority"`** on the decider: one field, unquantified by OpenAI, measured on
  N=5 `ttft_ms` p50/p95. Kept only if p95 moves and the cost delta is written down.
- **Verify `mode: "adaptive"` is actually running** on the self-hosted profile
  (`InterruptionMetrics.numRequests > 0` in the metrics stream). If it is not, the worker has been
  running plain VAD interruption with `backchannelBoundary` cooldowns and the config is a claim.

### 4.6 Judge abstention and bias-corrected quality numbers

**Method** (2407.18370; 2511.21140):

- The judge prompt already produces evidence-first binary verdicts. Add a per-dimension
  **confidence** (the paper's "simulated annotators": *k* cheap re-judgements at temperature, or a
  verbalised probability — pick the one that calibrates on the labelled set) and an abstention
  threshold; an abstained dimension becomes `judge.abstained`, which the console shows as "needs a
  human" rather than pass/fail.
- A pure `correctedRate(observedPositiveRate, sensitivity, specificity)` and its CI
  (Rogan–Gladen with the plug-in interval from 2511.21140) in `domain`, fed by the labelled set the
  operator already produces through the human pass/fail control. The Quality page shows raw and
  corrected pass rates with the interval and *n* of the calibration set, and says "uncalibrated"
  below a minimum.
- Cascading (cheap judge first, escalate to Luna on low confidence) is the cost half of the same
  paper and is optional; the judge runs post-call and off the critical path, so it is a cost
  decision only.

**Gate.** Unit tests for the estimator against the paper's worked numbers; on the existing labelled
calls, agreement on accepted verdicts ≥ agreement overall.

---

## 5. What was not adopted, and why (so it is not re-proposed on the same evidence)

- **A second turn-detection model** (Easy Turn, TEN, Smart Turn, JAL-Turn): every latency number
  in the loadtest README was measured on LiveKit's `v1-mini`; a detector swap is a new fleet
  baseline and none of the open models claims a latency advantage over an in-process 10 ms model.
- **Full-duplex speech-to-speech models** (LSLM 2408.02622, Moshi-class, RelayS2S's fast path as a
  model): expressive, weaker semantically, no tool use, no ledger; the compliance story would have
  to be rebuilt. τ-Voice's own result is that the S2S providers score 26–51 % on grounded tasks.
- **KV-cache work** (CacheBlend, KVShare, EpiCache…): all server-side; the decider is behind an
  API where `prompt_cache_key` is the only handle, and it is already used.
- **Emotion-adaptive tone** (EQ-Negotiator): a compliance surface in this domain.
- **Mid-call outcome forecasting** (§3.5): no calibration corpus yet; the simulator tier produces
  one.
- **LLM-decided simulator turn-taking**: reproducibility first (τ-Voice decouples wall-clock to
  get it; this harness runs in real time against a real SFU, so scripted offsets are the honest
  version).

## 6. What could not be verified

- No paper publishes an end-to-end latency delta for a hold/resume classifier in a cascaded
  pipeline; §4.1's magnitude is arithmetic on the 2 s timer and the observed repeat-read-back cost.
- The fast-path share of turns (§4.2, "about one in four") is from the happy-path scenario shape,
  not from a corpus of real calls.
- Whether Deepgram's `keyterm` measurably helps on amounts is a Deepgram claim; the entity gate in
  §4.3 is how it gets checked here.
- Whether `mode: "adaptive"` interruption is live on the self-hosted profile — §4.5's first item
  is to find out.
- τ-Voice's 30–45 % retention figure is for OpenAI/Google/xAI realtime APIs, not a cascaded
  nova-3 → gpt-4.1 → Aura-2 pipeline; the direction transfers, the number does not.
