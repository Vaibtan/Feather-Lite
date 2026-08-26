# ADR 0009 — Scores in Postgres, a binary judge, and where the honesty line sits

- Status: accepted (2026-08-27)
- Related: [ADR 0007](0007-prompt-shape-observability-and-the-flux-revert.md),
  [ADR 0008](0008-playout-truth-cross-call-memory-and-measured-rejections.md);
  spec `docs/plans/2026-08-26-quality-and-slo-layer-spec.md`

## Context

Before this work the platform could say how fast every turn was, what it cost, and whether the
ledger replayed to the outcome a scripted reference expected. It could not answer "was that a *good*
call?", "is the agent resolving accounts?", "which vendor is degrading?", "did the borrower's words
get transcribed correctly?" — and when a worker died mid-call the conversation stayed open forever,
blocking that borrower under the one-live-conversation-per-borrower rule.

Ten phases added that layer. Four decisions in it are the ones a future session would otherwise
re-argue.

## Decision 1 — scores live in Postgres first and Langfuse second

A score is a **judgement about** a call. An event is a record of something that **happened on** it.
That distinction is load-bearing here, not philosophical:

- Events carry a monotonic `sequence_no`, are append-only, and replay to the outcome. Re-running an
  evaluator or a judge must therefore never touch them, must never take the conversation row lock,
  and must never consume a sequence number — otherwise a re-judge would rewrite history and a slow
  scorer would contend with a live turn.
- A score is expected to change. `conversation_scores` is keyed by
  `(conversation_id, turn_id, name, source)` and upserts, which is also how Langfuse's idempotent
  score `id` behaves, so the two never disagree about how many opinions exist.

**Postgres is the source of truth and Langfuse is the copy.** The alternative — push scores to
Langfuse and read them back for the console — was rejected on a fact, not a preference: Langfuse's
Metrics API v2 can *filter* by session but cannot *group by* one, so "the funnel and the SLO across
the last 50 calls" is not a query that API can answer. Postgres holds both the events and the scores,
so it is the only place the two can be joined at all. Langfuse gets every score anyway, through the
one `Tracing` seam that already existed, so quality sits beside latency and cost where a reviewer
will look for it.

Two consequences worth recording. `conversation_scores` has **no foreign key** on
`conversation_id`: the scenario suite scores a synthetic per-run id (D9) because a suite run is a
test, not a call, and a FK would force a fake `conversations` row into existence to hold it. And the
unique index is `NULLS NOT DISTINCT` — `turn_id` is null for a call-level score, and under the
default rule two call-level writes of the same name would both insert instead of upserting, which is
exactly the duplicate the identity exists to prevent.

## Decision 2 — the judge is binary per dimension, and must quote its evidence

