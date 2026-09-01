# Spec: turn-taking, a deterministic fast path, entity-accurate hearing, and an honest simulator

2026-08-30. For the implementing session. Built on
`docs/plans/2026-08-30-voice-agent-methods-research.md` (the literature, checked against the pinned
SDK) and `docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md` (what the last spec left
bent). The efficiency spec's Phases 7–9 (native VAD W11, two processes, the N=10 acceptance) remain
open in *that* spec and are sequenced against this one in "Further Notes".

Read before touching code, in this order, and do not re-derive them:

1. **`docs/plans/2026-08-30-voice-agent-methods-research.md`** — every method here has its paper,
   its SDK citation and its rejected alternatives there. §2 is the list of SDK facts this spec
   assumes (interruption `adaptive` is hosted inference; `discardAudioIfUninterruptible: false`
   lets a turn commit during the read-back; the EOU probability is a binary min/max delay switch
   with `unlikelyThreshold` 0.36; `keyterm`/`numerals` are forwarded by the Deepgram plugin; interim
   transcripts are an event; the TTS websocket is per stream).
2. **`docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md`** — Phase 0 of this spec is
   its §2, items 1–7 and 9–12. Do not re-review; fix.
3. ADR 0007 D3 (why Flux was reverted and what "hold" has to mean), ADR 0008 D4 (why preemptive
   generation is rejected), ADR 0009 (scores in Postgres, binary judge, honesty line),
   ADR 0010 D2–D3 (admission at the worker, segmented SLO).
4. The handoff in the user's temp directory
   (`feather-lite-handoff-2026-08-28-efficiency-phases-0-6.md`) for the environment gotchas —
   `stack:quiet` first, `start` mode not `dev`, zombie workers on 7880, `Tee-Object` locks logs,
   `.env` read once at boot.

## Ground rules (inherited; restated because they still bite)

1. **Nothing is done until it has been run.** Every phase ends with its verification below.
   Every latency or quality change carries a before/after from the same harness on the same box.
2. **One behavioural change per commit**, reasoning + before/after in the message; `code-review`
   on the diff; commit through `commit-work`, never a bare `git commit`; `diagnosing-bugs` for the
   voice path; `tdd` for the pure modules (all of the classifiers and estimators here are pure).
3. **Verify every library API against the installed source** (`find-docs` / the `dist/` files —
   the research doc cites the lines). `@livekit/agents@1.6.4` stays pinned; do not upgrade.
4. **Known-failing test**: `pnpm test:db` `workers.test.ts:145` (pinned date). Not approved for
   fixing; ask. Everything else stays green.
5. **Quiet-box discipline** for every fleet number (handoff). `JUDGE_ENABLED=false` for load runs;
   the simulator tier (Phase 4) is *not* a load run and may turn the judge on for its labelled
   sample only.
6. **The four gates are not negotiable**: voice/sim equivalence, WER ≤ 0.20, the SLO verdict on
   the voice+openai segment, the evaluator's compliance scores. A change that is faster and fails
   any of them is reverted and the revert recorded. This spec adds a fifth (D3: amount entity error
   = 0) once it exists.
7. **Do not re-propose** anything in research §1 or §5: preemptive generation, Flux, external
   memory, a second EOU model, S2S models, emotion-adaptive tone, mid-call outcome forecasting,
   LLM-decided simulator turn-taking, tools + `response_format` on the same request.
8. **Segments never mix.** Fast-path turns, model turns, scripted-borrower calls, simulator calls
   and real calls each report as their own segment (ADR 0010 D3). A number without its segment is
   not a number.

## Decisions taken on 2026-08-30 (autonomous session; the user may revisit, none needs re-asking to start)

