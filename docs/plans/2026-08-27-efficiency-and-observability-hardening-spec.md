# Spec: efficiency & observability hardening — cheaper calls, honest metrics, a shippable image

2026-08-27. For the implementing session. The quality & SLO layer (`2026-08-26-quality-and-slo-layer-spec.md`,
ADR 0009) is complete and works end to end. This spec does three things to it and to the pipeline
under it: **fix what the audit found wrong in the metrics**, **cut the CPU and memory the voice
pipeline burns per call and at rest**, and **make the two Node services shippable as containers** —
so that the end-to-end voice pipeline runs on this class of hardware at a reasonably high, *measured*
throughput without giving up the correctness and quality gates that already exist.

Read before touching code, in this order, and do not re-derive them:

1. **`docs/plans/2026-08-27-efficiency-audit-findings.md`** — the evidence this spec is built on, with
   file:line references. Defects are numbered O1–O16 (observability), W1–W10 (worker), C1–C8
   (control plane); this spec refers to them by those ids.
2. `docs/adr/0008-*.md`, `docs/adr/0009-*.md`, `docs/loadtest/README.md` — what is settled and what
   the harnesses gate on.
3. The handoff `feather-lite-handoff-2026-08-27-quality-layer-done.md` (outside the repo, in the
   user's temp directory) — repo state and the environment gotchas.

## Ground rules (inherited from the 08-22 and 08-26 specs; restated because they still bite)

1. **Nothing is done until it has been run.** Every phase ends with the verification listed for it.
   This spec is about numbers: **every optimisation commit carries a before/after measurement taken
   with the same harness on the same box**, or it does not land. "Should be faster" is not a
   measurement.
2. **One behavioural change per commit**, reasoning + before/after in the message. Run the
   `code-review` skill on the diff before each commit, and **always commit through the
   `commit-work` skill** — never a bare `git commit`. `diagnosing-bugs` for anything on the voice
   path, `tdd` for the pure modules, `domain-modeling` for ADR 0010, `wayfinder` if a phase outgrows
   the session.
3. **Verify every library API against current docs** (`find-docs` / `ctx7`) before use. Pinned:
   `@livekit/agents@1.6.4` (do not upgrade in this work — the EOU/endpointing behaviour was measured
   on it), `@livekit/local-inference@0.2.6`, `@effect/sql-pg@0.53`, Langfuse JS v5.
4. **Known-failing test:** `pnpm test:db` is 59/60 (`workers.test.ts:145`, pinned date).
   Pre-existing, not approved for fixing; ask before touching. Everything else stays green:
   `pnpm check` (173 domain + 33 control-plane), 20/20 scenarios.
5. **Quiet-box discipline for every voice measurement.** Before a fleet run: close the browser,
   `pnpm lf:down`, check `Get-NetTCPConnection -RemotePort 7880 -State Established` for zombie
   workers (filter by process start time — the harness client also connects to 7880), and, new
   this session, **`wsl --shutdown` if `vmmemWSL` is over ~3 GB with the stack stopped** (W9).
   `.env` is read once at boot; `TURN_DECIDER=openai` must be in the **server process env**;
   `Tee-Object` locks old log files — new filename per restart; the fleet report filename is
   date-stamped only, so copy the committed baseline aside before a re-run.
6. **Cost discipline.** `JUDGE_ENABLED=false` in the environment of every load run (O13 — this is
   made automatic in Phase 1). Never print `.env`.
7. **Do not re-propose** anything ADR 0008/0009 rejected: preemptive generation, `queueSizeMs`,
   in-call `call_facts`, external memory, a MOS model, production WER, an approximated promise-kept
   rate, Langfuse-first scores. And do not "optimise" `llmNode` (W10 in the findings: nothing there
   is hot; OpenAI's tail owns the turn's worst case).
8. **Accuracy is a gate, not a report.** No commit in this spec may regress: voice/sim equivalence,
   WER ≤ 0.20, the SLO verdict on the voice-only window (Phase 1 makes that window exist), or the
   deterministic evaluator's compliance scores. A change that is faster and fails any of those is
   reverted, and the revert is recorded.

## Decisions taken with the user on 2026-08-27 (none of these need re-asking)

| # | Decision |
|---|---|
| Q1 | **Both**: first-class production images for `apps/server` and `apps/voice-worker` **and** the local third-party stack slimmed and resource-limited. |
| Q2 | Size for a **per-core budget** (calls per vCPU, MB per call), validated on this laptop, with **multi-arch images (`linux/amd64` + `linux/arm64`)** so the Oracle A1 path in the deploy doc works unchanged. |
| Q3 | **Acceptance bar: N=10 concurrent real calls green on this laptop with the observability stack up** (Postgres + LiveKit + Langfuse). Report the per-vCPU figure alongside. |
| Q4 | Gates while optimising: equivalence, WER ≤ 0.20, latency SLO verdict, evaluator compliance scores — all four. |
| Q5 | **Out**: Python rewrite of the worker, STT/TTS vendor swap, anything ADR 0008/0009 rejected. **In**: built bundle instead of `tsx` at runtime, LiveKit worker options / thread settings / audio buffering, control-plane hot path, process-level metrics. |
| Q6 | A **measured two-process control plane** is the final phase. |
| Q7 | One session-sized spec with an explicit "stop here if out of time" line (after Phase 6). |
| Q8 | The user reopened ADR 0005 (language) on 2026-08-27 evening: a rewrite in Go or Python is acceptable **if it buys suitable gains**. Resolved by evidence, not preference — see "Language decision" below and findings §7. |

## Language decision — ADR 0005 revisited (findings §7)

The question was put to documentation and to a measurement of a Python `livekit-agents` 1.7.1
worker on the same box with the same method as the Node numbers. The result:

- **Go: no, for any component.** There is no LiveKit Agents SDK for Go (L8); a Go worker is the
  dispatch protocol, Pion, an ONNX/cgo binding to the EOU/VAD models and every provider client
  from scratch. The control plane's ceiling is ~43 sequential Postgres round trips per turn — a
  batching problem D5 fixes in place; a Go port that kept the query pattern would keep the
  ceiling (L9).
- **Control plane in Python: no.** 7.5k LOC + 2.9k domain + 3.8k tests sharing `domain` and
  `contracts` with the console, and no measured bottleneck the language owns.
- **Voice worker: keep TypeScript, because the measured gap is topology and a patch, not
  language.** Python's idle tree is ≈ 0.97 GB vs Node's ≈ 2.2 GB, but for two reasons that do not
  transfer: Python's recommended path runs the EOU model *inside each job* (+243 MB per job, job
  process 489 MB vs Node's 185 MB) instead of in a shared process, and Node's main process pays
  the 772 MB probe that W1 removes. At the acceptance bar (N=10) Node-after-W1 is the lighter of
  the two (≈ 3.3–3.7 GB vs ≈ 5.4 GB commit on Windows `spawn`). Python's SDK has the same
  defaults, the same process-per-job design and the same class of memory issues (L1–L3, L6).
- **What the exercise did buy:** Node 1.6.4 already exports `inference.VAD` (native, same addon)
  and the worker uses Silero-ONNX; the native VAD measured **0.69 ms CPU/s of audio vs 4.4–6.3**.
  That is W11 in D4 — a ~6–9× VAD saving with no language change.
- **Kept in reserve, not pre-empted:** a Python **THREAD-executor** worker is the one
  configuration with a genuinely different memory shape (≈ 0.5 GB for the whole worker, sessions
  as threads; no crash isolation, no per-job memory limit, GIL exposure — L1). The worker proper
  is 698 LOC behind an HTTP/SSE contract and the equivalence harness validates any
  implementation, so a spike is 1–2 days. It is **Phase 7b**, triggered only if the N=10
  acceptance fails after Phase 4 on a memory ceiling (not a CPU or remote-stage one). ADR 0010
  records this as an amendment to ADR 0005, not a reversal.

## Problem Statement

The operator can see latency, cost, correctness and — since ADR 0009 — quality per call. But the
numbers on the Quality page are partly wrong (a p50 of two readings returns the larger one; the
SLO flips from breach to pass when a load test dilutes its window; "connected" counts calls that
never finished; a scheduled re-dial that no worker ever served is booked as a five-minute orphan and
drags the chaos number from 38 s to 308 s), some declared scores are never produced, a rejected
score batch is invisible, and the process that serves all of this has no metrics about itself.

Underneath, the voice worker needs **~2.4 GB of private memory before the first call** — a gigabyte
of it because the main process loads a 69 MB inference addon just to check that it exists — and
~200–290 MB per call on top; it runs in a mode that **cannot shed load**, serialises ~3 s cold starts
behind a mutex, and transpiles the whole workspace at boot in every child process. The control
plane spends ~43 Postgres round trips per turn, half of them avoidable, and re-reads and re-decodes
the ledger twice per turn. There is no container image, and the local observability stack has no
memory limits on a box that had 361 MB free. The August N=5 fleet result could not be reproduced
this week, and the diagnosis is the machine — which is exactly what this spec is for.

## Solution

Fix the metrics first so the optimisation work is measured by instruments that are right. Add a
**resource sampler** to both harnesses so every run reports CPU-seconds and peak RSS per process
alongside latency, and a soak mode so the ceilings the 7-second runs cannot see become visible.
Then take the levers in order of measured value: the worker's memory floor (W1), production mode
with an explicit load function (W2), warm process pool (W3), a built bundle instead of `tsx` (W3,
C5), thread-pool sizing for the EOU process (W4); the control plane's round trips (single-statement
event append, one-query context, incremental replay), its poll loops and its status N+1. Ship both
services as multi-stage, multi-arch `node:22-bookworm-slim` images; put limits on every container;
give the SFU its own CPU allotment. Finish by running two server processes behind one port with
leader-elected schedulers, and by re-running the fleet at N=10 on the quiet box with the
observability stack up. Record the per-core budget in an ADR and the README.