**Binary, not a 1–5 scale.** A scale invites the model to hedge at 3 and gives an operator nothing to
calibrate against: two people rarely agree on what a 4 means, and neither can say whether the judge's
4 matches theirs. A pass/fail compares directly with a human's pass/fail, which is what the Quality
page's agreement number measures — and agreement with human labels is the only thing that makes a
judge worth believing. (Hamel Husain's finding on binary expert labels; the dimension list is the
Hamming rubric's.)

**Evidence before verdict.** Every dimension must quote the transcript span it is judging. Partly for
the operator, who can check a verdict in seconds instead of relistening; mostly for the judge,
because a model asked to find the quote first is answering a question about the transcript, while a
model asked for a verdict first is answering a question about its own impression.

**The failure mode is named in the prompt.** Collections agents that sound warm, apologise well and
resolve nothing read as good calls to a model trained on helpfulness. The rubric says so explicitly,
and `task_completion` is judged against what the ledger records the call achieved — handed to the
judge along with the deterministic evaluator's facts, so it never guesses at something already known
for certain.

**Self-preference is acknowledged, not solved.** The decider is `gpt-4.1`/`4.1-mini` and the judge is
`gpt-5.6-luna`: same vendor, different family. That is weaker isolation than a cross-vendor judge.
It is mitigated by the evidence-before-verdict prompt, by feeding in the ledger's own facts, and by
measuring agreement against human labels — and a non-OpenAI judge remains a Layer swap away through
the same `LlmClient` seam, without touching the job.

**Operationally:** its own outbox job type, not more of `EVALUATION`, so a judge outage cannot retry
and eventually fail the compliance checks that already succeeded; a longer retry budget than the
deterministic jobs, because those fail when this code is broken while the judge fails when someone
else's API is having an hour; the model call happens **before** the job's transaction opens, because
a reasoning model at medium effort thinks for tens of seconds and holding a Postgres connection
across that would starve the live call path; and an unusable verdict becomes a
`judge.invalid_output` score rather than silence, because silence shows on the Quality page as a
call awaiting review, which is a much more reassuring claim than the truth.

## Decision 3 — UTMOS/NISQA were not built, and TTS "quality" is labelled a heuristic

The models that actually predict how speech sounds — UTMOS, NISQA — are Python-only, and a sidecar
for them was out of scope. The temptation in that position is to invent a "voice quality score" out
of the numbers lying around. **That would be worse than no score**, because a number on a dashboard
is read as a measurement whatever the tooltip says.

So the TTS module answers only two questions the runtime genuinely knows the answer to: did the
synthesis produce any audio at all (a hard failure, and the exact one ADR 0008 found in production),
and was this turn spoken at a rate far from the run's own median (an outlier flag — "a human should
listen to this one"). The band is ±40 % of the **window's median**, not a configured constant,
because the right characters-per-second depends on the voice and a pinned number goes stale the
first time the voice changes; median rather than mean, so one turn played at four times speed cannot
drag the baseline up until it looks normal; and nothing is flagged until three readings exist,
because with two the median sits exactly between them and "the outlier" is whichever you name first.

The word "heuristic" appears on the console card itself, in the fleet report's console line, and in
the README status table — not only in documentation nobody has open while looking at the number.

The same honesty line runs through the rest of the layer:

- **Word error rate is a harness metric.** A production call has no ground truth to compare a
  transcript against. WER exists for calls the voice harness placed, gates the fleet run
  (`--max-wer`, 0.20 from measurement), and the console says why it is absent everywhere else.
- **A rate with no denominator is null, never 0.** "No call reached a person" and "every call that
  reached a person failed" are different findings. Judge agreement is null until a human has
  actually labelled something: an agreement number over calls nobody looked at is not a calibration.
- **A component with no measurement cannot breach the SLO.** A window of simulated calls has no
  end-of-utterance delay; reporting that as a failure trains operators to ignore the page.
- **Promise-*kept* is named as missing, not approximated.** It needs payment data this system does
  not ingest; `record_payment` is written down as the missing input.
- **SLO targets are what this stack achieves plus headroom** (p95 2500 ms end to end), not the
  800 ms–1.5 s "natural conversation" band vendor literature quotes. The measured local p50 is
  1.5–2.1 s, and a target the system has never met is decoration.

## Decision 4 — orphan detection is worker-liveness-based, confirmed against the media plane

Silence on a call is normal — a 50-second read-back, a borrower thinking. A dead worker is not. So
the sweeper does not watch for event silence; the worker's existing 10-second heartbeat carries the
conversations it is serving, and a conversation with no final outcome that no worker has claimed for
three intervals becomes a *candidate*.

A candidate is not an orphan. Before finalizing, the sweeper asks LiveKit whether an agent
participant is still in the room. **That confirmation is what lets the window be short without false
positives**: room gone or agent absent means orphan; agent still present means the worker is merely
slow, and the sweep defers and counts it. Detection lands at ~35–40 s in the worst case rather than
the multi-minute window an unconfirmed rule would have needed.

When the media plane cannot answer at all, a much longer unconfirmed timeout applies instead, so a
LiveKit outage degrades into a slower sweep rather than a fleet-wide hangup. The finalization is a
normal `CALL_CONTROL` event with reason `ORPHANED` and outcome FAILED, so it replays and appears in
the timeline like any other close, and time-to-detect is recorded as a score so the chaos scenario
is measurable rather than anecdotal.

## What verifying this found

Two defects surfaced only when the layer was pointed at real calls, and both are worth recording
because both were **silent**.

1. **A superseded turn was being counted as a silent playout.** A turn the borrower interrupts
   before the agent has produced any reply reports the same ledger shape as a zero-audio failure:
   nothing heard, cut short. The fleet's silent-playout rate read 22% when one turn in eighteen had
   genuinely failed. The predicate now excludes superseded turns and lives in one place with two
   named SQL twins. The definition was older than the code that exposed it — what changed is that a
   *rate* gets read where a counter does not, which is the argument for rates in one line.
2. **Every per-turn score was being rejected by Langfuse.** A score naming an `observationId`
   without its `traceId` is a 400, and the SDK reports that on its own logger rather than through
   the promise the caller awaits. The scores that appeared were the ones whose span had aged out and
   taken the session fallback — so the bug hit exactly the case the code was written for and spared
   the degraded one. Postgres-first is what made this a cosmetic outage rather than data loss, which
   is Decision 1 earning its keep on the first real test.

Neither had a seam that could catch it without the live system. For the second, the target choice is
now a pure function with the request shape pinned by unit tests; for the first, the domain predicate
has fixtures. That is the most that can be locked down without a Langfuse in CI, and saying so is
part of the record.

## Consequences

- Quality, reliability and outcome questions are answered from one durable table, replayable and
  testable on the seams that already existed. No second observability system was added.
- The judge costs one model call per call and is off unless switched on; CI and tier-1 load runs
  never spend money.
- Anything that cannot be measured honestly is either absent or labelled. The README status table
  distinguishes measured from heuristic, and this ADR is the record of why several plausible
  numbers were left unbuilt.
