# Load test results

Raw reports are the JSON files beside this one; this page is the reading of them. Re-run with:

```bash
pnpm loadtest:tier1 -- --concurrency 100 --ramp 2      # control plane, closed loop (heavy)
pnpm loadtest:tier1 -- --rate 30 --duration 300        # control plane, open-loop soak
pnpm loadtest:tier2 -- --calls 5                       # real voice calls (modest)
pnpm loadtest:idle  -- --seconds 90 --label start-mode # what the trees cost doing nothing
```

Both harnesses gate on **correctness, not latency**: a run passes only when every conversation's
final ledger matches the `happy-path-promise-to-pay` simulation scenario — same state path, same
tool sequence, same outcome. The reference is produced by running that scenario through the same
API on the same box, so the assertion tracks the scenario suite instead of a constant in a script.

Since 2026-08-27 the tier-2 run has a **second** gate: word error rate (`--max-wer`, default 0.20).
Equivalence is correctness and WER is transcription quality, and a run that stayed correct only
because the scripted borrower's words happened to survive mangling is not a pass. The report also
carries TTS heuristics — silent playouts, TTS first-byte percentiles, characters-per-second
outliers — which are **not** gated and are **not** a quality score; see ADR 0009 for why there is no
MOS model here.

## What a run reports since 2026-08-27

Every run now samples each process in the server's and the worker's trees once a second and reports
**peak RSS, peak private bytes and CPU-seconds per process role** beside the latency, plus the
per-core budget derived from them. Before this, "faster" and "cheaper" were the same number and
neither was measured: a run that was slow because the box was starved read exactly like a run that
was slow because the code had regressed.

Processes are named from their command lines — `server`, `server-launcher`, `worker-main`,
`worker-inference`, `worker-job`, `worker-launcher`, `harness`, `harness-borrower`. **A node process
the sampler cannot name is counted as `unclassified` and left out of every total**, because this is
a laptop with other node processes on it and quietly folding one into the worker's tree is exactly
the flattering number these harnesses exist not to produce.

### The per-core budget, defined once

```
cores_used                  = steady-state cpu_seconds / steady-state wall_seconds
calls_per_vcpu              = N / worker cores_used
mb_per_call                 = (peak worker tree − idle worker tree) / N     (both counters)
turns_per_s_per_core        = throughput / server cores_used
cpu_seconds_per_turn        = server cpu_seconds / turns completed
cpu_seconds_per_call_minute = worker cpu_seconds / minutes of call carried
```

The vCPU count is `os.availableParallelism()` — 12 on the dev laptop (Ryzen 5 5600H, 6C/12T). For a
containerised run it is the cgroup's, which under Docker Desktop here is `.wslconfig processors`
(4); a report taken inside a container says so in its own `vcpus`.

**Cores are counted over the busiest contiguous minute of the load, not the whole run.** A fleet run
spends thirty-odd seconds creating rooms before the last call connects, and staggers at the end;
averaging a call's fixed cost across that idle head and tail understates how busy the worker was
while it was actually carrying N calls. Measured on a pre-fix N=5 run, the whole-window figure came
out at roughly half the busiest-minute one — all of the difference in the direction that makes the
machine look better. (Both readings came from the window arithmetic that the note in the tier-2
section below describes as unfixed at the time, so they are quoted as a shape, not as a baseline.) The report says `full_window: true`, and the console line says so in
words, when a run is too short to contain a minute (every closed-loop tier-1 run is).

**The per-unit-of-work figures are not windowed.** `cpu_seconds_per_turn` and
`cpu_seconds_per_call_minute` divide by work done rather than by wall clock, so they take the whole
load window; windowing the numerator alone would understate both.

**Read `cpu_seconds_per_turn` for a before/after, not `turns_per_s_per_core`.** The per-core figure
is a ratio of two noisy quantities and moves further than either: five C=100 runs gave 71 / 99 / 111
/ 107 / 114 turns/s/core against 0.0218 / 0.0148 / 0.0139 / 0.0145 / 0.0136 CPU-seconds per turn.

**Discard the first run after a server restart.** That 0.0218 is the cold one — first run against a
freshly started process, 70.5 turns/s where the four warm runs sit at 79–84. Warm, the spread on
CPU-seconds per turn is 9 %.

