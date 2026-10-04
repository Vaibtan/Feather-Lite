# Spec: attribution by contract, the instruments the retrospective asked for, and the best self-hosted turn-taking

> Scope update, 2026-10-04: [working local product and pilot readiness](2026-10-04-local-product-and-pilot-readiness-spec.md) is now the umbrella specification. Its roadmap disposition identifies completed mechanisms to preserve, remaining local-delivery requirements and deferred experiments. Current `AGENTS.md` and that specification govern execution; historical automatic-commit and repeated-approval instructions below are not the workflow for the new assignment. Retain this document as design history and detailed supporting evidence.

2026-09-05. For the implementing session. Synthesised from the architecture retrospective
`docs/reviews/2026-09-05-architecture-retrospective-and-duplexcascade.md` (read it first; it holds
the analysis, the paper reading, the code survey and the eleven decisions the user took on
2026-09-05) and the two handoffs in the user's temp directory
(`feather-lite-handoff-2026-09-05-wait-ladder-done.md`, `…-2026-09-04-cleanup-followups.md`) for
the environment and the verification bar. It supersedes handoff items 1b, 2c and 2e (folded into
Phase 0 here) and picks up the retrospective's §5 order. Issue #1's D2, D4 second half and D6 are
referenced, not re-specified; issue #4 is closed by its own comment.

Ground rules are those of `docs/plans/2026-08-30-turn-taking-and-conversation-quality-spec.md`
("Ground rules", 1–8) and stand unchanged: nothing is done until it has been run; one behavioural
change per commit with before/after; verify every SDK API against the installed dist; the four
gates plus the amount-entity gate; segments never mix; **ask (`grilling`) before any change that
alters live-call behaviour**; `code-review` on every diff, `commit-work` for every commit.

## Problem Statement

The last three N=5 gates failed 4/5, 4/5 and 3/5, and every failure has the same root: the worker
decides which turn a spoken item belongs to by inference — a stamp set through an SDK internal for
`say` items, a fallback to a mutable `currentTurnId` for the model reply, and a second inline path
that writes the same state from a different source. A read-back gets booked to the following turn,
the fully-heard guard correctly refuses the promise, and the borrower hears the read-back twice.
Around that defect, decisions the ledger records are invisible on the wire, instruments the pipeline
already produces are thrown away (the end-of-turn probability at every pause), metrics that exist
as pure functions reach no page, the D5.2 result ("700 ms cut as often as 500 ms") is unexplained,
and the vocabulary has drifted (a `resume` disposition nothing assigns; `model` in one layer and
`openai` in another; scenario markers pointing at work that already ran). The retrospective also
settled what "best turn-taking" means on a self-hosted media plane, and the pieces of that — an
SDK upgrade carrying fixes on these exact races, a server bump, a shadow detector, one Cloud
measurement — are not scheduled anywhere.

## Solution

Make attribution a fact of the contract: the control plane names every spoken segment, the worker
reports playout per segment, and the control plane folds segments into turns (Phase 0). Put the
decisions on the wire and the discarded signals on the turn, and give the stranded metrics a page
(Phase 1). Add the scenarios the failures keep hitting and the paper's event mix as a seeded
tripwire (Phase 2). Build the fast path exactly as issue #1 D2 specifies (Phase 3). Type the
post-response silence by what the agent just said (Phase 4, after a `grilling` round on the
table). Then the platform steps, each its own measured baseline: server v1.13.6, SDK 1.8.0,
Smart Turn v3 in shadow, one LiveKit Cloud A/B (Phase 5). Close with ADR 0011 (Phase 6).

## Implementation Decisions

### Phase 0 — Attribution by segment id (folds handoff 1b, 2c, 2e)

- **Every `say` frame carries a `segment_id`** minted by the control plane when the segment is
  appended (the read-back, the confirmation, the fallback line). The `delta`-built model reply is
  one implicit segment whose id is the turn id. The frame keeps `allow_interruptions`.