## User Stories

1. As an operator, I want p50/p95/p99 to be computed by a correct nearest-rank rule, so that the SLO verdict is not off by one observation.
2. As an operator, I want the SLO to be evaluated only over turns that have all the components it names (voice turns for EOU/STT/TTS, real-decider turns for TTFT), so that a scripted load run cannot flip the verdict.
3. As an operator, I want the SLO card to say "insufficient sample" below a minimum n instead of showing a p95 that is really the maximum, so that I do not act on noise.
4. As an operator, I want `connected` to count only finished calls, so that the contact rate is not inflated by abandoned simulations.
5. As an operator, I want the funnel to show that orphaned calls are a subset of failed calls, so that I do not read six bad calls where there were three.
6. As an operator, I want every finished call to carry a persisted `latency.slo_pass` score, so that "was this call within SLO" is a historical query, not a page refresh.
7. As an operator, I want a scheduled voice re-dial to actually place a call (or to be honestly recorded as not placeable), so that the retry path works and orphan detection time is not polluted by calls that never had a worker.
8. As an operator, I want a rejected Langfuse score batch to increment a counter and appear in the last-error ring, so that a silent 400 cannot hide for weeks again.
9. As an operator, I want rate-limit rejections counted and shown on the status page, so that I can tell "the agent is broken" from "my own middleware is shedding load".
10. As an operator, I want the reliability counts card to say "all time" when it is all time, or to honour the window selector, so that the page does not contradict itself.
11. As an operator, I want the status and quality endpoints to answer in bounded time regardless of ledger size, so that a console tab open during a load run does not itself become load.
12. As an operator, I want the Quality page to say why `no_promise_without_readback` has a smaller denominator than the promise count, so that a null is not read as a miss.
13. As an operator, I want event-loop lag, RSS, heap, GC time and pg-pool in-use/idle/waiting for the server, and RSS/CPU/active-jobs/idle-processes for each worker, on the status page and on a `/metrics` endpoint, so that the process itself is observable.
14. As an operator, I want `/readyz` to fail when a background loop has stopped ticking, so that a dead outbox is not "ready".
15. As an operator, I want every log line on the turn path to carry `conversation_id` and `turn_id`, so that a failure is joinable to its call.
16. As an operator, I want the trace payload to be redacted of account facts by default, so that the observability vendor is not a new place protected data lands.
17. As an engineer, I want every tier-1 and tier-2 run to report CPU-seconds and peak RSS per process, so that efficiency has a number in the same JSON as latency.
18. As an engineer, I want a tier-1 soak mode (fixed arrival rate for N minutes), so that the outbox ceiling, the `TurnRunner` retention map and status-page scans are visible.
19. As an engineer, I want the fleet harness to run its borrowers in a separate process (or box) and to report the worker's resource use separately, so that the fleet numbers measure the worker, not the laptop.
20. As an engineer, I want the main worker process not to load the inference addon, so that the worker's idle footprint drops by up to a gigabyte.
21. As an engineer, I want the worker to run in production mode with an explicit, concurrency-based load function, so that the sixth call queues instead of degrading the other five.
22. As an engineer, I want the idle process pool sized to the expected burst, so that a five-call burst does not pay fourteen seconds of serialised cold start inside the calls.
23. As an engineer, I want the server and the worker built to a single-file bundle and started with `node`, so that no process transpiles the workspace at boot and the pnpm/tsx launcher processes disappear.
24. As an engineer, I want the EOU inference process's thread pool sized, so that its predict ceiling is not the default four threads.
25. As an engineer, I want the Windows-only per-child `wmic` memory monitor disabled when no memory limit is configured, so that it does not spawn N+1 processes every five seconds for nothing.
26. As an engineer, I want the three 24→16 kHz resamples measured and, if worth it, collapsed to one at 16 kHz input, so that per-call CPU is not spent on redundant resampling.
27. As an engineer, I want an event append to be one statement, so that a terminal turn does not spend sixteen round trips numbering eight rows inside the row lock.
28. As an engineer, I want the conversation context built with one query (or memoised per call), so that T1 holds the row lock for six fewer round trips.
29. As an engineer, I want T2 to fold the events T1 wrote into the snapshot it already has instead of re-reading and re-decoding the whole ledger, so that per-turn work stops growing with call length.
30. As an engineer, I want the orchestrator's ledger read to skip schema validation of rows this process wrote, so that a 20-member union decode is not paid ~38 times per turn.
31. As an engineer, I want the `TurnRunner` retention to be bounded and cheap, so that a sustained load does not turn into an O(n²) map walk.
32. As an engineer, I want the outbox to process claimed jobs concurrently and to load the ledger once per job, so that post-call work keeps up with the turn path.
33. As an engineer, I want the sweeper's query indexed, so that a ten-second poll stays cheap as the table grows.
33a. As an engineer, I want `pg_stat_statements` on and its top-10 in every load report, so that each round-trip fix is a measured delta per statement, not a wall-clock guess.
33b. As an engineer, I want sequence numbers allocated from a counter on the conversation row, so that no turn aggregates over the ledger to write to it.
33c. As an engineer, I want the hot tables set up for HOT updates and aggressive autovacuum, and a sized `postgresql.conf` mounted into the container, so that per-turn updates do not bloat indexes and the server is tuned for the memory it is actually given.
34. As an engineer, I want two server processes behind one port with leader-elected schedulers, so that the architecture's claim that a second process is the scaling lever is measured, not asserted.
35. As an engineer, I want multi-stage, multi-arch Dockerfiles for the server and the worker with pruned production dependencies, so that either runs anywhere with a `docker run`.
36. As an engineer, I want the unused `agents-plugin-livekit` dependency removed, so that 200 MB of transitive ONNX runtimes leave the tree and the image.
37. As an engineer, I want every container in both compose files to have a memory limit and Langfuse/ClickHouse to have a retention policy, so that the observability stack cannot starve the voice pipeline.
38. As an engineer, I want a `pnpm stack:quiet` script that stops everything but Postgres and LiveKit and reports free memory, so that "quiet box" is a command, not a checklist.
39. As a reviewer, I want the README to state the per-core budget (calls per vCPU, MB per call, turns/s per core) with the run that measured it, so that "scales" has a number.
40. As a reviewer, I want ADR 0010 to record why the worker is patched, why the SLO window is segmented, and why the trace-per-turn shape is kept, so that the next session does not re-argue them.