### Reading the memory numbers honestly

- **`idle` is the first sample**, taken before the load starts. It is the `idle_rss_tree` term of
  `mb_per_call`, and it is only meaningful because the sampler starts before the harness does
  anything.
- **Peaks are joint, not summed.** The peak for a role is the largest total its processes held *at
  the same moment*; adding per-process maxima reached at different moments describes a tree that
  never existed.
- **The slope is reported for both counters, and they disagree.** Windows trims idle working sets,
  so a tree doing nothing reports −51 MB/min of RSS while its private commit sits still. Private
  bytes is the counter to read for a leak; RSS is the counter that says what the box is holding.
  Neither is reported under a minute of wall clock, where settling noise reads as a trend.
- **`mb_per_call` is reported in both counters for the same reason.** A worker left alone long
  enough gets its working set trimmed — measured here, a main process of **194 MB RSS against
  1 023 MB of private commit** — so an idle term taken from RSS depends on how long the worker has
  been idle, and the first call merely faulting its own pages back in is charged to the per-call
  figure. When the idle reading is honest the two agree closely (318 vs 309 MB at N=1); when they
  diverge, the private one is right.
- **Let the worker settle between fleet runs.** Running N=1, N=2 and N=5 back to back put the
  previous run's job processes inside the next run's idle tick, which reported `MB/call 3` — a
  number so obviously wrong it was caught, unlike the ones that are merely somewhat wrong. The
  harness does not enforce this; the operator does.

### Two things a load run needs from the server

- **Raise the rate limiter.** `RATE_LIMIT_PER_MINUTE` (default 120) and `DAILY_TURN_CAP` (5000) are
  per-IP demo hardening, and a tier-1 run comes from one IP. A C=100 run against the defaults
  reported 8/100 correct with 67 start errors and 25 turn errors, all 429 from the server's own
  middleware. The harness now says so in as many words instead of leaving it to be read as a
  regression; O9 will give it a bypass token and the status page a counter.
- **`JUDGE_ENABLED=false`.** A C=50 run would otherwise enqueue fifty reasoning-model calls.

## 2026-08-28 — the efficiency phase, measured commit by commit

Every row here was taken on the same box in one sitting, with the voice worker stopped for the
control-plane runs and the Langfuse stack down. Two pieces of measurement hygiene were added on the
day and both changed what the numbers said:

- **The harness waits for the outbox to drain before it starts.** A C=100 run leaves 300 post-call
  jobs; the loop was clearing them at four a second, so the next run began inside a 70-second
  backlog and reported a throughput that was really the drain. Two runs three minutes apart read
  80.5 and 69.8 turns/s while the database time between them *fell* 1 521 → 921 ms. This is very
  likely also why the five Phase-0 C=100 runs disagreed with each other.
- **`pg_stat_statements` is on**, reset immediately before each load, and every report carries the
  top ten by total time, the top ten by calls, and **statements per completed turn**. That last
  number is the one to read for a round-trip change; wall clock on this box has a spread of ±10 %
  and will hide a 17 % reduction completely.

### Tier 1, C=100, in the order the changes landed

| after | correct | turns/s | turn p50 | statements/turn | pg time |
|---|---|---:|---:|---:|---:|
| baseline | 100/100 | 80.5 | 524 ms | **43.6** | 1 521 ms |
| (indexes, before) ×2 | 100/100 | 76.0 / 77.3 | 625 / 582 ms | 43.2 | 1 462 / 1 449 ms |
| two indexes from the ranking ×2 | 100/100 | 78.7 / 78.3 | 560 / 555 ms | 43.1 | 925 / 956 ms |
| + event append in one statement ×2 | 100/100 | 78.4 / 88.0 | 597 / 440 ms | **35.7** | 832 / 862 ms |
| + prompt context in one query ×2 | 100/100 | 81.2 / 89.1 | 556 / 419 ms | **31.7** | 915 / 859 ms |
| + work-conserving outbox ×2 | 100/100 | 83.8 / 94.3 | 505 / 351 ms | 31.7 | 845 / 808 ms |

**43.6 → 31.7 statements per completed turn, −27 %**, and database time down about 45 %. The audit's
"about 43 round trips per turn", read from the code, was exactly right — and the server said so
itself once it was asked.