- **`AGENT_TURN_PLAYOUT` is keyed by segment**: payload `{turn_id, segment_id, heard_text,
  interrupted}`. One event per segment, appended when the worker reports that segment's item. The
  worker no longer concatenates parts or reports "once per turn"; it reports each item it is told
  about, using the item's segment id, and falls back to the turn id for the model reply. The
  `_addItemAddedCallback` stamp is still how the worker learns an item's id-to-segment binding at
  creation; the difference is that what it binds is a control-plane name, not a locally inferred
  turn, so a late-delivered item cannot land on the wrong turn.
- **The inline `playout` built from `chatCtx`'s last assistant item is deleted.** There is one
  reporting path. The "must run before `currentTurnId` moves" ordering comment becomes a test that
  fails if a late item is delivered after the next turn started (the race the current test only
  documents as an assumption).
- **The fully-heard guard reads the read-back's own segment**: `pendingProposal` stores the
  read-back's `segment_id` (in addition to the turn id it stores today); `readBackVerdict` looks
  for that segment's playout, not the turn's concatenated parts. Voice stays fail-closed on absence.
- **`held`'s query is by segment**: "an `AGENT_TURN` segment with `speak_mode: non_interruptible`
  and no `AGENT_TURN_PLAYOUT` for its `segment_id`". The opening keeps its exclusion.
- `TurnRunner.run` passes `held: boolean` rather than encoding it as `heldMs` presence (2e);
  `heldMs` stays as the measurement. `pausedForMs: -1` becomes `number | null` (2c).
- The worker's five turn-keyed maps collapse into one `Map<segmentId, SegmentRecord>` with a
  single close path (2c), now that the key is a contract value.
- **Ledger compatibility**: existing `AGENT_TURN_PLAYOUT` rows have no `segment_id`; the guard and
  the turn-taking metrics treat a missing `segment_id` as "the turn's single segment" so replay of
  old conversations is unchanged. No migration rewrites history.

**Gate:** `pnpm check`, `pnpm test:db`; the DB tests for the guard (heard / interrupted /
unreported / simulated) re-pinned on segment ids; a worker unit test that delivers an item after
the next turn began and asserts it lands on its own segment; `sim-borrower --scenario
yes-during-read-back` shows one read-back and `heldMs > 0`; **N=5 twice, both 5/5** — this is
also Phase 2's owed second clean run from issue #1.

### Phase 1 — Instruments, no behaviour change (one commit each)