## Implementation Decisions

### D1. Measure first: the resource sampler, the soak mode, and the per-core budget

- **Resource sampler** (`apps/load-test/src/resources.ts`, shared with the voice tracer): samples
  every process in the server's and worker's trees at 1 s (`pid`, role, RSS, private bytes, CPU
  time delta) and reports per-role **peak RSS**, **CPU-seconds**, and **CPU-seconds per turn**
  (tier 1) / **per call-minute** (tier 2). Windows: `Get-Process`/`Win32_Process` via a child
  `powershell` is acceptable for the harness; Linux/containers: `/proc`. Also samples
  `docker stats` for `feather-lite-livekit` and `feather-lite-postgres` when present. The tier-1
  and tier-2 JSON reports gain a `resources` block; the README tables gain two columns.
- **Tier-1 soak mode**: `--rate <turns/s> --duration <s>` open-loop arrival (not closed-loop
  concurrency), so a 5-minute run at 30 turns/s exercises the outbox ceiling (C2), the
  `TurnRunner` map (C1) and status-page cost (O11). Report the same fields plus RSS slope
  (MB/min) — the leak detector.
- **Tier-2 harness isolation** (W8): the fleet spawns its borrowers in a separate `node` process
  (`--borrower-proc`), samples the worker tree separately, and drops the per-frame JS RMS loop to a
  1-in-4 frame stride (the onset detector needs ~10 ms resolution, not 20 kHz). A `--remote-borrower
  <host>` variant is documented but not required this session.
- **Per-core budget** is defined once, here, and reported by the fleet run:
  `calls_per_vcpu = N / (worker_cpu_seconds / wall_seconds)` over the steady-state minute of an
  N-call run, `mb_per_call = (peak_rss_tree − idle_rss_tree) / N`, and for the server
  `turns_per_s_per_core = throughput / (server_cpu_seconds / wall_seconds)`. Where the vCPU count
  comes from is stated (`os.availableParallelism()`, and `.wslconfig processors` for containers).
- Baselines to take **before any optimisation lands**, on the quiet box: tier-1 C=100 and soak
  30/s×300 s; tier-2 N=2 and N=5 with the observability stack **up**; idle worker tree. These are
  the "before" for every later commit.