**Throughput is the least informative column.** 78 and 88 turns/s came from identical code three
minutes apart. Read `statements/turn` and `pg time` for what changed, and treat anything under about
10 % of wall clock as noise; the audit's own finding was that Postgres is not the constraint, so
fewer round trips buy headroom rather than throughput.

The one statement a round-trip audit could never have found: **`SELECT DISTINCT job_type FROM
outbox_jobs WHERE conversation_id = $1`**, once per finished call, 5.9 ms each, **40 % of all
database time in a run** — a sequential scan over 32 838 rows, because `outbox_jobs` had no index on
`conversation_id`. One call per call, so no count of round trips would ever have looked at it.

### The soak, and what grows

`--rate 30 --duration 300`, 3000 conversations and 9000 turns, all correct in every run.

| after | private slope | server peak private | CPU s/turn |
|---|---:|---:|---:|
| before | 46.25 MB/min | 502 MB | 0.0151 |
| turn deltas dropped at `turn_end`, sweep throttled | 37.58 MB/min | 411 MB | 0.0146 |
| + retention 5 min → 60 s | **26.27 MB/min** | 415 MB | 0.0145 |

**26 MB/min is not zero and is not claimed to be.** The retention map's share is measured and gone;
the remainder is unattributed — Effect fiber structures, the `pg` statement cache and ordinary V8
growth under sustained allocation are the candidates. The peak barely moved while the slope fell by
a third, which suggests the peak is a transient rather than retention. `feather_lite_live_turns` on
`/metrics` is the series to watch it with.

**Post-call work no longer paces itself.** The outbox claimed 20 jobs every 5 seconds and processed
them one at a time: 283 jobs took **74 seconds**. Processing a batch concurrently made a batch about
four times faster and the backlog still took 74 seconds, because the ceiling was the claim rate, not
the work. With the loop claiming again while batches come back full: **103 jobs in 4 seconds**, and
the backlog stops accumulating between runs.

### Where the server's CPU actually goes

`PROFILE_SECONDS=30 pnpm start:server` writes a `.cpuprofile` the process takes of itself —
`node --cpu-prof` cannot be used here, because it writes only on a clean exit and Windows has no way
to ask a detached console process for one. `node scripts/cpuprof-top.mjs <file>` reads it.

C=100, 5 545 ms of busy time:

| self ms | of busy | frame |
|---:|---:|---|
| 582.9 | 10.5 % | `writev` |
| 421.5 | 7.6 % | `(program)` |
| 343.1 | 6.2 % | `(garbage collector)` |
| 114.1 | 2.1 % | effect `fiberRuntime.js:1142` |
| 94.1 | 1.7 % | `addFields` (pg row parsing) |
| 74.7 | 1.3 % | effect `ParseResult.js:867` |

**There is no hot spot**, and schema decoding is not one: every `ParseResult` frame together is
about 2.4 % of busy time, rows and events included. That is why `listEventsUnchecked` — skipping
validation of ledger rows on the hot path — **was not built**: it trades the boundary that keeps a
malformed row out of `replay` for one or two percent of a small slice.

### The voice worker, idle (private commit, `start` mode)

| role | tsx, 1 warm slot | after the W1 patch | + 4 warm slots | bundled |
|---|---:|---:|---:|---:|
| worker-main | 1 051 | 177 | 192 | **115** |
| worker-inference | 878 | 879 | 880 | 871 |
| worker-job | 197 (×1) | 199 (×1) | 1 056 (×4) | 520 (×4) |
| worker-launcher | 280 | 280 | 281 | 114 |
| **worker tree** | **2 406** | **1 535** | 2 409 | **1 620** |

Read the third column beside the second: the warm pool spends almost exactly the gigabyte the W1
patch freed, and buys a burst that does not stagger for it. The fourth column takes most of that
back — a job process costs 130 MB bundled against 264 under `tsx`, and the `tsx` supervisors
disappear entirely.

**W1 under the bundle, which is the case that decides the patch**: 855 MB in the main process
without it, 115 MB with it. The audit had seen −772 MB under `tsx` but only −322 MB in bare CJS, and
the spec reserved the right to drop the patch if bundling made it moot. It does not.