1. **`eot_prediction` recorded.** Subscribe to the session's `eot_prediction` event; attach the
   last prediction before the commit to `turn_metrics` as `eou_probability`, `eou_threshold`,
   `eou_inference_ms`; persist on `conversation_turns.result`. The `unlikelyThreshold` sweep
   (issue #1 D5.3) becomes an offline replay over these values.
2. **The wire carries the decisions.** `turn_end` gains `disposition`, `decider` and, per `say`,
   the `segment_id` and `speak_mode`. The simulator stops re-fetching disposition from `/latency`.
3. **D5.2 diagnostic.** At every interruption the worker logs and reports (on `turn_metrics`) the
   VAD speech duration that triggered it and the transcript that followed. One tier-3
   `backchannel-mid-line` run answers why 700 ms cut as often as 500 ms.
4. **Escape-hatch counters** (retrospective §4.5): per call, the number of `wait` misses and
   `resume` misses the simulator's expected-ledger check finds, and the number of model turns in
   `CONFIRMING_OUTCOME` whose final text a `{yes, no, amount, date}` rule would have answered.
   Scores, not gates. They decide whether a model-backed classifier is ever built; nothing is
   built here.
5. **Stranded metrics reach the Quality page**: a turn-taking card (the six numbers + `T90`,
   labelled "harness metric", segment named) and `stt.entity_er` beside `stt.wer`.
6. **Vocabulary hygiene**: `disposition: "resume"` either assigned (from `resumed_ms.length > 0`
   when the ledger merges `turn_metrics`) or removed — assign it; `TurnDecisionSource` and the
   `conversations.decider` column use one vocabulary, with a test that pins parity; the tier-3
   scenario table's `until`/`notYetAsserted` texts say what is true; `Queries.ts`'s fast-path
   comment waits for Phase 3 or is reworded.

**Gate:** every voice turn carries the new fields; N=5 latency unchanged (they are listeners);
the Quality page renders the card with the segment name; `backchannel-mid-line` has the D5.2
answer written into `docs/loadtest/README.md`.

### Phase 2 — Scenarios: the shapes the gates keep hitting

- **`mid-utterance-pause`** (Full-Duplex-Bench's *pause handling*): a borrower line with a seeded
  intra-line pause of 600–1200 ms; expected ledger shape is one `USER_TURN_FINAL`, no
  `USER_DECLINED`, one proposal. This is the split-final defect as a tripwire; it will be red
  until endpointing is tuned on Phase 1's recorded probabilities, and is marked `expectedToFail`
  with that `until`.
- **`post-question-pause`**: the borrower stays silent for a seeded 4–8 s after an open question
  and then answers; expected: no `NO_INPUT` nudge inside the window Phase 4 will define — red
  until Phase 4, marked so.
- **`realistic-mix`** (the paper's event priors, seeded): intra-line pauses with p ≈ 0.10, one
  interruption at a random agent-line boundary with p ≈ 0.30 per line, a backchannel with
  p ≈ 0.01 per agent clause, a thinking pause after each agent reply. Expected shape: the
  happy-path outcome; reported numbers are the six metrics.
- **Agent-backchannel measurement hook** (decision Q3): the harness counts agent audio onsets
  inside a borrower line as `turn.agent_backchannel_count`; the judge prompt for simulator calls
  marks them in the transcript. No agent backchannel is emitted by this spec; the count is 0
  until someone builds one behind this instrument.

**Gate:** all three run green or excused on the clean persona before any endpointing or silence
constant changes; each has a seed and an expected-ledger check.

### Phase 3 — The deterministic fast path

Exactly issue #1 D2 (`classifyIntent`, confidence ∈ {0,1}, through the existing tool path and
guard, `decider: "fast_path"`, both populations on the SLO page). Nothing new to decide; the
retrospective's only addition is the reason it moves up: `ttft_ms` is the breaching stage and
this is its only deterministic lever. **Gate:** issue #1's (20/20 + new scenarios, fast-path p50
< 700 ms, model p50 unchanged, zero fast-path `TOOL_REJECTED`).

### Phase 4 — Silence typed by the last agent act (live-call behaviour: `grilling` first)

- `extend_away_ms` becomes a pure function of (state, last agent act, hold kind) in
  `waitPolicy.ts`, where "last agent act" is one of: open question, yes/no read-back,
  disclosure (Mini-Miranda), closing line, hold acknowledgement. Constants stay domain values,
  not `POLICY`, not `AppConfig`. No new prompt copy; the `noInputPrompt` ladder is unchanged.
- The table's shape and numbers are put to the user in a `grilling` round before any constant is
  written; the round's decisions go into the commit message.

**Gate:** `post-question-pause` turns green; `hold-request` unchanged; N=5 unchanged.

### Phase 5 — Platform, each its own baseline

1. **`livekit/livekit-server` v1.13.6** in `docker-compose.yml`, taken with the next rebuild and
   re-baselined in the same N=5 run.
2. **`@livekit/agents` 1.6.4 → 1.8.0**, only after Phase 0 (the item-stamp seam is then a
   binding of contract names and easier to re-verify). Re-verify `_activity.
   startFalseInterruptionTimer` for `resume` and the patch in `patches/`; note that #2382 changes
   how `transcription_delay_ms` is anchored, so the waterfall table is re-baselined and the README
   says why the stage moved. **Gate:** N=5 twice, the tier-3 set re-run, `pnpm check`/`test:db`.
3. **Smart Turn v3 in shadow mode**: a sidecar container (Pipecat `smart-turn-v3`, int8, CPU)
   fed the borrower audio; its complete/incomplete verdict at each pause is logged beside
   `eou_probability` on `turn_metrics`. It changes no decision. **Gate:** the log exists on N=5;
   a written comparison against the recorded EOU probability on the `mid-utterance-pause` runs.
   Promotion to an input is a later spec.
4. **One LiveKit Cloud A/B** (decision Q2 as amended): the Cloud profile via `.env`, direct
   plugins, `WORKER_INTERRUPTION_MODE=adaptive`, verified live (no fallback line); N=5 on
   `backchannel-mid-line` and `yes-during-read-back`; both arms on the same scenarios. The
   numbers (false-interrupt rate, yield latency, resume gap, any added latency) go into ADR 0011
   as what Cloud buys and what self-hosting costs. Cloud does not become the default.

### Phase 6 — ADR 0011 and the docs

`domain-modeling` for ADR 0011: the six-way turn vocabulary (respond / wait / held / resume /
thinking / agent-backchannel) and which two this system deliberately does not act on yet;
attribution by segment id and why inference was retired; the fast-path contract; self-hosted
primary with the Cloud number; the GPU tier (Easy Turn / SoulX-Duplug) as a documented option
with its entry cost; the escape-hatch trigger and its two named options. README status rows and
`docs/loadtest/README.md` sections for every gate above; PROGRESS.md row 14.

## Testing Decisions

- A good test asserts external behaviour on an existing seam: the ledger and `conversation_scores`
  after a turn, the `turn_end` frame, the `sim-borrower` report JSON, the Quality JSON — never the
  SQL text or the worker's private maps.
- **Seams** (existing, preferred): `POST /turn` SSE frames (`turnFrames.ts` schemas); the
  `signal` endpoint's `playout` kind; the ledger event schemas (`events.ts`); `conversation_turns.
  result`; the tier-3 scenario table with `expectedToFail` tripwires; `Quality.sloStatus`. One new
  seam: the sidecar's log line joined to `turn_metrics` by turn id.
- **Worker (`apps/voice-worker/test`)**: item delivered after the next turn started lands on its
  own segment; the model reply lands on the turn segment; `eot_prediction` is attached to the
  next `turn_metrics`; D5.2 fields present on an interruption.
- **Control plane (DB)**: guard by segment (four cases re-pinned); `held` by segment; `resume`
  disposition assigned from `resumed_ms`; decider vocabulary parity; old playout rows without
  `segment_id` still satisfy the guard.
- **Domain (`tdd`)**: `waitWindowFor(state, lastAct, holdKind)` table; escape-hatch rule
  classifier table; `realistic-mix` generator determinism (same seed, same table).
- **Harness**: report schema requires the new counters and `agent_backchannel_count`; each new
  scenario has a seed and an expected-ledger check.
- Prior art: `readBackGuard.test.ts`, `held.test.ts`, `wait.test.ts`, `playoutAttribution.test.ts`,
  `silenceClock.test.ts`, `scenariosTier3.test.ts`.

## Out of Scope

- The DuplexCascade micro-turn LLM loop; fine-tuning the decider; VAD-free operation
  (retrospective §2.4, §4.7).
- Building the GPU tier (Easy Turn / SoulX-Duplug) or promoting Smart Turn v3 to a decision input.
- LiveKit Cloud as the default profile; SIP/PSTN.
- Emitting agent backchannels (measured only, Phase 2).
- Issue #1's D4 second half (third-party pickup, accent ablation) and D6 (judge abstention,
  corrected prevalence) — unchanged in issue #1.
- Everything ADRs 0007–0010 rejected, and research §5.

## Further Notes

- Phase 0 is the whole reason the gates fail; nothing else here is worth a fleet run before it
  lands. Phases 1–2 are safe to interleave with it (they are listeners and scenarios).
- Sub-agents must be told never to run `git checkout` / `reset` / `stash`, and that others edit
  other paths in parallel (handoff, twice).
- The published LiveKit docs describe `main`; the pinned 1.6.4 dist under `node_modules/.pnpm/`
  is the authority until Phase 5.2, and 1.8.0's dist after it.
- Containers were **down** at the time of the 09-05 handoff; bring the stack up with the compose
  command in the 09-04 handoff, and `pnpm stack:quiet` before any fleet number.
