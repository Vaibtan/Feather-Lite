# Spec: the quality & SLO layer — scores, judge, reliability, STT/TTS quality, outcome funnel

2026-08-26. For the implementing session. Today the platform traces **latency, LLM cost and
correctness** per turn (ADR 0007/0008, `Tracing` service) but has **no quality or SLO layer**: no
Langfuse scores, no LLM-as-judge, no STT/TTS quality signal, no provider error rates, no outcome
funnel, and a post-call `EVALUATION` job that is two regexes. This spec adds that layer without
adding a second observability system: everything lands in the **ledger first** (Postgres, replayable)
and is **mirrored to Langfuse as scores** through the one seam that already exists.

Read before touching code: `docs/adr/0007-*.md` and `0008-*.md` (tracing shape, playout truth),
`docs/loadtest/README.md` (what the harnesses gate on), SPEC §17 (required metrics — several are
still unmet and are closed here), `docs/plans/2026-08-22-context-latency-fixes-and-observability-spec.md`
(house style: ground rules, one change per commit, verification per phase).

## Ground rules (inherited from the 08-22 spec; restated because they still bite)

1. **Nothing is done until it has been run.** Every phase ends with the verification listed for it.
   Report what passed and failed, with output.
2. **One behavioural change per commit**, reasoning + measured before/after in the message. Run the
   `code-review` skill on the diff before each commit lands, and **always make the commit through
   the `commit-work` skill** — never a bare `git commit`. The other repo skills are there to be
   used: `wayfinder` if a phase turns out bigger than one session can hold, `tdd` for the pure
   modules, `diagnosing-bugs` for voice-path misbehaviour, `domain-modeling` for ADR 0009.
3. **Verify every library API against current docs** (`find-docs` / `ctx7`) before use. Pinned:
   `@livekit/agents@1.6.4`, Langfuse JS SDK v5 (`@langfuse/tracing`, `@langfuse/otel`; scores need
   `@langfuse/client` — check its `score.create` signature, and specifically whether `sessionId` is
   an accepted target in the JS types; the research could confirm it only for the REST body and
   the Python SDK. If the JS SDK lacks it, score the **trace** of the conversation's first turn and
   carry `conversation_id` in the score comment/metadata).
4. **Known-failing test:** `pnpm test:db` is 28/29 (`workers.test.ts` pinned date). Pre-existing,
   not approved for fixing — ask before touching, do not count it against your phases. Everything
   else stays green: `pnpm check` (95 domain + 30 control-plane unit), 20/20 scenarios.
5. **Voice verification** is `pnpm --filter @feather-lite/voice-worker fake-borrower` on the local
   stack, ending `voice/sim equivalence: PASS`. Environment gotchas: kill zombie workers first
   (`Get-NetTCPConnection -RemotePort 7880 -State Established` — filter by process start time, the
   harness client also connects to 7880); `.env` is read once at boot; `TURN_DECIDER=openai` must be
   in the **server process env** for real-decider runs; `Tee-Object` locks old log files — use a new
   filename per restart; the fleet report filename is date-stamped only, copy the committed baseline
   aside before a re-run.
6. **Cost discipline.** The judge is an LLM call per call. It runs only from the outbox (never on the
   turn path), is off by default in tests (`RecordingLlmClient`), and is off for tier-1 load runs.
7. **Do not re-propose** anything ADR 0008 rejected (preemptive generation, `queueSizeMs`, in-call
   `call_facts`, external memory services).

## Problem Statement

The operator (and the interviewer reading this repo) can see *how fast* and *how expensive* every
turn was, and whether the ledger is correct against a scripted reference. They cannot answer:
"was that a *good* call?", "is the agent actually resolving accounts?", "which provider is failing
and how often?", "did the borrower's words get transcribed right?", "did the borrower hear anything?"
— and when a worker dies mid-call the conversation is orphaned forever and blocks that borrower.
There is also no place where a human can record a label, so nothing can ever be calibrated.

## Solution