### D2. Observability correctness (O1–O16)

- **Percentiles** (O1): one `percentile(xs, p)` in the domain package, nearest-rank
  `xs[ceil(p/100·n) − 1]`, table-tested including n=1, n=2, n=20; both callers use it.
- **SLO window** (O2): `Quality.sloStatus` takes a **segment** — default `{channel: 'voice',
  decider: 'openai'}` — and the window is "last N calls *in the segment*". Each component is
  evaluated only over turns that carry it, with `n` and a **minimum sample `SLO_MIN_SAMPLE`
  (default 20)** below which the component reports `insufficient_sample` rather than pass/fail;
  p95 is never shown for n < 20. The console SLO card shows the segment and n. `conversations` gets
  a `decider` column if it does not already record which decider served it (check first — the
  `turn_end` frame and the trace metadata know).
- **Funnel** (O3, O5): `connected` requires `final_outcome IS NOT NULL`; `attempts` splits into
  `finished` and `in_progress`; the console renders `failed (of which orphaned n)`.
- **`latency.slo_pass`** (O6): the EVALUATION job writes it per finished call (turn rows exist by
  then), BOOLEAN, `null` when the call has no component measurements; comment names the breaching
  component. Now every name in the vocabulary has a producer; add a test that asserts that by
  grepping producers is not possible, so instead the DB test for the evaluator asserts the full
  expected name set for a voice-shaped fixture.
- **Scheduled voice re-dial** (O4): the scheduled-action worker, for `channel='voice'`, dispatches
  through `VoiceSessions` (make it a service the worker can use, not only the HTTP handler). When
  no media plane is configured, it does **not** create a conversation: it marks the action
  `FAILED` with reason `NO_MEDIA_PLANE` and logs once. The sweeper separately excludes from
  `system.orphan_detect_ms` any conversation that **never received a worker claim**
  (finalize reason `NEVER_SERVED`, counted, not timed) — an orphan is a call that *lost* a worker.
  Re-run `chaos-orphan.ts`; the p95 must return to the ~40 s class.
- **Langfuse failure visibility** (O7): install the SDK's logger/error hook (verify the v5 API with
  `find-docs`: `@langfuse/client`/`@langfuse/otel` accept a logger and expose export results on
  the span processor); every ingestion error increments `provider_langfuse_error` and lands in the
  last-error ring; `forceFlush` failure at shutdown is logged at warn. A unit test feeds a 400
  through the hook and asserts the counter.