| # | Decision |
|---|---|
| Q1 | **Order: fix the instruments first.** Phase 0 fixes the review's critical/high defects because Phases 1–4 are measured by exactly those instruments (the fleet's dev-mode gate, `/readyz`, per-turn scores, the compose worker limit). |
| Q2 | **The simulator is scripted-and-seeded, not LLM-driven.** Turn-taking offsets, backchannels, hold requests, third-party pickup, noise and persona are all parameters of a seed, so a run is reproducible against a real-time SFU. LLM-generated borrower text is out of scope (research §3.4, Sim2Real). |
| Q3 | **The fast path is rules, with confidence ∈ {0, 1}.** No small model in the loop for Phase 2; the cascade's "quality estimator" is the state machine. A model-backed classifier is a later spec if the `unclear` share is high. |
| Q4 | **`held` lives in the control plane, not the worker.** The ledger is the truth about what was heard; the worker keeps `discardAudioIfUninterruptible: false` so the borrower's words are still recorded, and the control plane decides when a turn that raced a non-interruptible segment is processed. |
| Q5 | **Contextual biasing uses account facts only after right-party verification**, delivered on the session bootstrap, never per turn — the same gate as the prompt's `ACCOUNT` block. |
| Q6 | **Judge abstention and bias correction are added; the judge model is not changed.** Cascading to a cheaper judge is optional and cost-only. |
| Q7 | **The ten "missing without a decision" items in review §3 are not built here.** They are listed for the user to either schedule or record in ADR 0010; this spec neither re-argues nor silently absorbs them, except the two that Phase 0 needs (the O9 bypass token, because the simulator tier is rate-limited by its own server otherwise; and the HOT/dead-tuple report line, because Phase 0's Postgres fix touches that migration). |
| Q8 | **W11 (native VAD) is mandatory and runs first, immediately after Phase 0** (user decision, 2026-08-30). `silero.VAD.load()` is replaced by `inference.VAD` — same addon as the EOU model, in-process (`agents/dist/inference/vad.js:84-93`), measured 0.69 ms CPU/s of audio vs Silero-ONNX's 4.4–6.3 — which deletes the silero import review #6 flags and takes `onnxruntime-node` (513 MB, 336 MB of it an unusable CUDA provider) out of the tree and the Dockerfile prune. `find-docs`/read the installed constructor options first: defaults are `activationThreshold 0.5`, `deactivationThreshold 0.35`, `minSpeechDuration 50`, `minSilenceDuration 250`, `prefixPaddingDuration 500` (`vad.js:7-16`) — a threshold change is a barge-in timing change. Gates: equivalence + WER ≤ 0.20 + `eou_delay_ms` p95 unchanged-or-better on N=5, twice; idle tree re-sampled and the README table corrected. Phase 1's turn-taking metrics baseline **on the native VAD**, never on silero. The N=10 acceptance (old Phase 9) runs after this spec's Phase 0 + W11, not after Phase 4. |

## Problem Statement

The agent hears well enough to pass a word-error gate and still records the wrong promise, because
the words that matter — the amount, the date, the name — are the ones short-utterance ASR gets
wrong most, and nothing measures them. It answers "hold on, let me get my card" after 300 ms. A
borrower's "mm-hm" pauses it for up to two seconds. A "yes" spoken while the read-back is still
playing is transcribed, commits a turn, is refused by the fully-heard guard, and the read-back
plays again — eight seconds of the most irritating thing a borrower can hear, on the turn they
were most ready to agree on. On that same turn the system pays a second of model latency to
discover that "yes" means yes. Every fleet number comes from one cooperative, studio-audio borrower
who never interrupts, never backchannels, never has a spouse pick up and never has an accent —
the literature's one consistent finding is that this is the condition under which voice agents
look 30–45 % better than they are. And the judge's verdicts are accepted at face value, with a
raw proportion on the Quality page that no calibration set corrects. Underneath, the instruments
the last spec built are bent in the direction of "fine": the worker's admission ceiling is a
no-op, `/readyz` cannot fail, the dev-mode gate passes a dev-mode worker, and a migration cannot
boot on the Postgres CI uses.

## Solution

Straighten the instruments (Phase 0). Then make the four turn-taking decisions the pipeline
already takes implicitly — respond, wait, resume, hold — explicit, recorded and measured: a hold
lexicon so "one second" gets silence, a backchannel lexicon on the interim transcript so "mm-hm"
resumes the agent at once, and a control-plane `held` state so a "yes" during the read-back is
processed *after* the read-back is heard (Phase 1). Give the enumerable turns a deterministic fast
path with the model as the fallback, recorded per turn so the SLO can see both populations
(Phase 2). Bias the recogniser toward the account's own names and numbers and gate the fleet on
entity accuracy, not only WER (Phase 3). Build the borrower the harness has never had — personas,
telephony degradation, seeded interruptions, a third party on the line — and the turn-taking
metrics the literature defines, as their own segment (Phase 4). Let the judge abstain, and show
the pass rate with its bias correction and interval next to the raw one (Phase 5). Every phase
ends with a fleet run, and every number lands in `conversation_scores` and on the Quality page.

## User Stories

1. As a borrower, I want the agent to stay silent when I say "hold on", so that I can find my card without being talked over.
2. As a borrower, I want my "mm-hm" not to stop the agent mid-sentence, so that the call does not stutter every time I acknowledge something.
3. As a borrower, I want my "yes" during the read-back to count once the read-back finishes, so that I do not hear it twice.
4. As a borrower, I want the amount and date I said to be the ones read back to me, so that I am not correcting the agent's hearing.
5. As a borrower, I want the agent to hear my name correctly on the first try, so that verification does not fail on my accent.
6. As a borrower, I want the confirmation after my "yes" to come immediately, so that the call ends when I agreed, not a second later.
7. As an operator, I want every turn to record whether it was answered by the model or by the fast path, so that latency and quality are compared within a population, not across two.
8. As an operator, I want the SLO page to show fast-path and model turns as separate segments, so that a fast path cannot hide a slow model.
9. As an operator, I want a turn-taking card — false-interrupt rate, yield latency, response rate, agent-interrupt rate, selectivity — so that "it talks over people" is a number.
10. As an operator, I want an entity error rate for amounts, dates and names beside WER, so that a call with a perfect WER and a wrong amount is a red row.
11. As an operator, I want the judge to say "needs a human" when it is not sure, so that agreement is measured on verdicts it stood behind.
12. As an operator, I want the pass rate shown with its bias-corrected value and a confidence interval from the labels I have written, so that I know how much to trust it.
13. As an operator, I want the Quality page to say "uncalibrated" below a minimum number of human labels, so that a corrected number never appears without its basis.
14. As an operator, I want a third-party-pickup scenario scored on non-disclosure, so that the FDCPA rule the state machine encodes is exercised, not assumed.
15. As an operator, I want simulator calls in their own segment, so that a synthetic accent never moves the real-call SLO.
16. As an engineer, I want the worker to refuse the ninth call when the ceiling is eight, so that a burst degrades one call, not all of them.
17. As an engineer, I want `/readyz` to fail when a loop errors on every tick or never started, so that "ready" means the loops are alive.
18. As an engineer, I want the worker's `production` flag to come from the resolved server options, so that the fleet's dev-mode gate cannot be passed by a dev-mode worker.
19. As an engineer, I want the turn-failure log line to carry the conversation and turn ids, so that a failure under load is joinable to its call.
20. As an engineer, I want migration 0005 to degrade to a warning on a Postgres without `pg_stat_statements`, so that CI and a managed database can boot.
21. As an engineer, I want the compose worker's memory limit and its `WORKER_MAX_JOBS` default to agree, so that the N=10 container run does not OOM-kill every call.
22. As an engineer, I want the main worker process not to load `onnxruntime-node` at import, so that the idle tree does not pay 74 MB per process for a module only `prewarm` uses.
23. As an engineer, I want a bounded `held` window so that a turn parked behind a read-back cannot be parked forever.
24. As an engineer, I want the hold/backchannel/intent classifiers to be pure domain functions with table tests, so that their lexicons are reviewable and their misses are reproducible.
25. As an engineer, I want the intent classifier to run on interim transcripts as a prefetch only, so that no interim ever writes to the ledger.
26. As an engineer, I want the fast path to go through the existing tool path and the fully-heard guard, so that it cannot record a promise the model path could not.
27. As an engineer, I want `keyterm`/`numerals` sent on the STT session only after `confirm_right_party`, so that account facts do not reach the STT vendor for an unverified party.
28. As an engineer, I want the simulator's every stochastic element seeded, so that a regression is a diff between two runs with the same seed.
29. As an engineer, I want the simulator built from the pieces the harness has (WAV lines, RMS onset, equivalence runner, resource sampler), so that it is a composition, not a second harness.
30. As an engineer, I want the `unlikelyThreshold`, `interruption.minDuration`, first-clause TTS chunking, `tts_connect_ms` and `service_tier` knobs each measured in a separate A/B with the new metrics, so that a knob is kept for a number, not a hunch.
31. As an engineer, I want to know whether `mode: "adaptive"` interruption is actually running on the self-hosted profile, so that the config is a fact.
32. As an engineer, I want the judge's confidence method chosen on the labelled set (re-judge agreement vs verbalised probability), so that abstention is calibrated, not guessed.
33. As an engineer, I want the bias-correction estimator table-tested against the paper's worked numbers, so that the Quality page's interval is arithmetic, not opinion.
34. As a reviewer, I want ADR 0011 to record the four-way turn disposition, the `held` semantics, the fast-path contract, the entity gate and the simulator's segment rule, so that the next session does not re-argue them.
35. As a reviewer, I want the README status table to distinguish "measured on the scripted borrower" from "measured on the simulator", so that "handles interruptions" has a segment.

## Implementation Decisions

### D0. Phase 0 — straighten the instruments (review §2, items 1–7 and 9–12)

Each is its own commit with the review's item number in the message; none changes behaviour
beyond the defect.

- **Worker admission** (review #1): `requestFunc` increments `admitting`, fires `accept()` without
  awaiting it, then waits until the request's job id appears in the server's active jobs or an
  assignment timeout elapses, and decrements in `finally`. A unit test with a fake request whose
  `accept()` resolves immediately and a stub active-jobs list asserts that a third simultaneous
  request against a ceiling of two is refused. The voice worker gains a test directory. Re-run the
  shed probe with the rooms created **in one batch** so the probe can discriminate, and correct ADR
  0010 D2's wording to describe what the code now does.
- **Migration 0005** (review #2): the extension statement runs inside a nested transaction
  (savepoint) so a failure is recoverable; CI's Postgres service gets the preload flag so the
  measurement exists there too. The load report gains the HOT ratio and dead-tuple lines the
  migration's comment says to watch (review §3).
- **`/readyz`** (review #3, #9): loops are registered with a null tick at construction and null is
  stale after one interval; the tick is stamped only on success, and per batch inside the outbox
  drain; a consecutive-failure gauge is exposed. Handler-level tests for a never-registered loop, an
  always-failing loop and a long drain.
- **Worker `production` flag** (review #4, #17): derived from the resolved server options; the
  heartbeat also reports the *effective* threshold and the pool's *actual* warm count.
- **Log correlation** (review #5): the annotation wraps the failure branch; a logger-replacement
  test asserts both ids on the failure line.
- **Silero import** (review #6): dynamic import inside `prewarm`, type-only at the top; the idle
  tree is re-sampled and the README table corrected. (W11 supersedes this; see Q8.)
- **Compose worker sizing** (review #7): `WORKER_MAX_JOBS` default and `mem_limit` made to agree
  with the arithmetic written beside them; a script asserts the inequality.
- **Score collapse** (review #10): the harness resolves real turn ids from the `turn_start` frame
  it observes, so per-turn scores never share a null key; the fallback logs the collapse if it must
  happen.
- **Dispatch outside the transaction** (review #11): the scheduled-action worker commits, then
  dispatches, then records the result in a second short transaction.
- **SLO verdict** (review #12): tri-state `pass | breach | insufficient`; the console badges
  `insufficient` neutrally; the test that pinned `pass` on an empty window is corrected.
- **O9 bypass token** (review §3): a per-bearer bucket or a bypass token so the harness is not
  rate-limited by its own server, because Phase 4 runs more calls than the default window allows.

Verification: `pnpm check`, `pnpm test:db` (65/66), the shed probe **discriminating** (three rooms
in one batch against `MAX_JOBS=1` → one served, two `NEVER_SERVED`), a killed outbox fiber and an
always-failing outbox both failing `/readyz`, a `dev`-mode worker refused by the fleet without
`--allow-dev`, CI green with the DB job, and the tier-2 N=5 re-baseline on the corrected tree.

### D1. Turn disposition: `respond | wait | resume | held`

The vocabulary comes from the four-state turn models in the research (§3.1); the mechanism from
the SDK facts (§2). It is recorded on every turn.

- **The turn contract** gains a `disposition` on `turn_end` and in `conversation_turns.result`.
  `respond` is today's behaviour. The decider is not consulted for the other three.
- **`wait`**: a pure `holdRequest(normalisedFinalText)` in `domain` — a reviewable lexicon
  ("hold on", "one second", "hang on", "let me check", "give me a minute", a trailing conjunction
  or filler with no content) with table tests including near-misses ("hold on, I can pay Friday"
  → not a hold). T1 appends the borrower line as today; the control plane emits `turn_end` with
  no `say`, and asks the worker (a `turn_end` field) to extend the away timer once, by a bounded
  amount. A second consecutive `wait` is a `respond` with the existing "take your time" line so a
  borrower cannot park the call indefinitely. The disposition is a `TURN_DISPOSITION`-carrying
  field on the existing `AGENT_TURN`/turn-result path, not a new event type unless the ledger
  needs it for replay — decide by whether `replay` must know; the default is no.
- **`resume`**: the same lexicon family, `backchannel(normalisedInterimText)` ("yeah", "okay",
  "right", "mm-hm", "uh-huh", "sure", "got it" — short, no content), run by the **worker** on the
  interim transcript of an interruption that has paused the agent's audio. A pure-backchannel
  interim resumes the paused speech immediately through the SDK's existing resume path rather than
  waiting for the false-interruption timer. If the interim grows past backchannel length before
  the final, the resume is cancelled and the interruption proceeds as today. The worker reports
  `resume` on the next `turn_metrics` so the ledger knows the agent's line was not cut. **Measure
  `interruption.minDuration` first** (D5): if raising it to ~700 ms removes most backchannel pauses
  on the simulator's backchannel scenario, the interim classifier is not built.
- **`held`**: T1, on a turn arriving while the conversation has an **unreported non-interruptible
  segment** (an `AGENT_TURN` with `speak_mode: non_interruptible` and no `AGENT_TURN_PLAYOUT` for
  it yet), does not claim the turn. It parks the request, bounded by that segment's expected
  duration (`tts_audio_ms` if known, else a configured ceiling) plus a margin, and proceeds when
  the playout signal lands — or when the bound expires, in which case it proceeds as today and the
  guard decides. `held` is recorded on the turn with the wait in milliseconds. This is the design
  ADR 0007 named as the precondition for revisiting Flux; Flux itself stays out of scope.
- The worker keeps `discardAudioIfUninterruptible: false`; the read-back's "yes" must reach the
  ledger, which is why `held` exists in the control plane and not as audio discard.

### D2. Deterministic fast path with the model as fallback

- A pure `classifyIntent(state, normalisedFinalText, pendingProposal)` in `domain` returning
  `{ intent, confidence: 0 | 1, value? }` with intents per state:
  `CONFIRMING_OUTCOME → affirm | deny | amend_amount | amend_date | unclear`;
  `DISCUSSING_PAYMENT → hold (D1) | unclear`; all other states → `unclear`. Rules over the
  normaliser the WER gate already uses (contractions, number words, currency, spoken digit runs).
  Any trailing clause, unparseable number, negation ambiguity ("yes but no") or hedge ("I think
  so") is `unclear`.
- The orchestrator's decide phase consults it **after** `matchOverride` and before the model:
  `affirm` executes `record_promise_to_pay` through the **existing tool path** (the fully-heard
  guard included) and speaks the existing confirmation script as `say` frames; `deny` transitions to
  `DISCUSSING_PAYMENT` with the existing renegotiate line; `amend_*` rebuilds the proposal with the
  parsed value and re-issues the read-back through the proposal tool. `unclear` → the model, as
  today. The fast path never produces text the model path could not have produced through the same
  tools.
- Every turn records `decider: "fast_path" | "openai" | "scripted" | "override"` in its result and
  on its span; `Quality.sloStatus`'s segment gains `decider` at the turn level (it has it at the
  conversation level already), so the SLO page shows fast-path and model turns separately, and
  the equivalence harness asserts which turns took which path in the reference scenario.
- **Interim prefetch** is the stretch: the worker runs the same classifier on interims and sends
  its answer with the turn so the control plane skips the classification; it never writes. Build
  only if the measured fast-path turn latency is not already dominated by EOU + TTS.

### D3. Contextual hearing and the entity gate

- The worker's STT session options carry `keyterm` (borrower first/last name, creditor name),
  `numerals: true`, and `keywords` for month names and the amounts the account implies (balance,
  minimum, round figures near them) — delivered on the session bootstrap response **only after**
  `confirm_right_party`, through the same protected-context gate the prompt uses; before
  verification the session runs with the defaults. The Deepgram plugin forwards all of these
  (research §2); verify the exact parameter shapes against the installed `stt.js` before use.
- The harness gains **entity error rate**: for each scripted line carrying an amount, date or
  name, whether the STT final contains it after normalisation; a per-call `stt.entity_er` score
  with per-class counts in its comment, next to `stt.wer`. The fleet gate adds
  `--max-amount-errors 0` (an amount error is a wrong promise, not a degraded transcript). Dates and
  names are reported, not gated, until the simulator's accent personas say what the floor is.
- If the model path proposes an amount that appears in neither the transcript nor the account's
  plausible set, the evaluator already has a place for it: a `factual_accuracy` evidence line. No
  new guard; the read-back plus D2's `amend_*` is the correction path.

### D4. Tier 3 — the seeded borrower simulator and the turn-taking metrics

- `sim-borrower` composes what exists: the scripted lines and the clarification answer
  (WAV-cached per persona), the RMS onset detector, the equivalence runner, the resource sampler,
  the borrower-process isolation. New: **personas** (≥ 5 TTS voices/accents, fixed per seed),
  **audio degradation** (G.711 μ-law 8 kHz round trip, background noise at a target SNR, seeded
  burst noise, seeded frame drops with a two-state loss model, optional muffling), and a
  **turn-taking policy** that is a table of seeded events, not an LLM: interrupt at offset *t* ms
  into the agent's *k*-th line, backchannel at *t*, a single "hold on", a third-party voice
  answering one turn, an involuntary sound.
- **Scenarios** (each a seeded table, each with an expected ledger shape the equivalence runner
  checks): yes-during-read-back (expects one read-back, one promise, `held > 0`); backchannel
  mid-line (expects no truncated agent line, `resume` recorded); hold request (expects `wait`, no
  agent speech until the next borrower line); third-party pickup (expects
  `THIRD_PARTY_OR_WRONG_PARTY`, **no balance in any agent line** — a compliance score); accent ×
  noise ablations of the happy path (expect equivalence, report entity error rate).
- **Metrics**, defined once in `domain` from the events the harness already records (agent audio
  onset/offset from RMS, borrower line start/end from the script, interruption offsets from the
  table): `turn.response_rate`, `turn.yield_rate` (agent audio stops within 2 s of a real
  interruption), `turn.yield_latency_ms`, `turn.false_interrupt_rate` (agent stopped on a
  backchannel/noise event), `turn.agent_interrupt_rate` (agent onset before the borrower line's
  end), `turn.selectivity` (backchannels and non-directed speech correctly ignored), and the
  barge-in `T90` from an interrupt-offset sweep. All are harness scores with the same "harness
  metric" labelling as WER; the Quality page gets a turn-taking card that names the segment.
- **Segment rule**: simulator calls carry `channel: "voice"`, `decider` as served, and a
  `harness: "sim"` marker persisted with the conversation (extend the existing decider column's
  neighbour, not a new table), and `sloStatus` excludes them from the default segment.
- The judge may run on a labelled sample of simulator calls (Q5 of the ground rules) to seed D5's
  calibration set; the cost is written in the run report.

### D5. The knobs, each an A/B on N=5 with the D4 metrics

In this order, one commit each, kept only for a number:

1. **Is `mode: "adaptive"` running?** Log `InterruptionMetrics` (`numRequests`, `numBackchannels`)
   at session end on the self-hosted profile. If zero, the worker has been on VAD interruption; the
   config is corrected to say so and the rest of this list is measured against the truth.
2. **`interruption.minDuration`** 500 → 700 ms on the backchannel scenario: false-interrupt rate
   and yield latency. Decides whether D1's `resume` classifier is built.
3. **`unlikelyThreshold`** (`en`, 0.36) sweep 0.25 / 0.36 / 0.45: `eou_delay_ms` p95 against
   agent-interrupt rate on the hold and hesitation scenarios.
4. **First-clause TTS**: a smaller `minSentenceLength` (or a first-chunk clause split) for the
   first chunk of a turn: `tts_ttfb_ms` and first-audio onset p50, with the chars/s heuristic as
   the guard.
5. **`tts_connect_ms`**: instrument the per-stream websocket connect (the plugin is patched
   already; the patch grows a timing hook). If ≥ 100 ms p50, a per-session warm socket is the next
   spec's decision.
6. **`service_tier: "priority"`** on the decider: `ttft_ms` p50/p95 and the cost delta written
   down.

### D6. Judge abstention and bias-corrected quality numbers

- The judge job computes a per-dimension **confidence** by one of two methods chosen on the
  existing labelled calls: *k* re-judgements (the paper's simulated annotators) or a verbalised
  probability field in the existing JSON schema. Below a threshold the dimension is written as
  `judge.abstained` with the evidence it did find; the console shows "needs a human" and the
  agreement number is computed over accepted verdicts, with the abstention rate beside it.
- A pure `correctedPrevalence(observedPositiveRate, sensitivity, specificity, nTest, nCal)` in
  `domain` returning the Rogan–Gladen point estimate and the plug-in interval from the research's
  reporting paper; sensitivity/specificity come from the human labels the operator already writes.
  The Quality page shows raw and corrected pass rate, the interval, and *n* of the calibration set,
  and says "uncalibrated" below a configured minimum.
- Cascading (a cheaper judge first, escalate on low confidence) is optional and cost-only; not
  built unless the judge's cost line on the Quality page says it should be.

### D7. Documentation and ADR 0011

- **ADR 0011** (`domain-modeling`): the four-way disposition and why `held` is a control-plane
  decision; the fast-path contract (rules, confidence ∈ {0,1}, through the tools, recorded per
  turn); contextual biasing behind the right-party gate; the entity gate as the fifth gate; the
  simulator's segment rule and why its turn-taking is scripted; judge abstention and why corrected
  numbers never appear uncalibrated. Amends nothing; extends ADR 0007 (hold), 0009 (judge), 0010
  (segments).
- README status rows: "turn-taking (measured on the simulator)", "entity accuracy", "fast path",
  "judge calibration"; the "Not built" list gains what Q7 leaves out.
- `docs/loadtest/README.md`: a Tier 3 section with the metric definitions and the first numbers.
- PROGRESS.md row 12 corrected (Phase 5 landed); a row 13 for this spec.

## Testing Decisions

- A good test asserts external behaviour on an existing seam: the ledger and `conversation_scores`
  after a turn or a job, the `turn_end` frame, the fleet/tier-3 report JSON, the Quality JSON, the
  recording `Tracing`'s captured records — never the SQL text, the lexicon's internals, or the
  worker's private state.
- **Domain (pure, `tdd`)**: `holdRequest`, `backchannel`, `classifyIntent` table tests with
  near-misses (a hold that carries an offer; a "yes" with a hedge; a backchannel that grows into a
  sentence); entity-error normalisation on the scripted lines; the turn-taking metric functions on
  synthetic event tables (a call with two backchannels and one real interruption yields the
  expected six numbers); `correctedPrevalence` against the paper's worked example and the
  degenerate cases (sensitivity + specificity = 1, empty calibration).
- **Control plane (DB)**: `wait` appends the borrower line and emits no `say`; a second `wait`
  responds; `held` parks a turn until the playout signal and the promise records on the first
  attempt (the existing supersede/read-back tests are the prior art); a `held` turn whose bound
  expires proceeds and the guard decides; `affirm` records through the tool path and a
  fast-path turn that fails the guard is `TOOL_REJECTED` like a model turn; every turn result
  carries `disposition` and `decider`; simulator conversations are excluded from the default SLO
  segment. Prior art: `concurrency.test.ts`, `quality.test.ts`, `evaluationJob.test.ts`.
- **Worker (new `test/` directory)**: `requestFunc` admission with a fake request; the
  backchannel-resume decision as a pure function over interim events; STT options assembled only
  after right-party confirmation.
- **Harness**: report schema requires the entity block and, for tier 3, the turn-taking block and
  the seed; the fleet refuses `--max-amount-errors` > 0 unless `--allow-amount-errors`.
- **Live**: every phase's verification below; each D5 knob is an N=5 A/B with the D4 metrics.

## Out of Scope

- Flux / any STT swap; a second EOU model; SDK upgrade past 1.6.4.
- An LLM-driven borrower simulator; LLM-generated borrower text.
- Emotion tracking, persuasion strategy, mid-call outcome forecasting.
- Any KV-cache or serving-side work; the decider stays behind the OpenAI API.
- TTS socket pooling (measure only, D5.5).
- The review §3 items not named in Phase 0 (incremental replay, `toolSpecsFor` memo, semi-space,
  prepared statements, SSE coalescing, Langfuse retention, CI image job, upstream W1 issue) — the
  user's decision: build or record.
- Phases 7–9 of the efficiency spec, except as sequenced in Q8.
- Everything ADR 0008/0009/0010 rejected.

## Further Notes

### Suggested phase order (one or more commits each; verify per phase)

| Phase | What | Verification |
|---|---|---|
| 0 | D0 — the eleven instrument fixes + O9 bypass + HOT/dead-tuple report line | `pnpm check`; `test:db` 65/66; discriminating shed probe; `/readyz` fails on an always-failing loop; dev-mode worker refused; CI green; N=5 re-baseline on the corrected tree |
| W11 | **Mandatory (Q8): native VAD** — `inference.VAD` replaces `silero.VAD.load()`; `onnxruntime-node` and `@livekit/agents-plugin-silero` leave the tree; Dockerfile hand-prune deleted | equivalence + WER + `eou_delay_ms` p95 unchanged-or-better on N=5, **twice**; idle tree re-sampled; README table corrected |
| 1 | D4 first half: tier-3 harness with the clean persona, the metric functions, the scenario tables — **before** D1 so D1 has a baseline | tier 3 green on the clean persona; the six turn-taking numbers reported for the current system; yes-during-read-back scenario reproduces the repeated read-back |
| 2 | D5.1–D5.2 (is adaptive running; `minDuration`) then D1 (`wait`, `held`, and `resume` only if D5.2 says so) | tier-3 hold/backchannel/read-back scenarios; false-interrupt resume p50 < 300 ms; zero guard-rejected promises on the read-back scenario; N=5 equivalence twice |
| 3 | D2 fast path (+ interim prefetch only if measured necessary) | 20/20 + new scenarios; fast-path turn p50 < 700 ms; model-path p50 unchanged; zero fast-path `TOOL_REJECTED`; SLO page shows both segments |
| 4 | D3 contextual hearing + entity gate; D4 second half (personas, degradation, third-party scenario) | amount entity error = 0 on N=5 twice, clean and realistic personas; WER not worse; third-party scenario scores non-disclosure |
| — | **Stop here if out of time.** Phases 0–4 are the core; the README and ADR 0011 can be written at this point. | |
| 5 | D5.3–D5.6 knobs, one A/B each | each kept or reverted with its number |
| 6 | D6 judge abstention + corrected rates | estimator tests; agreement on accepted verdicts ≥ overall; Quality page shows raw/corrected/interval/n |
| 7 | D7 ADR 0011, README, loadtest README, PROGRESS; then the efficiency spec's Phase 8–9 as the user schedules them | the numbers in the README are the ones the runs produced |

### Decisions the implementer should not re-open

- `held` is decided by the control plane from the ledger's playout truth, not by discarding audio
  in the worker. The borrower's words during a read-back are evidence.
- The fast path is rules with confidence 0 or 1, through the existing tools and guard, recorded
  per turn. "The model would probably have said yes" is not a fast path.
- Account facts reach the STT vendor only after right-party verification, like the prompt.
- The simulator's turn-taking is a seeded table. Reproducibility outranks realism here because
  the harness runs in real time against a real SFU.
- Simulator numbers are their own segment and gate nothing until a human has labelled a sample.
- A corrected quality number never appears without its calibration *n*; below the minimum the
  page says "uncalibrated".
- Tools and `response_format` are never on the same request (research §3.6).

### Risks and how each is caught

- **A hold lexicon that eats offers** ("hold on, I can do Friday"): the table tests carry the
  near-misses, and the `wait` disposition is visible per turn on the console, so a mis-hold is a
  row, not a mystery.
- **`held` parks a turn forever**: the bound is the segment's own duration plus a margin; the
  expiry path is tested; the wait is recorded in milliseconds.
- **The fast path records a promise the borrower did not make**: it cannot — it goes through the
  same tool and the same guard; the equivalence harness asserts the path taken.
- **Contextual biasing biases the wrong way** (a keyterm makes the recogniser hear the name where
  there was none): the entity metric counts insertions as well as misses; the accent personas are
  the test.
- **The simulator flatters or punishes by persona choice**: personas are fixed per seed and
  reported by name; the literature's finding (accents cost most, and provider-specifically) is the
  reason to report per persona and never as one average.
- **The instruments Phase 0 fixes move the baselines**: that is why Phase 0 ends with an N=5
  re-baseline, and why nothing in Phases 1–4 is compared with the 2026-08-28 table.

### Research inputs (summarised in the research doc §3; not repeated here)

Four-state turn models (2502.14145, 2509.23938); FireRedChat's and τ-Voice's metric definitions
(2509.06502, 2603.13686); prefix speculation and cascade routing as the shape of the fast path
(2603.23346, 2410.10347, 2311.09758); short-utterance ASR failure and contextual biasing
(2602.12249, 2506.10779, 2309.00723); Sim2Real constraints on simulated users (2601.17087,
2603.11245, 2510.05444); third-party interruption (2604.17358); selective judging and
bias-corrected reporting (2407.18370, 2511.21140, 2503.05061); the constraint-tax rule
(2606.25605).