One **score model** (`conversation_scores`, ledger-side) fed by four producers — the deterministic
post-call evaluator, an LLM judge, the voice harness (STT WER, playout facts), and humans — mirrored
to Langfuse as scores on the conversation's session/trace so quality sits beside latency and cost.
One **reliability model**: provider events counted in the ledger and `Metrics`, an orphaned-call
sweeper, and SLO percentiles on `/api/system/status`. One **funnel query** over the ledger (contact →
right-party → promise-to-pay → promise due/kept-status). A **Quality** view in the console reads all
of it. Everything is derivable from events + scores, so it replays and it is testable on the
existing seams.

## User Stories

1. As an operator, I want a per-call quality score set (compliance, task completion, empathy, accuracy) beside its latency waterfall, so that I can find bad calls without listening to all of them.
2. As an operator, I want each judge score to carry a one-line evidence quote from the transcript, so that I can verify the verdict in seconds.
3. As an operator, I want the deterministic compliance checks (Mini-Miranda first, no protected data before verification, no promise without read-back) to be scores, not a buried job result, so that they aggregate and alert.
4. As an operator, I want the judge to use binary pass/fail per dimension with a short rationale, so that scores are calibratable against my own labels rather than a vague 1–5.
5. As an operator, I want to record my own pass/fail label on a call in the console, so that judge agreement can be measured.
6. As an operator, I want a judge-vs-human agreement number on the Quality page, so that I know whether to trust the judge.
7. As an operator, I want the judge to run after the call in the outbox with retries, so that a judge outage never touches a live call.
8. As an operator, I want to turn the judge off with one env var, so that load tests and CI do not spend money.
9. As an operator, I want an outcome funnel — attempts, connected, right-party confirmed, promise-to-pay, callback, failed — for the last N calls and for a date range, so that I can see whether the agent is closing accounts.
10. As an operator, I want a promise-to-pay row to show its due date and whether it is pending, due today, or overdue, so that the "promise kept" question has a home even before payment data exists.
11. As an operator, I want to see the right-party-verification success rate and voicemail rate (SPEC §17.2), so that the required metrics are finally all present.
12. As an operator, I want provider error and retry counts per provider (OpenAI, Deepgram STT, Deepgram TTS, LiveKit) with the last error message, so that I know which vendor is degrading.
13. As an operator, I want the TTS-silent-playout count, the zero-heard read-back count, and the decider-unavailable count as first-class counters, so that the failure modes ADR 0008 found are watched, not rediscovered.
14. As an operator, I want per-call and fleet rates for barge-in, no-input, superseded turns, degraded turns, and turn timeouts, so that I can see conversational health, not only speed.
15. As an operator, I want p50/p95/p99 turn latency against a stated target (p95 ≤ 2500 ms end-to-end, per-stage sub-targets) with a pass/fail on status, so that latency is an SLO, not a number.
16. As an operator, I want a conversation that lost its worker to be finalized automatically as FAILED (reason ORPHANED) after a staleness window, so that the borrower is not blocked forever.
17. As an operator, I want the sweeper's action to be a normal ledger event, so that it replays and shows in the timeline like any other close.
18. As an operator, I want an orphaned-call count and mean time-to-detect, so that the chaos scenario becomes measurable.
19. As an engineer, I want the harness to compute WER for every borrower line it speaks (it knows the exact text), so that STT quality is a number per run and per fleet.
20. As an engineer, I want WER normalization to be explicit (lowercase, punctuation stripped, digits and number-words unified, contractions expanded), so that the metric does not drift with formatting.
21. As an engineer, I want a WER regression gate in the fleet report (fail the run above a threshold), so that an STT provider or model change cannot silently degrade transcription.
22. As an engineer, I want the harness to post its measured scores (WER, response latency, equivalence pass) to the conversation, so that harness runs and production calls share one score model.
23. As an engineer, I want TTS "audible" facts per agent turn — audio duration, characters, chars-per-second, silence-before-first-frame — so that a broken or wildly slow voice shows up as a heuristic outlier even without a MOS model.
24. As an engineer, I want the scenario suite run to emit a scenario pass-rate score (SPEC §17.2) into the same store, so that CI correctness and call quality are on one page.
25. As an engineer, I want every score mirrored to Langfuse with `conversation_id`, `turn_id` where applicable, and a stable `name`, so that Langfuse dashboards and the console never disagree.
26. As an engineer, I want the score writer to be a Layer with Langfuse / recording / noop variants like `Tracing`, so that tests assert scores without a network.
27. As an engineer, I want the judge to go through the existing `LlmClient` seam, so that the recording fake makes judge tests deterministic and the leak test covers the judge prompt.
28. As an engineer, I want the judge prompt to never receive protected account data beyond what the transcript already contains, so that the judge is not a new leak path.
29. As an engineer, I want `GET /api/conversations/:id/scores` and `POST /api/conversations/:id/scores` (bearer-protected), so that harnesses and humans have one ingest path and the console one read path.
30. As an engineer, I want `GET /api/system/quality` (funnel + rates + SLO + agreement for the last N calls or a range), so that the console's Quality view is one request.
31. As a reviewer of this repo, I want the README status table to say exactly what is measured and what is a heuristic, so that TTS "quality" is not overclaimed.
32. As a reviewer, I want an ADR recording why scores live in Postgres first and Langfuse second, why the judge is binary, and why UTMOS/NISQA were not built, so that the next session does not re-argue it.