**Job-process cold start**, importing the agent module exactly as `job_proc_lazy_main` does:
2 659 / 2 606 / 2 704 ms under `tsx`, **1 834 / 1 874 / 1 831 ms bundled** (−31 %). The remaining
1.8 s is `@livekit/agents` and its plugins loading from `node_modules`, and it stays there — the
framework resolves its job and inference entry points by URL at runtime.

**`pidusage` costs 336 ms per poll on Windows** (714 ms cold), and `supervised_proc` calls it for
every child every 5 seconds whether or not a memory limit is configured. With five job processes and
the inference process that is about 2 s of `wmic` spawning every 5 s — 40 % of a core, for nothing.
It is a dev-box tax, not a production one: `pidusage` reads `/proc` on Linux, which is where D6
deploys. Limits are now set (warn 400 MB, kill 800 MB) so the poll at least earns its cost.

### Tier 2 — N=5, real calls

Langfuse down for these, unlike the 2026-08-27 baseline; borrowers in their own process throughout.

| after | green | turn p50/p95 | call durations | worker cores | CPU s/call-min |
|---|---|---:|---|---:|---:|
| 2026-08-27 baseline | 5/5 | 2 984 / 5 045 ms | — | 1.378 | 9.32 |
| explicit load function, 1 warm slot ×2 | 5/5 | 2 072 / 2 166, 2 047 / 2 121 ms | spread 12.8 s, 14.6 s | — | — |
| 4 warm slots ×2 | 5/5 | 2 084 / 2 163, 2 134 / 2 410 ms | spread 3.9 s, 3.7 s | 1.484 / 1.487 | 11.71 / 11.66 |
| bundled | 5/5 | 2 061 / 2 343 ms | spread 2.6 s | **1.279** | **10.19** |

**The warm pool is visible as a staircase collapsing.** With one warm slot the five calls finished
89.5 / 92.1 / 95.2 / 99.2 / 102.3 seconds in — about 3.2 s apart, which is a cold job process
starting inside each call, serialised behind the pool's init mutex. With four, the spread falls from
12.8 s to 3.9 s. Per-turn latency does not move and should not: the cold start was never in a turn,
it was in front of the call.

**Load shedding, probed deliberately** (`2026-08-28-tier2-shed-probe-maxjobs1.json`). Three calls
started together against `WORKER_MAX_JOBS=1`: one admitted, two refused at the worker, and both
refused calls finalized `FAILED` with reason **`NEVER_SERVED`** about 38 seconds later. The same
three against `WORKER_MAX_JOBS=2` with no admission control were **all served** — the load function
shapes what the SFU believes and it is republished only every 2.5 s, so a burst inside one interval
is routed against a stale status. The threshold is a routing hint; the ceiling has to be enforced
where the answer is given.

## Tier 1 — control plane, 2026-08-27 (Phase 0 baselines)

Taken on a quiet box before any optimisation of this spec had landed, with the voice worker stopped
and only Postgres and the SFU up. These are the "before" every later commit is measured against; the
2026-08-21 numbers below stand as the record of what the same harness said in August.

| run | correct | turns/s | turn p50/p95/p99 | server CPU s | cores | CPU s/turn | pg peak CPU |
|---|---|---:|---|---:|---:|---:|---:|
| C=100 (cold) | 100/100 | 70.5 | 713 / 875 / 909 | 6.3 | 0.99 | **0.0218** | 62 % |
| C=100 (run 2) | 100/100 | 79.3 | 527 / 724 / 758 | 4.4 | 0.80 | 0.0148 | 45 % |
| C=100 (run 3) | 100/100 | 83.8 | 473 / 643 / 661 | 4.2 | 0.75 | 0.0139 | 39 % |
| C=100 (run 4) | 100/100 | 84.3 | 456 / 630 / 657 | 4.4 | 0.79 | 0.0145 | 85 % |
| C=100 (run 5) | 100/100 | 84.2 | 435 / 633 / 670 | 4.1 | 0.74 | 0.0136 | 38 % |
| soak 30/s × 300 s | 3000/3000 | 30.0 | 37 / 53 / 69 | 134.0 | 0.50 | 0.0149 | 56 % |

