# ADR 0010 — Patch the worker, shed load at the worker, and measure before cutting

- Status: accepted (2026-08-28); Decision 8 added 2026-09-01 (Phase C1)
- Amends: [ADR 0005](0005-typescript-effect-not-go.md) (language), and settles the language question
  the user reopened on 2026-08-27
- Related: [ADR 0006](0006-self-hosted-livekit-for-local-dev.md),
  [ADR 0008](0008-playout-truth-cross-call-memory-and-measured-rejections.md),
  [ADR 0009](0009-scores-in-postgres-a-binary-judge-and-the-honesty-line.md);
  spec `docs/plans/2026-08-27-efficiency-and-observability-hardening-spec.md`,
  audit `docs/plans/2026-08-27-efficiency-audit-findings.md`,
  numbers `docs/loadtest/README.md` (2026-08-28, and 2026-09-01 for Decision 8's context),
  review `docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md` and the spec that closes it,
  `docs/plans/2026-09-01-handoff-review-cleanup-and-resume-spec.md`

## Context

The platform could see latency, cost, correctness and — since ADR 0009 — quality per call. It could
not see the process serving them. Underneath, the voice worker needed ~2.4 GB before the first call,
ran in a mode that could not shed load, and the control plane spent about 43 Postgres round trips per
turn.

An audit turned that into numbered findings; a spec turned those into phases. What follows is the
decisions inside them that a later session would otherwise re-argue — several of which the
measurements overturned.

## Decision 1 — the worker is patched, not forked and not upgraded

`@livekit/agents` 1.6.4's main worker process `require`s `@livekit/local-inference` — a 69 MB napi
addon carrying the compiled turn-detector model — purely to check that it is installed. That process
never runs inference: the runner is registered as a URL string and executed in a separate process.

**Measured on this box**: 1 051 MB of private commit in the main process, 177 MB after replacing the
`require` with a `require.resolve` in the same module. Under the esbuild bundle, where the audit
expected the effect to shrink: **855 MB against 115 MB**.

Three options were available and two were rejected:

- **Upgrade to 1.7+**: rejected for this work. 1.7 changes EOU and endpointing behaviour, and every
  latency number in `docs/loadtest/README.md` — including the 2 397 → 2 145 ms that justified the
  audio-native detector — was measured on 1.6.4. An upgrade is its own piece of work with its own
  fleet baseline.
- **Fork**: rejected. This is two lines in a `dist` file, and a fork is a permanent maintenance
  obligation taken on for a change that should go upstream.
- **A pnpm patch**: accepted. `patches/README.md` records what each patch fixes, the measurement
  behind it, and when to drop it — and the repo already patches the Deepgram plugin the same way
  (a TTS websocket with no connect timeout, which produced a silent read-back the ledger recorded
  as heard).

The safety property given up is named rather than glossed: `require.resolve` succeeding does not
prove the binding *loads*. It fails well — the inference process's own `EotRunner.initialize()`
already throws with a clearer message — so the check the main process was paying a gigabyte for is a
duplicate of one that runs anyway, in the process that actually needs the module.

## Decision 2 — load is shed at the worker, not only at the SFU

The framework's default load function is a five-second CPU average of the whole box. That is the
wrong quantity twice over: it counts every other process on the machine as this worker's load, and it
lags. A run on 2026-08-27 lost the fifth of five calls to exactly that — nothing broken, a CPU spike
in the window.

So the load function became `activeJobs / WORKER_MAX_JOBS`: the quantity actually being controlled,
exact the instant a job is accepted. **And that was not enough, which is the part worth recording.**

**Measured**: with `WORKER_MAX_JOBS=2` and three calls started together, **all three were served**.
`loadFunc` shapes what the *SFU* believes about this worker, and the SFU is told only every 2.5 s
(`UPDATE_LOAD_INTERVAL`), so a burst arriving inside one interval is routed against a status that
still says idle. No threshold, however low, catches it, and the framework's default `requestFunc`
accepts whatever it is offered.

The ceiling is therefore enforced in `requestFunc`, where the answer is given, against the union
of the running jobs and the admitted ones — `admitting` exists because `activeJobs` only counts a job
once `launchJob` has run, which is after the accept and the SFU's assignment round trip.

**Corrected on 2026-09-01 (review #1).** This paragraph described a behaviour the code did not have,
and the measurement below did not test the difference.

`JobRequest.accept()` calls the worker's `#onAccept` **without awaiting it**
(`agents/dist/job.js:468-471`), so `await req.accept()` returned before the SFU round trip had
started: `admitting` was decremented in the same microtask it was incremented in, and the ceiling
collapsed back to the stale `activeJobs` it was written to replace. The fix fires the accept without
awaiting it and waits for the job id to appear in `activeJobs` or for the assignment to time out.

And the original measurement **could not have caught that**, which is the more useful half of this
correction. Its three rooms were created over separate HTTP calls, so the first job had reached
`activeJobs` before the second request arrived — "one served, two refused" follows from the stale
count alone. A probe of a concurrency window has to be concurrent.

**Measured after, 2026-09-01** (`docs/loadtest/README.md`, Phase 0): four sessions created in one
`Promise.all` against `WORKER_MAX_JOBS=2` — two admitted, two refused, and both refused calls
finalized `FAILED` with reason `NEVER_SERVED` about 38 seconds later. The worker's own line at the
third refusal reads `in_flight 2, running 1, admitting 2, max_jobs 2`: `activeJobs` held one job
against a ceiling of two, so the code this replaces would have accepted both surplus calls. That is
the O4 distinction (a call that never had a worker, as against one that lost hers) firing on real
shed load rather than on a chaos script, and this time the probe can tell.

`loadThreshold` keeps its original meaning and is not a ceiling: it is the point at which this worker
asks the SFU to prefer somebody else, which matters when there is a somebody else.

## Decision 3 — the SLO window is segmented, and has a floor

`Quality.sloStatus` takes a segment, defaulting to `{channel: 'voice', decider: 'openai'}`, and each
component reports `insufficient_sample` below `SLO_MIN_SAMPLE` (20) rather than a verdict.

Both halves come from an observed failure. **Measured**: a tier-1 load run added 36 scripted turns to
the "last 50 calls" window and `slo.measured.ttft_ms` fell from 3 228 to 1 252 ms, dropping `ttft_ms`
off the breach list. Nothing got faster; the window filled with turns decided by a `switch`
statement. And at n=6 a p95 is simply the maximum, so a verdict computed from it teaches an operator
to ignore the page.

Channel alone does not separate the populations — a simulated call and a voice call can both run the
real decider — so `conversations.decider` records which conversationalist served the call, from the
config that will actually serve it, at the moment the call starts. Rows written before that migration
are `null` and are **not** back-filled: those calls were served by something, this database does not
know what, and inventing a value would put guesses inside the window the segmentation exists to keep
honest.

## Decision 4 — the trace stays per turn

Each turn is its own root Langfuse trace; `session_id = conversation_id` is what joins them, and the
voice worker emits no spans of its own (its numbers arrive on the `turn_metrics` signal and are
folded into the control plane's turn span).

A per-call trace was considered and rejected. It would need the worker inside the trace context —
W3C propagation from a process that has no OTel exporter at all — and a root span held open for the
length of a call, which is minutes. What that buys is a tree view. What it costs is a span whose
export is deferred until the call ends, a second exporter in the process that carries the audio, and
a dependency between the media path and the observability vendor. Postgres is the aggregation store
per ADR 0009; the questions a per-call trace would answer are already SQL.

## Decision 5 — the memory monitor is configured, not deleted

`supervised_proc` polls `pidusage` for every child every 5 seconds **whether or not** a limit is
configured, and both limits were 0. So the cost was being paid and nothing was being enforced.

**Measured**: 336 ms per poll on Windows (714 ms cold), because `pidusage` spawns `wmic` there. With
five job processes and the inference process that is about 2 s of process spawning every 5 s — 40 %
of a core, for nothing.

The instinct is to remove the poll. The decision is to give it real numbers — warn at 400 MB, kill at
800, against job processes that measure 185-290 MB idle and peak near 340 — because a job that grows
past 800 MB is a bug an operator should be told about. And because the cost is a dev-box artefact,
not a production one: `pidusage` reads `/proc` on Linux, which is where the images deploy.

## Decision 6 — measure before cutting, twice with the answer being "don't"

Two items the spec listed were **not built**, both on evidence taken during the work.

**`listEventsUnchecked`.** The audit's reasoning was sound: the orchestrator re-reads and re-decodes
a 20-member tagged union about 38 times per turn. A CPU profile of a C=100 run says the whole of
Effect's `ParseResult` — rows and events together — is **about 2.4 % of busy time**, and there is no
hot spot at all (the largest real frame is `writev` at 10.5 %). Trading the boundary that keeps a
malformed ledger row out of `replay` for one or two percent of a small slice is a bad trade.

**`conversations.next_sequence_no`.** D5b offered it against the single-statement append and said to
choose on the numbers. `pg_stat_statements` put the `MAX` aggregate at **0.045 ms a call** — it is an
index-only scan of the existing unique index — so 2 200 of them were 99 ms in a run that spent 1 450.
The cost was the round trip, not the aggregate, and folding the two statements into one removes it
without adding a second write to the hottest row in the schema on every event.

Getting to those answers needed a profile, and `node --cpu-prof` cannot be used on this platform: it
writes on a clean exit, and Windows offers no way to ask a detached console process for one
(`taskkill` without `/F` refuses; `/F` and `process.kill(pid,'SIGINT')` both terminate). The server
profiles itself instead, behind `PROFILE_SECONDS`.

## Decision 7 — the language stays TypeScript, and ADR 0005 is amended rather than reversed

The user reopened ADR 0005 on 2026-08-27: a rewrite in Go or Python would be acceptable **if it
bought suitable gains**. It was settled by measurement, not preference.

- **Go: closed, for every component.** There is no LiveKit Agents SDK for Go; a Go worker means the
  dispatch protocol, Pion, an ONNX/cgo binding to the EOU and VAD models, and every provider client
  from scratch. The control plane's ceiling was ~43 sequential Postgres round trips per turn — a
  batching problem, now down to 31.7 in place, and a Go port that kept the query pattern would have
  kept the ceiling.
- **Control plane in Python: no.** 7.5k LOC sharing `domain` and `contracts` with the console, and
  no measured bottleneck the language owns.
- **Voice worker: TypeScript, because the measured gap was topology and a patch.** A Python
  `livekit-agents` 1.7.1 worker measured on the same box idles at ≈ 0.97 GB against Node's ≈ 2.2 GB,
  but for two reasons that do not transfer: Python's recommended path runs the EOU model *inside each
  job* (+243 MB per job) instead of in a shared process, and Node's main process was paying the
  gigabyte Decision 1 removes. At the acceptance bar Node-after-the-patch is the lighter of the two.

What the exercise did buy is recorded as work, not as a rejected option: 1.6.4 already exports
`inference.VAD`, backed by the same addon, measured in Python at **0.69 ms of CPU per second of audio
against Silero-ONNX's 4.4-6.3** — and it would take `onnxruntime-node` out of the tree, which is
**513 MB of prebuilt binaries, 336 MB of it a CUDA execution provider this deployment cannot use**.
That is the next piece of worker work and it is gated on barge-in timing, not on language.

A Python **thread-executor** worker stays in reserve as the one configuration with a genuinely
different memory shape (sessions as threads, ≈ 0.5 GB for the whole worker; no crash isolation, no
per-job memory limit, GIL exposure). It is triggered only by an N=10 acceptance failing on a *memory*
ceiling, which has not happened, and the worker is 698 lines behind an HTTP/SSE contract that the
equivalence harness validates for any implementation.

## Decision 8 — the 2026-08-30 review's ledger, closed: built or recorded, never neither

The review in `docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md` found twenty-five
defects and, separately, thirteen spec items that were **neither built nor recorded** — which is the
state this ADR's Decision 6 exists to make impossible. Phase 0 fixed eleven of the defects and built
O9; Phase C1 (2026-09-01) fixed five more and built the CI image job. Everything below is the
remainder, and it is recorded here rather than left implicit. The user's decision on 2026-09-01 was
explicit: of the ten deferred §3 items, **build the CI image job and record the rest**.

Recorded is not the same as rejected. Decision 6's rule holds — a thing is measured before it is
cut — and each line below says what would have to be true for it to be worth doing.

### §3 items, not built

| Item | Why not now |
|---|---|
| **Incremental replay** (D5, review #8) | The largest remaining D5 item and the only one with a real cost: T2 re-reads the whole ledger and `executeTool` replays a third time, so per-turn database work is O(events) twice, and "no growth with call length" is still false. Not built because the calls it would help are longer than any call this system has taken — a collections call is three to six turns — and the fold-equals-replay property test it needs is a larger piece of work than the saving. **Trigger: a call length where `total_ms` grows with turn index.** |
| **Memoise `toolSpecsFor`** (D5, C4) | `prompts.ts` builds a JSON schema per tool per turn. It has never appeared in a CPU profile: the profile that settled `listEventsUnchecked` put *all* Effect schema work at ~2.4 % of busy time with no hot spot. Trigger: a profile where it does appear. |
| **`--max-semi-space-size` A/B** (D5) | GC is 6.2 % of the profile, which is the least suspicious number in it. Trigger: a soak whose RSS slope survives the retention fix (review #16, Phase C1). |
| **Prepared-statement experiment** (D5, C8) | The spec said "record the answer either way", so this line is that record: it was not run. The statement count per turn came down 43.6 → 31.7 by removing round trips, which is the same axis a prepared statement moves and the cheaper end of it. Trigger: a `pg_stat_statements` ranking where parse time is visible. |
| **SSE encode / delta coalescing** (D5, C6) | `handlers.ts` still `Schema.encodeSync`s every frame. At three to six turns a call and one client per call the volume is nothing; the number that would justify it is a fleet where the server's CPU is the ceiling, and at N=5 it is not. Trigger: the N=10 run implicating the server rather than the worker. |
| **HOT ratio and `n_dead_tup` in the load report** (D5b) | Migration 0005's core claim (`n_tup_hot_upd / n_tup_upd > 0.9`) is still unverified. Phase 0 added the report line the review asked for; the *reading* it produces has not been taken on a run large enough to mean anything. Trigger: the N=10 acceptance run, where it should be read and written down. |
| **bytes/turn and bytes/call in the loadtest README** (D5b) | Same shape: the numbers are obtainable and nobody has needed them. Trigger: a storage question, or a Langfuse retention decision that needs a volume. |
| **`pg_stat_user_indexes.idx_scan` check** (D5b) | Never run. Two indexes were added on evidence (migration 0006) and none has been checked for disuse since. Trigger: any further index, or a table whose write cost is being investigated. |
| **Langfuse retention / ClickHouse TTL, and the Redis `maxmemory`** (D6, review #20) | No retention settings, no TTL, and Redis runs `noeviction` with no `--maxmemory` under a 64 MB cgroup — so it grows past the limit, is OOM-killed, and `restart: always` loops. Not built because the Langfuse stack is a **local development instance** that is stopped before every measurement (`pnpm lf:down`), so the failure costs a restart and no data anyone relies on. **This is the one recorded item that becomes urgent the moment Langfuse is not local**, and it should be the first thing done if it is ever run continuously. |
| **`/readyz` Langfuse-flush check, worker heartbeat RSS of the inference and job processes** (D3) | The heartbeat half is already justified in a comment: the framework does not expose the pids of the inference or job processes, so the tree-wide figures are the resource sampler's job and guessing at them in the worker would be worse than not having them. The `/readyz` half would make readiness depend on an optional exporter, which is the wrong direction for a liveness signal. |
| **The W1 upstream issue** (`patches/README.md`) | Still not filed. All three `@livekit/agents` patches are worth one issue between them, with the memory table attached. Not a blocker for anything here; it is a debt to the ecosystem rather than to this repo. |

### Review defects, not fixed

| # | Why not now |
|---|---|
| **#14** — the outbox's "jobs belong to different conversations" comment is false; `enqueuePostCall` inserts a conversation's whole set with one `available_at`, so siblings run concurrently against a ledger snapshot taken before the transaction | Benign **today** only because no reducer reads `OUTBOX_PROCESSED`. That is an invariant nothing states or tests, which is exactly the kind of thing this ADR is for. Recorded rather than fixed because the fix (claim per conversation) changes the work-conserving claim that took the drain from 283 jobs in 74 s to 103 in 4 s. **Trigger: the first post-call job that writes an event another post-call job reads.** **Re-checked 2026-09-02 (issue #4, C3), as that spec required.** The claim lease widens *which* rows are claimable — a `CLAIMED` row whose claim has expired joins the `PENDING` ones — and changes nothing about the shape of the claim: it is still work-conserving across conversations, still `SKIP LOCKED`, still up to twenty rows from whatever is due. Siblings still run concurrently against a pre-transaction snapshot, so #14 stands exactly as written, with the same trigger. |
| **#26** — a claim is a lease, and a reclaim spends retry budget (issue #4, C3, 2026-09-02) | Recorded because it is a semantic two other things now depend on. `CLAIM_LEASE_MS` is five minutes, chosen between the longest a live claim legitimately lasts (a JUDGE job waiting on a reasoning model) and how long a borrower may sit behind a stranded call; anything from about two to fifteen minutes behaves identically, which is why it is a constant rather than a knob. A reclaim bumps `retry_count`, so a job that is reclaimed *and* then fails is charged twice — deliberately, because a dead process and a raised error are different bad attempts — and a job that spends its whole budget on reclaims alone is failed with `RECLAIM_BUDGET_EXHAUSTED` before it is run again, which is what stops the lease turning a process-killing job into a five-minute crash loop. |
| **C8 (issue #4)** — `AGENT_TURN_PLAYOUT` can be written twice for one playout, and the three readers resolve a disagreement differently: the fully-heard guard takes any `interrupted` report as decisive, `silentPlayoutTurnIds` takes any interrupted-and-empty one, and `tts_silent` repeats the second rule in SQL | **Recorded rather than built, on a measurement.** The two write paths are T1's `playout` field and the `playout` signal, and the worker will not use both for one turn: `feather-agent.ts` guards each on `lastReportedTurnId`, which `llmNode` and `reportPlayout` share. Counted over the local ledger on 2026-09-02: **0** turns with more than one playout row, and **0** with rows that disagree, across 392 playouts and 65 736 outbox jobs. So unifying the three readers today would change no answer, while touching a compliance-adjacent counter and the guard that decides whether a promise may be recorded. **Trigger: the first turn observed with two playout rows** — the query is in this row's commit — or a second writer of that event type, whichever comes first. |
| **#21** — `initializeProcessTimeout` is still 60 s; W3 said reduce it toward 10 s once cold start shrank | This is the record W3 asked for. Cold start is 1 834 ms bundled, so 60 s is twenty times the headroom needed — but the timeout only costs anything when a job process is already failing, and a shorter one turns a slow prewarm on a loaded box into a killed slot. Trigger: a run where a job process hangs in `initialize` and 60 s of a borrower's call is spent waiting. |
| **#22** — the sweeper books a worker that claims and crashes inside its first 10 s heartbeat window as `NEVER_SERVED` | It uses the heartbeat, not the claim, as the "was served" signal, so a genuine orphan is excluded from `orphan_detect_ms`. The window is ten seconds wide and the effect is to *under*-report a latency, not to lose a call. Trigger: an orphan-detection number that has to be exact. |
| **#23** — the 20 ms event-loop sampling floor is subtracted from `max` as well as from the quantiles, under a raw-lateness series name | A scraper comparing with `nodejs_eventloop_lag_max_seconds` sees a systematically low maximum. Nothing scrapes it that way yet; the fix is either "subtract from quantiles only" or "rename the series as adjusted", and the choice belongs with whoever builds the dashboard. |
| **#24** — the resource sampler takes `idle` from `series[0]` before the pool is warm, keys CPU by pid without start time, and reports `mb_per_call` in MB against a heartbeat in MiB | Three small biases in the same direction — they flatter `mb_per_call` and `calls_per_vcpu`. The pid-recycling half is a **win32 problem**, and the measured stack is containers now, which is where the sampler reads `cpu.stat` per container instead. Trigger: a per-core budget quoted to more precision than it deserves; the unit mismatch should be fixed the next time that file is opened. |
| **#25** — stale comments and docs | **Partly done.** Phase C1 corrected the ones next to the code it changed (`stack:quiet`'s README line) and Phase C2 corrects `shed-probe.ts`, `scripts/bundle.mjs`, PROGRESS row 12 and the README's measured-run section. What remains is the smaller set the review lists — `handlers.ts:145`, `main.ts:88`, `Outbox.ts:320-326` (which is #14's comment, and goes with it), `pnpm-workspace.yaml:17` — each to be corrected in the commit that next touches that code, which is the review's own rule. |

## Consequences

- The per-core budget is a number: **~0.015 CPU-seconds per turn** for the control plane, **~10-12
  CPU-seconds per call-minute** and **~300 MB per call** for the worker, **3.3-3.9 calls per vCPU** at
  N=5 on a 12-vCPU laptop. It comes from N=5 and says so; N=10 has not been run.
- Both services ship as `node:22-bookworm-slim` images, non-root and health-checked, 505 MB and
  780 MB. arm64 is promised only because all three native packages publish `linux-arm64-gnu` builds —
  which is also why Alpine is out, since those builds say `gnu` in their names.
- Every measurement in this ADR is reproducible from `docs/loadtest/README.md` and the JSON beside
  it. Where a number could not be taken, the gap is written down rather than estimated.