## Implementation Decisions

### D1. One score model, ledger-side, mirrored to Langfuse

- New table `conversation_scores`: id, conversation_id, turn_id (nullable), name, value (numeric),
  data_type (NUMERIC | BOOLEAN | CATEGORICAL), string_value (nullable), source
  (EVALUATOR | JUDGE | HARNESS | HUMAN | SCENARIO | SYSTEM), comment (nullable, ≤ 500 chars),
  evidence (jsonb, nullable), created_at. Unique on (conversation_id, turn_id, name, source) — a
  re-run **upserts**, matching Langfuse's idempotent score `id`.
- Scores are **not** conversation events. Writing one must not lock the conversation row or touch
  `sequence_no`; a re-judge must not change the replayable ledger. The evaluator's *existence* is
  still recorded as today's `OUTBOX_PROCESSED` event; the values go to the scores table.
- `Tracing` grows a `score(record)` operation (same Layer discipline: Langfuse / Recording / Noop).
  Langfuse target: the conversation **session** if the JS SDK accepts `sessionId`, else the trace
  of the conversation's first emitted turn; turn-level scores target that turn's observation.
  Score `id` = deterministic hash of (conversation_id, turn_id, name, source) so retries upsert.
- Score names are a closed vocabulary in the domain package (so the console and Langfuse never
  see a typo): `compliance.mini_miranda_first`, `compliance.no_protected_before_rpc`,
  `compliance.no_promise_without_readback`, `judge.task_completion`, `judge.compliance`,
  `judge.factual_accuracy`, `judge.empathy_professionalism`, `judge.escalation_judgment`,
  `judge.overall_pass`, `stt.wer`, `stt.wer_worst_line`, `tts.silent_playout`,
  `tts.chars_per_second`, `latency.response_ms` (turn-level), `latency.slo_pass`,
  `harness.equivalence_pass`, `scenario.pass_rate`, `human.overall_pass`.

### D2. Deterministic evaluator (extend the existing EVALUATION outbox job)

- Keep the job; replace the two regexes with a **pure function in the domain package** that takes
  the event list + transcript and returns compliance facts. Add: `no_promise_without_readback`
  (every `record_promise_to_pay` TOOL_RESULT is preceded by an AGENT_TURN_PLAYOUT marked fully
  heard for the read-back), `right_party_verified` (boolean), `voicemail` (AMD_RESULT payload),
  `barge_in_count` (TURN_SUPERSEDED), `no_input_count`, `degraded_turns`, `tool_rejections` by
  reason, `agent_turns`, `borrower_turns`, `duration_ms`. Each becomes a score; the job result keeps
  the `issues[]` / `compliance_ok` shape for backward compatibility.
- Protected-data detection stays a regex today but reads its patterns from the same place the
  context gate does, so the two cannot disagree.

### D3. LLM judge (new outbox job type `JUDGE`)