Closed-loop C=100 finishes in about four seconds, so its `cores` figure is over the whole window and
the report says so. Tier-1's `cores` column keeps its values where the tier-2 table below drops
them: the windowing bug described there only loses CPU for a process that exits before a window's
closing tick, and the control-plane tree has no such process — the server and its launchers are
alive in every tick of every run, so the fixed and unfixed arithmetic agree exactly on these rows. **The warm C=100 baseline is ~84 turns/s at 0.0142 CPU-seconds per turn**; the
cold run is listed because discarding it silently would be the more flattering choice.

**The soak is the only run that can see growth, and it sees some.** Nine thousand turns at a
sustained 30/s, all three thousand conversations replaying to the reference outcome, and the server
tree climbing **+3.1 MB/min of private commit**. Four soak runs on this box read 3.92, 3.60, 3.70 and
3.08 MB/min — a trend, not a reading. Only the last is committed here (`2026-08-27-tier1-soak-r30-d300.json`,
the one taken with the final instrument); the other three were overwritten by the date-stamped
filename they share, which is O16's hazard landing on the person who wrote it down. That growth is
C1's `TurnRunner` retention map and whatever else grows with turns, and a seven-second closed-loop
burst cannot see it at all.

**Postgres works considerably harder than the audit suggested.** The findings put it at "≤ 2.7 % CPU"
at C=50; at C=100 it peaks between 38 % and 85 % of a core, and holds 34 % mean through the soak.
It is still not the constraint — zero lock waits, four active backends — but D5b has something real
to measure.

The control-plane tree idles at **326 MB RSS / 470 MB private**, of which the two pnpm launchers and
the `tsx` supervisor are **170 MB RSS / 277 MB private on their own** — pure launcher overhead that
the D6 bundle removes.

## Tier 1 — control plane, 2026-08-21

Laptop (Windows 11, Node 22), one `apps/server` process, Postgres 16 in Docker, `TURN_DECIDER=scripted`.
Each conversation drives 3 turns to a `PROMISE_TO_PAY`, so C conversations = 3C streaming turns
through the full three-phase turn (T1 claim → decide → T2 commit) and the ledger.

| C | correct | turns/s | start p50/p95/p99 | TTFT p50/p95/p99 | turn p50/p95/p99 | pg at peak |
|---:|---|---:|---|---|---|---|
| 10 | 10/10 | 14.7\* | 40 / 145 / 145 | 19 / 27 / 33 | 55 / 103 / 153 | 3 backends, 2 active |
| 50 | 50/50 | 69.6 | 66 / 91 / 99 | 36 / 51 / 90 | 90 / 141 / 157 | 11 backends, 3 active |
| 100 | 100/100 | 78.0 | 239 / 411 / 421 | 252 / 381 / 393 | 534 / 747 / 776 | 11 backends, 4 active |
| 200 | 200/200 | 83.5 | 579 / 894 / 910 | 788 / 881 / 889 | 1586 / 1694 / 1722 | 11 backends, 6 active |
| 200 (`DB_MAX_CONNECTIONS=40`) | 200/200 | 78.2 | 651 / 1016 / 1037 | 884 / 982 / 1005 | 1825 / 2029 / 2103 | 30 backends, 7 active, **22 idle-in-tx** |

All times in milliseconds. \* C=10 finishes inside its own 2 s ramp, so its throughput is ramp-bound,
not a capacity measurement.

**Zero incorrect outcomes at every level, including C=200.** No 409s, no 429s, no failed starts, no
pool-exhaustion errors, and `pg_stat_activity` never showed a lock wait. That is the claim the
architecture makes — concurrency correctness lives in Postgres (row locks, `active_turn_id` CAS,
`SKIP LOCKED`), so adding load queues work rather than corrupting it.

**The knee is between C=50 and C=100.** Throughput saturates at roughly 70–85 turns/s and stops
improving; past the knee, added concurrency converts one-for-one into latency (turn p50 90 ms → 534 ms
→ 1586 ms while throughput moves 70 → 78 → 84/s). That is textbook queueing at a fixed service rate.
Run-to-run variance on an interactive laptop is roughly ±10%, so read these as shapes, not benchmarks.