- **Harness turn ids** (O8): `scripted-call` records the real `turn_id` from the `turn_start`
  frame (the worker's `turn_end` carries it; the harness observes the ledger anyway) and
  `harness-scores` posts that; the label moves to `comment`. `POST /scores` returns 422 for a
  `turn_id` that does not exist on that conversation.
- **Rate limiting** (O9): `http/app.ts` counts `rate_limited_start` / `rate_limited_turn` in
  `Metrics` and surfaces them on status; the bucket map is swept on write (entries idle > 2
  windows are dropped) and its size is a gauge. `RATE_LIMIT_BYPASS_TOKEN` (or a per-token, not
  per-IP, bucket when a bearer is present) so the tier-1 harness is not rate-limited by its own
  server — the 23/50 run on 2026-08-27 was that.
- **Reliability counts** (O10): the query takes the same window as the rest of the report (join on
  the window's conversation ids); the "durable, all-time" variant stays on `/status` only and is
  labelled "all time" in the console.
- **Status cost** (O11): `turnRowsFor` becomes one query with `conversation_id = ANY($1)`; the
  silent-playout flag is precomputed into `conversation_turns.result` when the playout signal
  lands; `sloStatus` on `/status` is memoised for 5 s. Verify with the soak run + a console tab
  open: server CPU-seconds must not move.
- **`no_promise_without_readback`** (O12): the score's comment says `no playout events (simulated
  call)` when null; the Quality page shows `n` per compliance row and a footnote.
- **Judge off under load** (O13): tier-1 harness refuses to start unless the server reports
  `judge.enabled=false` on `/status` or `--allow-judge` is passed.
- **`Metrics.observe`, doc comments, README numbers, loadtest row** (O14–O16): remove the dead
  histogram surface or wire it to the new process gauges (D3) — do not leave `{}`; fix the two
  doc comments; fix the README counts; replace the `7170 / 18211` row with the numbers from the
  committed JSON and a note that the earlier attempts were overwritten.

### D3. Process-level observability

- **Server gauges**, sampled every 5 s in-process, no new vendor: event-loop delay p50/p99
  (`perf_hooks.monitorEventLoopDelay`), `rss`, `heapUsed`, GC pause total
  (`PerformanceObserver` `gc`), pg pool `{size, idle, waiting}` (from the `@effect/sql-pg`
  pool — check what it exposes; fall back to counting acquisitions in a thin wrapper), scheduler
  liveness (`last_tick_at` per loop: scheduled actions, outbox, sweeper), active SSE streams,
  `TurnRunner.live.size`, rate-limit bucket count.
- **Worker heartbeat** (already every 10 s) additionally carries `rss` of main/inference/job
  processes, `active_jobs`, `idle_processes`, `load`, and the worker's `production` flag and
  `load_threshold` — so the status page can show that the worker is in the mode this spec
  requires. (W2 was invisible precisely because nothing reported it.)
- **Exposition**: all of the above on `/api/system/status` (`process` block) **and** on
  `GET /metrics` in Prometheus text format via `prom-client` (default registry + the `Metrics`
  counters), so `livekit-server`'s own `/metrics` (`prometheus_port` in `livekit.yaml`) and
  the app can be scraped by one Prometheus later. No Grafana in this spec.
- **Readiness** (`/readyz`): `SELECT 1` **and** every scheduler ticked within 3 intervals **and**
  (when Langfuse is enabled) the exporter has not failed its last two flushes. `/healthz` stays
  liveness-only.
- **Correlation**: `Effect.annotateLogs({conversation_id, turn_id})` at the top of `processTurn`
  and in `TurnRunner`; the OTel resource gets `service.name` = `feather-lite-server` /
  `feather-lite-worker` and `service.version` from `package.json`; `main.ts` logs the tracing state
  in every decider branch.
- **Redaction**: `TRACE_REDACT_ACCOUNT_DATA` (default **true**) masks amounts, dates and the
  account-fact patterns the context gate already knows in the turn span's `input`/`output`
  before export; the existing leak test grows a sibling that asserts the exported span body.

### D4. Voice worker: memory floor, load shedding, warm pool, runtime

Order matters; each item is measured with the idle-tree sample and a tier-2 N=5, and the
acceptance run (D9) is not attempted until D4 has landed.

- **W1 — do not load the addon in the main process.** A pnpm patch to `@livekit/agents@1.6.4`
  (the repo already patches the Deepgram plugin the same way) replaces the `require` at
  `worker.ts:52` with a `require.resolve` probe, or moves the availability check into the
  inference process's own init and reports it back over IPC. Expected: −322 to −772 MB idle
  (the spread is the open question in the findings; measure both `dev` and the bundled `start`
  and record which applies). Open an upstream issue with the measurement; link it in the patch.
- **W2 — production mode, explicit load.** `pnpm start:worker` runs `agent.js start` (production
  → `loadThreshold` 0.7, no debug pretty logs). Additionally set an explicit
  `loadFunc = activeJobs / WORKER_MAX_JOBS` (LiveKit's documented pattern) with
  `WORKER_MAX_JOBS` from env, default set by the D9 measurement (start at 8 on this box), and
  `loadThreshold` 0.75 — so the sixth-or-whatever call **queues** at the SFU instead of every
  call degrading. `pnpm dev:worker` may stay in `dev` mode for interactive use, but **all fleet
  measurements from now on use `start` mode**, and the fleet harness asserts the heartbeat's
  `production=true` before it begins.
- **W3 — warm pool.** `numIdleProcesses` = `WORKER_IDLE_PROCESSES` env, default
  `min(WORKER_MAX_JOBS, 4)`; verify live that the pool actually pre-warms ahead of a burst (the
  findings flag `initMutex` serialisation as unverified). Then reduce `initializeProcessTimeout`
  back toward the 10 s default as the cold start shrinks (W3 + D6 bundle).
- **W4 — inference thread pool.** `UV_THREADPOOL_SIZE` set for the worker process (inherited by
  both child kinds) to `min(12, availableParallelism)`; measured +29% EOT throughput at
  concurrency 10. Verify with the N=10 run's `eou_delay_ms` p95.
- **W7 — memory monitor.** Patch or configure `supervised_proc` so the 5 s `pidusage` poll is
  skipped when `jobMemoryLimitMB === 0 && jobMemoryWarnMB === 0` (or set both to real values —
  the spec's preference is real values: warn 400 MB, limit 800 MB per job, since jobs are ~185–290
  MB); on Windows, measure the spawn cost once and record it.
- **W11 — native VAD.** Replace `silero.VAD.load()` with `inference.VAD` from `@livekit/agents`
  (already exported in 1.6.4, backed by the same `local-inference` addon; verify the constructor
  options and the `activation_threshold`/`min_silence` equivalents with `find-docs` — a change in
  VAD thresholds changes barge-in timing, which the equivalence harness and the per-turn EOU
  delay will show). Measured in Python on the same addon: 0.69 ms CPU per second of audio vs
  4.4–6.3 for Silero-ONNX. Gate: equivalence + WER + `eou_delay_ms` p95 unchanged or better on
  N=5. If it holds, `@livekit/agents-plugin-silero` and `onnxruntime-node` leave the tree too.
- **W5 — resampling A/B** (last, smallest): room input `sampleRate: 16000` and STT resampler
  `QUICK`, measured on N=5 with WER as the gate; keep only if WER and equivalence hold and CPU
  moves.
- **W6 — TTS socket: measure, do not pool.** Add the websocket connect duration to the
  `turn_metrics` waterfall (`tts_connect_ms`) so the per-turn handshake cost is a number. If it is
  ≥ 100 ms p50, the *next* spec can decide on a per-session warm socket with the ADR 0008 caveats;
  this one does not.
- **Endpointing table** (W10): log the effective `turnDetection`/`endpointing` values at session
  start once, so the 300/2500 claim in `agent.ts:130-136` is verifiable from a run.
- **Dependency hygiene**: remove `@livekit/agents-plugin-livekit` from the worker (unused since
  Phase 9 P4; pulls `@huggingface/transformers` + two ONNX runtimes); `pnpm install` and confirm
  `node_modules` shrinks by ~200 MB and nothing imports it. Delete the stale HF cache note from any
  doc that says `download-files` fetches the EOU model.

### D5. Control plane: fewer round trips, no growth with call length, bounded retention

Each lands as its own commit with a tier-1 C=100 before/after; the correctness gate is the guard.

- **appendEvent in one statement**: `INSERT … SELECT COALESCE(MAX(sequence_no),0)+1 …
  RETURNING sequence_no` under the row lock already held; `UNIQUE (conversation_id,
  sequence_no)` remains the safety net. Stretch: multi-row insert with `row_number()` for a
  phase's batch. Expected ≈ −25% round trips.
- **Context in one query**: fold the six `ContextBuilder` selects into one joined select plus the
  prior-conversations select (6 → 2). Memoisation per call is the stretch, gated on the three
  writers invalidating.
- **Incremental replay**: T2 carries T1's snapshot and reads `WHERE sequence_no > $lastSeen`,
  folding with the already-exported `applyEvent`; `executeTool` receives the folded snapshot
  instead of replaying a third time. Covered by the DB concurrency, supersede and read-back tests.
- **Unchecked read on the hot path**: `listEventsUnchecked` for the orchestrator (rows this
  process wrote), validating `listEvents` kept for `Queries.conversationDetail`. Take a
  `node --cpu-prof` at C=100 before and after and put the top-5 self-time frames in the commit.
- **Memoise `toolSpecsFor`** by tool name (C4).
- **`TurnRunner` retention** (C1): keep `turn_start`/`say`/`turn_end` only (a reconnect does not
  need deltas), expire on a 30 s scoped fiber instead of gc-on-every-run, gauge the map size (D3).
  Verified by the soak run's RSS slope.
- **Outbox** (C2): `Effect.forEach(jobs, …, {concurrency: OUTBOX_CONCURRENCY})` default 4; load
  the ledger once per job and pass it to `processJobTx`; the judge's second read goes. Merge
  SUMMARY/EVALUATION/VECTOR_INDEX into one job **only if** a soak run shows the outbox behind
  the turn path after concurrency lands.
- **Sweeper index** (C3): partial index on `conversations (started_at) WHERE ended_at IS NULL AND
  final_outcome IS NULL`, migration `0006`.
- **Runtime** (C5): `tsc` (or `tsup`) build for `apps/server` → `dist/main.js`; `start` runs
  `node dist/main.js`; `dev` keeps `tsx watch`. `NODE_OPTIONS="--max-semi-space-size=64"` tried
  and kept only if tier-1 `turn_wall.p95` improves (allocation-heavy code; GC shows in the tail).
- **Prepared statements** (C8): one experiment — check whether `@effect/sql-pg` names its prepared
  statements; if not and it can be turned on, measure. Record the answer either way; do not swap
  drivers in this spec.
- **SSE encode** (C6): drop `Schema.encodeSync` for frames this process constructs; coalesce deltas
  per event-loop tick. Last, smallest.

### D5b. Postgres itself: measure it, size it, keep the ledger durable

Postgres is **not** the current constraint (52 MiB RSS, ≤ 2.7 % CPU, 0 lock waits, 6/11 backends
active at C=200 — findings §4, C7), so server tuning is second-order to D5. It is still cheap, and
without it the D5 commits are measured by wall clock alone. In order of value:

- **`pg_stat_statements` on, and read.** Add `shared_preload_libraries=pg_stat_statements` to
  the compose command for the app Postgres (and to the migration-time check so a server without it
  logs a warning, not an error). The tier-1 harness's `pg_at_peak` block gains the **top 10
  statements by total time and by calls** for the run, reset before each run. This is what turns
  "43 round trips" into a per-statement ranking and is the first Postgres commit — before any D5
  change lands, so each one shows up as a delta in the same table.
- **Own the sequence number.** Instead of `SELECT MAX(sequence_no)+1` (even folded into one
  statement as D5 proposes), add `conversations.next_sequence_no` and allocate with
  `UPDATE conversations SET next_sequence_no = next_sequence_no + n WHERE id = $1 RETURNING …`
  under the row lock T1/T2 already hold. One round trip per *batch* of events, no aggregate over
  the ledger, and the invariant is enforced by the same `UNIQUE (conversation_id, sequence_no)`.
  Migration backfills from `MAX`. Decide between this and the D5 single-statement form by the
  `pg_stat_statements` numbers; do not ship both.
- **HOT updates on the hot rows.** `conversations` is updated on every turn (`active_turn_id`
  CAS, `next_sequence_no`), `conversation_turns.result` on every playout/metrics signal. Set
  `fillfactor = 80` on both tables so those updates stay heap-only and do not touch indexes,
  and make sure no updated column is indexed (check `ix_conversations_started` and the new partial
  index from C3 only cover columns the per-turn `UPDATE` does not change). Verify with
  `pg_stat_user_tables.n_tup_hot_upd / n_tup_upd` after a soak run — the ratio should be > 0.9.
- **Autovacuum for the write-heavy tables.** Per-table `autovacuum_vacuum_scale_factor = 0.02`,
  `autovacuum_analyze_scale_factor = 0.01` on `conversations`, `conversation_turns`,
  `outbox_jobs`, `scheduled_actions` (the claim queries use `SKIP LOCKED` over small hot sets;
  dead tuples there cost every poll). Watch `n_dead_tup` in the soak report.
- **Server config for the container**, in a mounted `postgresql.conf` fragment, sized to the
  `mem_limit` D6 gives it (512 MB): `shared_buffers=128MB` (the default is right at this size),
  `effective_cache_size=384MB`, `work_mem=8MB`, `maintenance_work_mem=64MB`,
  `wal_compression=on`, `checkpoint_completion_target=0.9`, `max_wal_size=1GB`,
  `random_page_cost=1.1` (SSD), `jit=off` (short OLTP statements; JIT only adds planning
  latency), `log_min_duration_statement=250ms`, `track_io_timing=on`. **`synchronous_commit`
  stays `on`**: the ledger is the product's durability claim (ADR 0001/0003); a 1–2 ms fsync per
  commit is not the bottleneck and turning it off would be the one Postgres change this spec
  forbids.
- **Indexes, from evidence not intuition.** After `pg_stat_statements` and a soak run, add only
  what the top-10 shows: the C3 partial index for the sweeper; `conversation_events
  (conversation_id, type)` if `guardrailCounts`/the `EXISTS` subqueries survive O10/O11; an
  expression index on `(payload->>'turn_id')` only if the `EXISTS` shape survives. Check
  `pg_stat_user_indexes.idx_scan` after the run and drop anything unused.
- **Pool shape stays 10 per process** (the 2026-08-21 experiment). With D7's second process that
  is 20 backends; no PgBouncer in this spec — it adds a hop to a workload that is round-trip bound.
  Revisit only if `pg_stat_activity` shows connection churn.
- **Growth and retention.** `conversation_events` is append-only jsonb; at this scale it is
  small (the dev DB is 9.4 MB). Write down, in the loadtest README, the measured bytes per turn
  and bytes per call from a soak run so a retention/partitioning decision later has a number.
  Partitioning by month and a retention job are named as future work, not built.
- **What is measured**: every D5/D5b commit reports `pg_stat_statements` top-10 deltas,
  `n_tup_hot_upd` ratio, `n_dead_tup`, and the tier-1 numbers. Server-side changes are expected
  to move p99 more than p50; say so in the commit if that is what happens.

### D6. Build and containers

- **Build**: both apps get a `build` script producing a single-file ESM bundle with `esbuild`
  (`--platform=node --format=esm --bundle --packages=external` for native and workspace-external
  packages; workspace packages **inlined**), sourcemaps to a separate file, `start` = `node
  dist/….js`. Cold start of a job process is measured before/after (2 800 ms baseline; expect
  < 1 000 ms).
- **Dockerfiles** at `apps/server/Dockerfile` and `apps/voice-worker/Dockerfile`, both:
  `node:22-bookworm-slim` (glibc is a hard requirement — Alpine is out), multi-stage
  (`deps` → `build` → `pnpm deploy --filter <app> --prod /out` → runtime), `ca-certificates`
  installed explicitly, non-root user, `NODE_ENV=production`, `HEALTHCHECK` against
  `/healthz` (server) / the worker's own HTTP health port (check the agents CLI `--port`), and
  `--platform linux/amd64,linux/arm64` via `docker buildx`. **Verify `@livekit/local-inference`,
  `@livekit/rtc-node` and `onnxruntime-node` publish `linux-arm64-gnu` binaries before promising
  arm64 in the README**; if any does not, arm64 is documented as server-only. Nothing to bake for
  the EOU model (it is inside the addon); `silero_vad.onnx` ships in the plugin. Target sizes
  (estimates, to be measured and written down): server ≈ 250–350 MB, worker ≈ 350–450 MB.
- **Compose**: an `app` profile that runs `server` and `worker` from those images, so the N=10
  acceptance run can be repeated with `docker compose --profile livekit --profile app up`.
  `livekit` gets `cpus: 2` and `mem_limit: 512m`; `postgres` `mem_limit: 512m`.
  `deploy/langfuse/docker-compose.yml` gets limits (clickhouse 768m, web 512m, worker 512m,
  minio 128m, redis 64m, postgres 256m), `LANGFUSE_*` retention / ClickHouse TTL (verify the v4
  self-host settings with `find-docs`), and a note that MinIO is replaceable by external S3.
  `.wslconfig` recommendation (`autoMemoryReclaim=gradual`) goes into the README's local-run
  section — it is the user's file, not the repo's.
- **`pnpm stack:quiet`**: stops the Langfuse stack and any stray worker, prints free memory and
  `vmmemWSL` working set, and warns if `vmmemWSL` > 3 GB with the stack down.

### D7. Two server processes (final, measured)

- Schedulers become **leader-elected** with `pg_try_advisory_lock` per loop (scheduled actions,
  outbox, sweeper), so N processes poll once, not N times; the lock holder is on `/status`.
- Run two `node dist/main.js` processes on `PORT` with `reusePort` (Node 22 `net` supports it;
  verify) — or, if not on Windows, behind a one-line `caddy`/`nginx` in compose for the container
  path. Tier-1 C=200 before/after; expect near-linear turns/s with `pg_at_peak.waiting` still 0.
  If lock waits appear, that is a finding, not a failure; write it down.

### D8. Documentation and the ADR

- **ADR 0010** (`domain-modeling` skill): why the worker is patched rather than forked or
  upgraded; why the SLO window is segmented and has a minimum sample; why trace-per-turn is kept
  (a per-call trace would need the worker in the trace context and a minutes-long open root
  span; the session id already joins them and Postgres is the aggregation store per ADR 0009);
  why the memory monitor is configured rather than removed; the per-core budget as measured.
- README: status rows for "shippable images", "process metrics", "per-core budget"; the run-it
  section gains `pnpm stack:quiet` and the `.wslconfig` note; the "Not built" list drops
  "horizontal scale untested" if D7 lands.
- `docs/loadtest/README.md`: new dated section with the resource columns and the N=10 result;
  the O16 row reconciled.

### D9. Acceptance run and the numbers this spec must produce

On the quiet box, `pnpm stack:quiet` then `pnpm lf:up` (the stack must be **up** for acceptance),
worker in `start` mode, borrowers in their own process:

1. `pnpm loadtest:tier2 -- --calls 10` — **10/10 equivalence green, WER ≤ 0.20, zero silent
   playouts not attributable to supersede, SLO verdict pass on the voice segment (n ≥ 20 turns)**,
   twice in a row.
2. The report's `resources` block: worker tree idle RSS, peak RSS, CPU-seconds; `calls_per_vcpu`
   and `mb_per_call` as defined in D1; SFU and Postgres container stats.
3. `pnpm loadtest:tier1 -- --concurrency 100` and the soak: turns/s per core, RSS slope ≈ 0.
4. The same N=10 with the `app` compose profile (containers), reported separately.

If 10/10 is not reached, the spec is not failed — the report says what N was reached, why (which
stage degraded, local or remote, from the waterfall), and what the per-core figure was. That is
what the README states.

## Testing Decisions

- A good test asserts external behaviour on an existing seam: the status/quality JSON, the
  ledger + scores after a job, the recording `Tracing`'s captured records, the fleet/tier-1 report
  JSON — never the SQL text or the worker's internals.
- **Domain (pure):** `percentile` table tests (n=1,2,3,20; p50/p95/p99); funnel arithmetic on
  fixtures including in-progress rows; redaction patterns; `applyEvent` incremental fold equals
  full `replay` on every scenario fixture (property-style over the 20 scenarios).
- **Control plane DB:** appendEvent single-statement keeps `sequence_no` dense under the
  concurrency test; incremental T2 passes the supersede/read-back tests unchanged; scheduled voice
  retry with no media plane → action FAILED `NO_MEDIA_PLANE`, no conversation row; sweeper
  distinguishes NEVER_SERVED from ORPHANED and only the latter is timed; `latency.slo_pass`
  written by the evaluator on a voice fixture, null on a simulate fixture; scores POST 422 on an
  unknown `turn_id`; leader election — two schedulers, one ticks; Langfuse error hook increments
  the counter (unit, with a fake logger).
- **HTTP:** `/readyz` fails when a loop's `last_tick_at` is stale; `/metrics` exposes the counter
  names; rate-limit counters move on 429; bypass token works.
- **Harness:** every tier-1/tier-2 report validates against a schema that requires the
  `resources` block; the fleet refuses to run against a `dev`-mode worker without `--allow-dev`.
- **Images:** CI job builds both images for amd64 (arm64 build-only if the binaries exist) and runs
  the server image against the Postgres service container through `/readyz`; image sizes are
  printed in the job log and copied into the README.
- **Live:** every phase's verification below; the D9 acceptance run last.

## Out of Scope

- Python worker, vendor swaps, a different SFU, Kubernetes manifests (the compose `app` profile is
  the deployable unit here; the LiveKit K8s template is referenced in the findings for later).
- A per-call Langfuse trace / W3C context propagation from the worker (recorded in ADR 0010 as
  deliberately kept per-turn).
- Grafana/Alertmanager; paging.
- Driver swap (`postgres.js`) — one prepared-statement experiment only.
- TTS socket pooling (measure only, D4 W6).
- Everything ADR 0008/0009 rejected; PSTN; Effect 4; `record_payment`; judge calibration (still the
  natural next piece after this).

## Further Notes

### Suggested phase order (one or more commits each; verify per phase)

| Phase | What | Verification |
|---|---|---|
| 0 | D1 sampler + soak + harness isolation + per-core definitions; **baselines** taken and committed as JSON | tier-1 C=100 + soak 30/s×300 s; tier-2 N=2, N=5 (stack up); idle tree sample |
| 1 | D2 metric correctness: O1, O2, O3, O5, O6, O9, O10, O11, O12, O13, O14–O16 | unit + DB tests; `/quality` before/after on the same DB; soak with a console tab open |
| 2 | D2 O4 (voice re-dial + NEVER_SERVED) and O7, O8 | `chaos-orphan.ts` p95 back in the ~40 s class; scores from a `fake-borrower` run join `conversation_turns`; injected 400 shows on status |
| 3 | D3 process metrics, `/metrics`, readiness, correlation, redaction, worker heartbeat fields | status JSON + `/metrics` scrape; a killed outbox fiber fails `/readyz`; leak test sibling |
| 4 | D4 W1 (patch), W2 (start mode + loadFunc), W3, W4, W7, dependency hygiene | idle tree before/after; N=5 twice; heartbeat shows `production=true`, load, idle procs |
| 5 | D6 bundle + Dockerfiles + compose limits + `stack:quiet` (server first, then worker) | cold-start before/after; `docker run` of each image passes `/readyz` / registers with the SFU; sizes recorded |
| 6 | **D5b first** (`pg_stat_statements` + top-10 in the report, `next_sequence_no`, fillfactor/autovacuum, mounted `postgresql.conf`), then D5 in the order listed (append → context → incremental replay → unchecked read → memo → TurnRunner → outbox → evidence-based indexes → runtime) | tier-1 C=100 per commit with the `pg_stat_statements` delta; soak RSS slope, HOT ratio, dead tuples; `--cpu-prof` top frames in the commit |
| — | **Stop here if out of time.** Everything above is the high-yield core; D9 can be run at this point and the README updated. | |
| 7 | D4 W11 (native VAD), W5 (resample A/B), W6 (`tts_connect_ms`), endpointing log | N=5 with WER gate; `eou_delay_ms` p95 |
| 7b | **Conditional.** Python THREAD-executor worker spike (`apps/voice-worker-py`, ≤ 2 days), only if the Phase-4 N=10 attempt failed on a *memory* ceiling. Same HTTP/SSE contract, same signals, `llm_node` override; measured with the same fleet harness and resource sampler. Outcome either way goes into ADR 0010. | `fake-borrower` equivalence PASS; N=10 with the sampler; side-by-side table vs the Node worker |
| 8 | D7 two processes + leader election | tier-1 C=200 one vs two processes |
| 9 | D9 acceptance N=10 (native, then containers); D8 ADR 0010, README, loadtest README, PROGRESS | the numbers in the README are the ones the run produced |

### Decisions the implementer should not re-open

- Trace-per-turn stays (D8). Postgres-first stays (ADR 0009). The worker is **patched, not
  upgraded**, in this work — `@livekit/agents` 1.7+ changes EOU/endpointing behaviour that was
  measured on 1.6.4; an upgrade is its own spec with its own fleet baseline.
- The SLO segment default is voice + real decider. Simulated calls get their own segment on the
  page, never mixed.
- Production images are `bookworm-slim`, never Alpine. Multi-arch is promised only for packages
  whose arm64-gnu binaries are verified to exist.
- The memory monitor gets real limits rather than being deleted: a job that grows past 800 MB is a
  bug the operator should see.
- The language stays TypeScript for every component (Q8, findings §7). Go is closed. A Python
  worker exists only as the conditional Phase 7b spike, and only on a measured memory ceiling —
  not because a number in a blog post said Python is lighter. ADR 0010 amends ADR 0005 with the
  measured table so the question is not reopened on the same evidence.

### Risks and how each is caught

- **The 772 MB may be `tsx`/ESM-specific** and shrink on its own once the worker is bundled
  (findings W1 open question). Measure W1 both ways and keep the patch only if it still pays under
  the bundle; the order (Phase 4 before Phase 5) exists so the number is known either way.
- **Production mode changes dispatch behaviour** (load shedding, no debug logs). The first `start`
  -mode N=5 may differ from every earlier fleet number; that is why Phase 0 baselines include a
  `start`-mode run before any patch lands.
- **Incremental replay is the one change with correctness risk.** It is gated by the 20 scenarios,
  the concurrency/supersede tests, the read-back guard tests and the property test in Testing
  Decisions; if any disagrees with full replay, the commit is dropped, not patched around.
- **Container networking for the worker on Docker Desktop** (host UDP mux at 7882, `--node-ip
  127.0.0.1`): the `app` profile joins the compose network and points `LIVEKIT_URL` at the
  service name; the browser path still uses the published ports. Verify with a `fake-borrower`
  run against the containerised worker before the N=10 container run.
- **The user's box is shared** (Firefox, two Claude Code sessions, Defender were the top consumers
  at audit time). `pnpm stack:quiet` reports, it cannot fix that; the acceptance run's report
  records free memory at start so a failed run is attributable.

### Research inputs (summarised in the findings §6; not repeated here)

LiveKit worker options and sizing; turn-detector v1-mini runtime; Deepgram plugin defaults;
LiveKit Node build guidance (glibc, slim, `node dist/agent.js`); agents' native metrics and OTel
export; Langfuse v5 sampling/batching; V8 semi-space guidance; the absence of any published
calls-per-vCPU figure from commercial vendors.