- Separate job type from EVALUATION: different retry budget, separately switchable
  (`JUDGE_ENABLED`, default false in tests/CI and tier-1 load runs; **true in the dev `.env`** —
  the user has confirmed cost is not a constraint).
- **Judge model: GPT-5.6 Luna, and only that model — decided by the user 2026-08-26 (OpenAI
  credits only).** Per the current OpenAI changelog (checked via `ctx7`) the GPT-5.6 family has
  three tiers — Sol (frontier), Terra (balanced), Luna (efficient, high-volume); the user chose
  Luna explicitly. The implementer confirms the exact model-id string for Luna on OpenAI's
  models page (expected form `gpt-5.6-luna`; the docs' generic examples use `gpt-5.6`, which is
  **not** acceptable here) and pins it as the `JUDGE_MODEL` default — no substitution with any
  other tier or family, no fallback model. Request shape: Chat Completions with
  `reasoning_effort: "medium"` (raise to `"high"` if calibration against human labels shows it
  helps), strict structured output (`response_format: { type: "json_schema", json_schema:
  { strict: true, schema } }` with every property in `required` and `additionalProperties:
  false`), non-streaming, `max_completion_tokens` ≈ 4 000 (reasoning tokens count). **Reasoning
  models reject `temperature`**, so the OpenAI `LlmClient` must omit sampling params when the
  model is a reasoning model (`ChatRequest` carries a `temperature` today). Verify each parameter
  with `find-docs` before coding.
- Self-preference: the decider is `gpt-4.1` / `4.1-mini`, so judge and decider are different models
  of the same vendor — weaker isolation than a cross-vendor judge, mitigated by the
  evidence-before-verdict prompt, the deterministic evaluator facts fed in, and the human-label
  agreement metric (D3, last bullet). A non-OpenAI judge remains possible later through the same
  seam without touching the job.
- Implementation: the existing OpenAI `LlmClient`, parameterised per call (`JUDGE_MODEL`,
  default = the verified Luna id; `JUDGE_REASONING_EFFORT`, default `medium`); the recording fake serves both
  decider and judge. No new SDK.
- Input: the transcript as heard (uses heard-text for barged-in lines), the state path, tool
  sequence, outcome, and the deterministic evaluator's facts (so the judge does not re-derive what
  the ledger already knows). **Not** the raw prompt, not account context beyond the transcript.
- Output contract (JSON, validated with an Effect schema; invalid → retry once, then a
  `judge.invalid_output` score of 1 and no dimension scores): per dimension `{ pass: boolean,
  rationale ≤ 200 chars, evidence: quoted transcript span }`, plus `overall_pass` and
  `confidence` (0–1). Dimensions: task completion, compliance, factual accuracy (vs. the account
  facts the ledger shows were disclosed), empathy/professionalism, escalation judgment. Binary per
  dimension (Hamel Husain's finding that binary expert labels calibrate better than scales; the
  Hamming rubric supplies the dimension list). The prompt must warn against the "friendly wrong
  call" (fluency does not imply success) and ask for evidence before verdict.
- Through `LlmClient` (non-streaming path or drain the stream); traced as its own Langfuse
  generation named `judge:<model>` under a `judge` span in the conversation's session, with usage.
- Human labels: `POST /api/conversations/:id/scores` with `source: HUMAN`; the console detail view
  gets a pass/fail + note control. Agreement = share of calls with both `judge.overall_pass` and
  `human.overall_pass` where they match, on the Quality endpoint.

### D4. STT quality — WER from the harness, gated in the fleet

- The harness already owns the exact borrower text per line (`line-cache`). After each borrower
  line's `USER_TURN_FINAL` is observed, compute WER (canonical S+I+D / N via Levenshtein over
  tokens — do **not** use the npm `word-error-rate` package's max-length normalisation) with a
  normaliser in a small pure module: lowercase, strip punctuation, expand common English
  contractions, map number words ↔ digits one way, collapse whitespace. Unit-tested.
- Harness posts `stt.wer` per turn and the call mean + worst line as conversation scores
  (`source: HARNESS`), and prints them; the fleet report gains `wer` p50/p95 and a threshold
  (`--max-wer`, default 0.15) that fails the run. Baseline it once on N=5 before enabling the gate.