**What saturates is the single Node process, not Postgres.** The obvious suspect was the connection
pool, so it was raised from 10 to 40 as a deliberate experiment — and the run got *slower*
(83.5 → 78.2 turns/s, turn p50 1586 → 1825 ms). At peak the DB had 30 backends but only **7 active**
and **22 idle in transaction**: connections sitting open inside a transaction while the event loop is
busy elsewhere. More pool means more half-open transactions, not more work done.
`DB_MAX_CONNECTIONS=10` stays the default; the scaling lever is a second server process, not a
bigger pool.

## Tier 2 — voice fleet, 2026-08-28 (Phase 0 baselines, borrowers isolated)

Self-hosted LiveKit, Deepgram STT + TTS, `TURN_DECIDER=openai`, judge off, **the Langfuse stack up**,
worker in `start` mode, browsers closed, borrowers in their own forked process, the worker allowed to
settle back to one warm job slot between runs. These are the "before" for every worker change in the
efficiency spec. (Local time had just gone past midnight; the report files are UTC-dated, so they are
`2026-08-27-tier2-n{1,2,5}.json`.)

| N | equivalence | WER p50/p95 | silent | TTS TTFB p50/p95 | turn latency p50/p95 | worker CPU s | MB/call (rss / private) | CPU s per call-minute |
|---:|---|---|---:|---|---|---:|---|---:|
| 1 | **1/1** | 0.000 / 0.111 | 0/3 | 394 / 401 ms | 2987 / 5675 ms | 14.3 | 318 / 309 | 10.2 |
| 2 | **2/2** | 0.000 / 0.000 | 0/6 | 426 / 453 ms | 3142 / 4440 ms | 32.4 | 305 / 290 | 11.0 |
| 5 | **5/5** | 0.000 / 0.111 | 0/15 | 381 / 419 ms | 2984 / 5045 ms | 90.9 | 312 / 298 | 9.3 |

**`cores_used` and `calls_per_vcpu` are deliberately absent from that table, and the artefacts'
values for them should not be quoted.** A review of the steady-state window found that it read each
process's CPU from the window's *closing* tick, and `cpuByPid` is rebuilt from `Get-Process` every
tick — so a job process that finished its call before that tick was absent, and counted as zero.
In a fleet run that is the ordinary case, and the error ran in the flattering direction: less CPU
counted, so fewer cores, so more calls per vCPU. The fix (forward-filling each process's cumulative
spend, so it keeps what it spent after it exits) is in `resources.ts` with tests for exactly that
case, but **these three runs predate it** and the two figures have not been re-measured. Everything
else in the row is unaffected: the whole-run CPU totals were always correct, which is why worker
CPU-seconds, MB per call and CPU-seconds per call-minute stand. The figures land with the D9
acceptance run, which is where the spec puts the per-core budget anyway.

**N=5 is green again, and the difference was the box.** The 2026-08-27 section below records N=5
failing at 3/5 with a WER of 1.000 and every local stage 3–5× slower, and concludes the cause was CPU
and memory starvation rather than a regression. Nothing in the pipeline changed between then and
this run. What changed is that 7.35 GB of browser was closed and the harness's borrowers moved out of
the measuring process — and N=5 came back 5/5 twice, with WER, silent playouts and TTS first-byte all
at their single-call values, and the observability stack up. That is the diagnosis confirmed rather
than argued.

**The worker's idle floor is ~2.5 GB of private commit before a single call.** Main process
1 023 MB, shared inference process 1 013 MB, one warm job slot 198 MB, 280 MB of pnpm/`tsx` launcher
(`2026-08-27-idle-tree-start-mode-baseline.json`, 90 idle seconds in `start` mode with the stack up).
Quoted in private commit rather than RSS because that sample was taken after the worker had been
sitting still long enough for Windows to trim its working set to 871 MB — the same tree, freshly
warm, reads 2 459 MB resident. The main process's gigabyte is W1: it `require`s the 69 MB inference
addon purely to check that it exists, and never runs inference. Every memory number in D4 is measured
against this row.

**A call costs about 300 MB and roughly 10 CPU-seconds per minute carried.**
`cpu_seconds_per_call_minute` is the stable figure across all three runs (10.2 / 11.0 / 9.3) and
`mb_per_call` barely moves either (318 / 305 / 312 RSS, 309 / 290 / 298 private). Both are ratios
against work done rather than wall clock, which is why neither is touched by the windowing bug
above.