- Production calls have no ground truth; WER stays a harness metric and the README says so.

### D5. TTS quality — honest heuristics, no MOS model

- Worker already reports TTS TTFB and detects zero-audio playout. Add to the `turn_metrics`
  signal: `tts_audio_ms` (played duration), `tts_chars`, and derive `tts.chars_per_second`;
  flag `tts.silent_playout` (already known) as a score. Fleet-level: silent-playout rate, TTFB
  p95, chars/s outliers beyond ±40 % of the voice's rolling median (a heuristic, labelled as such).
- UTMOS/NISQA are Python-only; out of scope. The harness's RMS-onset measurement stays a latency
  probe, not a quality claim.

### D6. Reliability: provider events, counters, sweeper, SLO

- New ledger-free signal from the worker: `provider_event { provider, kind: error|retry|timeout,
  stage: stt|tts|llm|media, message }` → `Metrics` counters keyed `provider_<name>_<kind>` and a
  last-error ring on status. Control plane counts its own OpenAI retries/failures the same way
  (the decider's one-retry path and `DECIDER_UNAVAILABLE`).
- Counters added: `tts_silent_playouts`, `readbacks_repeated_unheard`, `decider_unavailable`,
  `turns_superseded`, `no_input_closes`, `calls_orphaned`. Rates on the quality endpoint are
  computed from the ledger (durable), counters are the live process view — both shown, labelled.
- **Orphaned-call sweeper** (policy decided 2026-08-26: the user asked for a window as small as
  possible without compromise). Detection is **worker-liveness-based, not event-silence-based**,
  because silence is normal in a call (a 50 s read-back, a thinking borrower) while a dead worker
  is not:
  1. The worker's heartbeat (already every 10 s) additionally carries the list of conversation
     ids it is currently serving; the control plane records the last-seen time per conversation.
  2. A conversation is a *candidate* when it has no final outcome and no worker has claimed it in
     a heartbeat for `ORPHAN_MISSED_HEARTBEATS` = 3 intervals (30 s).
  3. Before finalizing, the sweeper **confirms against the media plane**: it asks LiveKit (via
     the existing `CallControl` room API) whether the room still has an agent participant. Room
     gone or agent absent → orphan; agent still present → the worker is merely slow/blocked, skip
     and count `sweeper_deferred`. This confirmation is what lets the window be short without
     false positives.
  4. Finalize through the existing hangup signal path with reason `ORPHANED`, outcome FAILED, a
     `CALL_CONTROL` event carrying the reason; time-to-detect recorded as a SYSTEM score.
  Sweep every 10 s → worst-case detection ≈ 40 s, typical ≈ 35 s. Simulated (workerless)
  conversations are not in scope for this sweeper; an idle-timeout for abandoned console
  simulations is a separate, longer rule (`SIM_IDLE_TIMEOUT_MS`, default 10 min) and may be
  deferred. Constants are config so the window can be tightened further once measured.
- **SLO**: targets in config (`SLO_TURN_P95_MS` default 2500; per-stage EOU 700 / STT 600 /
  TTFT 1500 / TTS-TTFB 600) evaluated by the existing `latencyAggregate`; status exposes
  `slo: { pass, measured, targets }`. The 800 ms–1.5 s "natural" band in vendor literature is not a
  target here — the measured local p50 is 1.5–2.1 s and the target must be honest.

### D7. Outcome funnel

- `Queries.funnel(range | lastN)`: attempts (CALL_STARTED), connected (non-NO_ANSWER,
  non-voicemail), right-party (STATE_TRANSITION triggered_by RIGHT_PARTY_CONFIRMED), promise
  (record_promise_to_pay TOOL_RESULT ok), callback, failed, orphaned; rates as ratios of the
  previous stage (industry definitions: contact rate, RPC rate, PTP rate).
- Promise-kept needs payment data that does not exist. Provide `promise_status` per PTP row:
  PENDING / DUE_TODAY / OVERDUE computed from the promised date vs. the clock (VirtualClock-aware
  for seeded data); a `record_payment` tool is out of scope and named as the missing input.

### D8. API and console

- Routes: `GET/POST /api/conversations/:id/scores`, `GET /api/system/quality?calls=N|from&to`.
  Both in `contracts` (OpenAPI), bearer-protected like the rest.
- Console: **Quality** view (funnel, rates, SLO card, provider errors, judge/human agreement, WER
  when present), score list + human label control on conversation detail, scores column on the
  fleet latency page.

### D9. Scenario suite as a scored run (small)

- The scenario run-all endpoint writes a `scenario.pass_rate` SYSTEM score against a synthetic
  "suite" conversation id per run, and mirrors it to Langfuse. Langfuse datasets/experiments are
  **not** adopted — the scenario suite is already the dataset and lives in the repo.

## Testing Decisions

- A good test asserts **external behaviour on an existing seam**: the ledger + scores after an
  API call or a job run, the recording `Tracing`'s captured scores, the status/quality JSON —
  never the internals of the judge prompt or the SQL.
- **Domain (pure, vitest):** evaluator facts from event fixtures (prior art: replay/transcript
  tests); WER + normaliser table tests; judge output schema validation.
- **Control plane DB tests (prior art: the 20 scenarios, the LLM leak test):** EVALUATION job
  writes the expected scores and upserts on re-run; JUDGE job with `RecordingLlmClient` returning a
  canned verdict writes dimension scores and the evidence; invalid judge JSON → `judge.invalid_output`
  only; leak test extended: the judge request body never contains protected fields; sweeper test
  with a shifted VirtualClock finalises a stale conversation once and leaves a live one alone;
  funnel query on seeded history returns the known counts; quality endpoint shape.
- **Recording Tracing:** every score written to Postgres is also handed to `Tracing.score` with the
  same name/value.
- **Harness:** `fake-borrower` prints WER per line and posts scores; fleet N=5 emits WER p50/p95
  and honours `--max-wer`. Verified live, numbers in the commit message.
- **Chaos, semi-automated:** kill the worker mid-call, assert the sweeper finalises within
  `ORPHAN_STALENESS_MS + 30 s` and the borrower can be called again. Script it under the tracer
  directory; it is the README's missing chaos test.

## Out of Scope

- MOS-class TTS quality (UTMOS/NISQA/Python sidecar); any audio-quality *claim* beyond heuristics.
- Production WER (no ground truth); STT provider A/B.
- Payment ingestion and true promise-kept rate (`record_payment` tool).
- Langfuse datasets/experiments; Langfuse's built-in evaluator UI (push scores instead — works on
  OSS self-hosted regardless of feature tier).
- Alerting/paging, Prometheus/OTel metrics export, dashboards outside the console.
- Everything ADR 0008 rejected; PSTN, always-on VM, horizontal scale.

## Further Notes

- **Suggested phase order** (one commit each, verify per phase): (1) score model + `Tracing.score`
  + API; (2) evaluator rewrite → scores; (3) reliability counters + provider events; (4) sweeper; (5) SLO + funnel + quality endpoint; (6) WER in harness +
  fleet gate; (7) TTS heuristics; (8) judge + human labels + agreement; (9) console Quality view;
  (10) scenario score, README status rows, ADR 0009.
- **Decisions taken with the user on 2026-08-26**: sweeper is liveness-based with LiveKit
  confirmation, ~35–40 s detection (D6); judge is GPT-5.6 **Luna** only (OpenAI, `reasoning_effort` medium) through the
  existing OpenAI `LlmClient`, on in dev (D3); the WER gate threshold is set by the implementer after
  the N=5 baseline (D4). None of these need re-asking.
- Research inputs for this spec (not repeated here): Langfuse v5 `score.create` fields
  (`traceId`/`observationId`/`name`/`value`/`dataType`/`comment`, idempotent `id`), Metrics API v2
  cannot group by `sessionId` (filter only) — hence Postgres-first aggregation; Hamming judge
  rubric + calibration loop; Hamel Husain on binary labels; collections funnel definitions
  (contact / RPC / PTP / promise-kept); vendor latency bands are directional, not standards.