**At N=5 the worker is close to its limit in `start` mode.** An earlier N=5 attempt, run immediately after N=1 and N=2 with no settle,
came back **4/5**: the fifth call got zero audio frames and all three of its turns went unanswered,
because production mode sheds load on a five-second CPU average and refused the job. Nothing was
broken — that is W2 working as designed — but it is nondeterministic on a shared laptop, which is
exactly why D4 replaces the default `loadFunc` with an explicit `activeJobs / WORKER_MAX_JOBS`.

**The harness is a quarter of the machine, which is why it now runs somewhere else.** At N=5 the
borrower process burned 31.5 CPU-seconds against the worker tree's 90.9 — 26 % of the total, on the
same laptop, previously inside the same process as the code reporting the worker's latency (findings
W8). It is still competing for CPU; the difference is that the report now says by how much.
`borrower-proc.ts` already speaks a JSON request/response contract over IPC, so moving it to another
box (`--remote-borrower`) is a transport change, not a rewrite. `--in-proc` restores the old
single-process shape for a quick one-off.

**Postgres is no longer a footnote.** 164 % of a core at peak during the N=5 run, on five concurrent
calls. It was not the constraint at C=50 in August and it is not the constraint now, but D5b's
`pg_stat_statements` work has something real to measure.

### One number in this table was recomputed, not re-run

The N=2 turn-latency p50 above reads 3142 ms; the artefact's own summary field says 3172. The fleet
harness had its own copy of the percentile rule with the same off-by-one the SLO gate had (O1), and
the two rules differ only where `p × n / 100` lands on an exact integer — which for these samples is
n=6 at p50 and nothing else. N=1 and N=5 are identical under both rules, as is every WER figure.
The corrected value was computed from the per-turn data the artefact already carries
(`results[].turn_latencies[].ms`), so it is a re-reading of the same run rather than a claim about a
run nobody can check.

### A caveat on the RSS slope in a fleet report

The leak detector is meaningful for the soak and meaningless for a voice run: a fleet report shows
hundreds of MB/min at N=5 because five job processes are *born* during the window and each grows to
around 350 MB. That is the calls, not a leak. The slope answers "does a steady state drift"; a fleet
run has no steady state.

### Three measurement disciplines, learned the hard way

Each of these produced a wrong number before it produced a rule.

- **Do not run anything else on the box during a measurement.** The first soak attempt reported a
  `worker-launcher` row using 129 MB and 0.8 CPU-seconds on a box where **no worker was running**: a
  `pnpm --filter @feather-lite/voice-worker typecheck`, in another terminal, matched the launcher
  pattern. The classifier now matches the script name rather than the package name anywhere in the
  command line, and the slope is taken over the roles under test rather than every role, so the
  harness's own arrival and departure inside a window cannot read as a leak.
- **Let the worker settle between fleet runs.** Three runs back to back put the previous run's job
  processes inside the next run's idle tick and reported `MB/call 3`.
- **Discard the first tier-1 run after a server restart.** It costs about 50 % more CPU per turn than
  the four that follow it.

## Tier 2 — voice fleet, 2026-08-27 (re-measured with the quality layer)

Same harness, same box, now reporting WER and TTS heuristics. **The headline is that N=5 did not
reproduce its August result on this machine, and the cause is the machine.**

| N | equivalence green | WER p50 / p95 | silent playouts | TTS TTFB p50/p95 | turn latency p50/p95 |
|---:|---|---|---|---|---|
| 2 | **2/2** | 0.000 / 0.111 | 0 / 6 | 430 / 459 ms | 3345 / 5490 ms |
| 5 | 3/5 (also 4/5, 3/5 on two earlier attempts) | 0.000 / **1.000** — gate FAILED | 1 / 13 | 398 / 2394 ms | 3049 / 18449 ms |

The N=5 turn-latency figures are the ones in `2026-08-26-tier2-n5.json`. This row previously read
`7170 / 18211 ms`, which matched no committed artefact: the fleet writes `${date}-tier2-n${N}.json`,
so a same-day re-run silently overwrote the report the row had been read from (O16). Three attempts
were made that day and only the last one's JSON survives. The two earlier equivalence counts are
kept above because they were recorded in prose at the time; their latencies are gone and are not
reconstructed here. **Date-stamped-only filenames are the hazard** — the fix on the reader's side is
to copy a committed baseline aside before re-running, which the ground rules now say.

**The diagnosis, in one number.** Every stage that runs *locally* degraded by 3–5× against the
August baseline — end-of-utterance 578 → 2767 ms, decide TTFT ~1100 → 3372 ms — while the one stage
that is purely a remote round trip was **unchanged** (TTS first byte 398–430 ms, comfortably inside
its 600 ms target). No code regression produces that shape; CPU and memory starvation does. The box
had ~2.6 GB free RAM, with Docker's WSL VM holding 3.5 GB for the observability stack and a browser
resident. A single call (`fake-borrower`) passed equivalence with WER 0.000/0.111 throughout, and
N=2 is clean on every metric, so the pipeline is correct and the concurrency ceiling — documented at
N=10 in August — has simply moved below 5 under today's resident load.

**Both N=5 failure modes are the safety guards working, not correctness bugs.** One call lost its
`CONFIRMING_OUTCOME` read-back to a zero-audio TTS stream; the fully-heard guard refused to record
the promise the borrower had just "confirmed" (`TOOL_REJECTED … read-back was interrupted;
repeating it`), the agent repeated itself, and the call ended FAILED rather than recording a promise
against silence. That is ADR 0008's failure mode, caught. Others lost the final confirmation
utterance to STT entirely — an empty transcript, WER 1.000 — which is what took the run over the
WER gate.

**The WER gate fired for the first time on real data, and it was right to.** Two of fifteen borrower
lines came back as empty transcripts. Without the gate the run would have reported "3/5 equivalence"
and left the transcription collapse invisible; with it, the run fails and names the reason.

Re-running N=5 on a quiet box is the outstanding measurement. The August result below stands as the
last clean one.

## Tier 2 — voice fleet, 2026-08-21

N concurrent real calls: self-hosted LiveKit (`pnpm lk:up`), Deepgram STT + Cartesia TTS via
`STT_TTS_PROVIDER=plugins`, a headless speaking borrower per call, each asserted for SPEC §10.5
equivalence. Borrower lines are synthesised once and replayed from a WAV cache, so a 10-call run
pays for 3 utterances, not 30.

| N | equivalence green | agent hung up | call duration p50 / p95 | notes |
|---:|---|---|---|---|
| 2 | 2/2 | 2/2 | 52.2 s / 52.2 s | clean |
| 5 | **5/5** | 5/5 | 60.9 s / 114.0 s | acceptance level; 1 call exceeded the 60 s "agent started speaking" wait |
| 10 | 9/10 (10/10 on an earlier run) | 10/10 | 90.3 s / 175.3 s | stretch level; **at the CPU ceiling, not reliably green** |

**N=5 is green and repeatable — that is the acceptance bar, and it is met.** N=10 was measured twice:
once 10/10, once 9/10. Ten simultaneous calls saturate this laptop (10× silero VAD + turn detector +
Opus encode in one worker process), and the median call stretches to ~90 s against ~50 s solo. The
media server and the control plane are not the constraint; the CPU is.

**The one N=10 failure is the safety guard working, not a correctness bug.** Worth reading closely,
because it is the most interesting event in the whole run. Conversation `485d5687…` produced the
right state path and the right tool sequence, then ended `NO_ANSWER` instead of `PROMISE_TO_PAY`:

```
19 USER_TURN_FINAL
20 TOOL_CALLED    record_promise_to_pay
21 TOOL_REJECTED  record_promise_to_pay  reason=INVALID_ARGS
22 AGENT_TURN     (repeat the read-back)
24 NO_INPUT       count=2
25 CALL_CONTROL   NO_INPUT_CLOSE
```

Under CPU starvation the promise read-back was not fully played out, so the fully-heard guard
(ADR 0003 — a promise is only recordable if the borrower actually heard the read-back) **refused to
record it**. The agent repeated the read-back, the borrower's audio never landed in time, two
no-input strikes closed the attempt, and the ledger says `NO_ANSWER` — which is exactly what
happened. Equivalence with the simulation is lost, but the system failed in the safe direction: a
degraded call produces no promise rather than an unconfirmed one. A harness that only counted
"did it finish" would have scored this a pass.
