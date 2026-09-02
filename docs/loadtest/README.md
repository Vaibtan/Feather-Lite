# Load test results

Raw reports are the JSON files beside this one; this page is the reading of them. Re-run with:

```bash
pnpm loadtest:tier1 -- --concurrency 100 --ramp 2      # control plane, closed loop (heavy)
pnpm loadtest:tier1 -- --rate 30 --duration 300        # control plane, open-loop soak
pnpm loadtest:tier2 -- --calls 5 --label n5-baseline   # real voice calls (modest)
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
  regression. Since 2026-09-01 it does not have to: `RATE_LIMIT_BYPASS_TOKEN`, set on the server and
  on the harness, exempts the run and is counted as `rate_limit_bypassed` on the status page (O9).
  Raising the two budgets for a run is no longer the advice — that measured a server configured
  differently from the one being described.
- **`JUDGE_ENABLED=false`.** A C=50 run would otherwise enqueue fifty reasoning-model calls.

## 2026-09-02 — N=5 on the Phase C tree, and the interruption mode that was never running

Not a re-baseline: this is the run Phase C's own verifications needed, taken on the corrected
control plane and worker. `2026-09-02-tier2-n5.json`.

Box: `pnpm stack:quiet` green (11 GB free in the container VM), Langfuse down, `JUDGE_ENABLED=false`,
`LANGFUSE_ENABLED=false`, `TURN_DECIDER=openai`, `RATE_LIMIT_BYPASS_TOKEN` on both sides,
`WORKER_MAX_JOBS=14`, `LIVEKIT_NODE_IP=192.168.1.4`. Everything in containers except the borrower
harness, which Phase D moves.

| | 2026-09-01 N=5 | **2026-09-02 N=5 (Phase C)** |
|---|---:|---:|
| calls served | 5/5 | **5/5** |
| equivalence | 5/5 | **5/5 green** |
| STT WER p50 / p95 | 0.000 / 0.000 | 0.000 / 0.111 (gate 0.20) |
| silent playouts | 0 of 15 | **0 of 15** |
| turn latency p50 / p95 (harness) | 3 115 / 4 501 ms | 3 019 / 5 672 ms |
| TTS TTFB p50 / p95 | 391 / 417 ms | **392 / 413 ms** |
| worker container peak | 2 018–2 095 MB | 2 027 MB |
| MB per call | ~240 | 253 |

`/api/system/latency?calls=5` on the same 15 turns: `eou_delay_ms` 578 / 580, `transcription_delay_ms`
461 / 514, `ttft_ms` 1 070 / 3 651, `tts_ttfb_ms` 392 / 413, `total_ms` 2 460 / 5 061.

**Nothing in Phase C moved a number**, which is the point of running it: fifteen commits of
correctness work — the read-back guard, the claim lease, the SIP re-dial, the turn attach, the
shutdown release — and the waterfall is where it was. The p95 tail is wider than 2026-09-01's
(5 672 vs 4 501 ms) and it is `ttft_ms` that carries it, at 3 651 p95 against 1 070 p50: OpenAI's
tail, which ADR 0008 records as varying 0.8–4.6 s on identical prompts and not ours to control.

### The interruption mode (W1), verified on live calls

The finding was that `interruption: { mode: "adaptive" }` had **never run** here: adaptive detection
is LiveKit's hosted model, the self-hosted profile has no credentials for it, and every job logged
`adaptive interruption disabled due to unrecoverable error, falling back to VAD-based interruption`
before running on VAD anyway.

**Measured on this run: 5 jobs started, 0 fallback lines.** Before the change every job logged one.
The session now asks for `vad`, which is what it was always getting — so the config and the
behaviour agree for the first time, and Phase 1's turn-taking baseline can be labelled honestly.

### W2 — the TTS numbers were the last sentence's, and now they are the turn's

Re-run on the same box within the hour, worker rebuilt, nothing else changed.

| | before (per segment) | **after (per turn)** |
|---|---:|---:|
| `tts_ttfb_ms` p50 / p95 (harness) | 392 / 413 ms | **375 / 456 ms** |
| `tts_ttfb_ms` p50 / p95 (ledger) | 392 / 413 ms | **375 / 456 ms** |
| chars/s median | 12.8 | 12.8 |
| **chars/s turns beyond ±40 %** | **5 of 15** | **0 of 15** |
| equivalence | 5/5 | 5/5 |
| STT WER p50 / p95 | 0.000 / 0.111 | 0.000 / 0.111 |
| silent playouts | 0 of 15 | 0 of 15 |

**The chars-per-second line is the finding, not the TTFB.** `tts/tts.js` emits one
`metrics_collected` per synthesised segment and resets its accumulators between them, so a turn
split into three sentences raised three events and the last one won. `tts_chars` was therefore one
sentence's length and `tts_audio_ms` one sentence's audio — and the ratio of two quantities from the
same sentence looks fine until you compare it against a median taken over turns of different shapes.
Before the change, **five of fifteen turns** read as outliers at +74 % to +76 %. After it, **none**
do, from the same five calls speaking the same script. The heuristic was measuring how the framework
had chosen to split the sentences.

`tts_ttfb_ms` p50 moves 392 → 375 ms because the turn's first byte is by definition no later than
its last segment's, and p95 widens 413 → 456 ms for the same reason — the first segment carries
whatever the stream's initial connect cost, which the later segments never see. Both numbers now
mean "when the borrower first heard this turn", which is what a latency waterfall is for and what
the N=10 table's 385 ms was not.

Turn latency p50/p95 3 009 / 3 313 ms and `total_ms` 2 405 / 2 746 ms on this run; the tail is
calmer than the previous hour's (`ttft_ms` p95 1 236 against 3 651), which is OpenAI's variance and
not this change.

## 2026-09-02 — D1 `resume` fires, and its gate is measured and NOT met: p50 378 ms against < 300 ms

Four blocking links, all found by running it and all now fixed. The gate has a number for the first
time, and the number does not pass.

| # | link | what was wrong | fixed by |
|---|---|---|---|
| 1 | the harness speaks a backchannel | — | — |
| 2 | the transcriber emits it | Deepgram filters fillers: **WER 1.000, 0 finals** on the "Mm-hm." line while every other line scored 0 | `WORKER_STT_FILLER_WORDS=true` |
| 3 | it arrives as its own utterance | the endpointer merged it: `"Mhmm. Actually,"` as one final, which carries content | 3 500 ms gap in the scenario |
| 4 | the lexicon recognises it | Deepgram writes **"Mhmm."**; the lexicon had `mhm`, `mmhm`, `mm` — not `mhmm` | the transcriber's own spellings, with a table |
| 5 | the classifier sees it at all | **a backchannel produces no interim** — six interims in a run, none of them the backchannel; it is too short to publish before it closes | read the **final** too (deviation from D1, below) |

### The deviation from D1, and why

D1 says `resume` runs "on the interim transcript". Measured, that cannot work: `"Mhmm."` reaches the
ledger as a **final** with no interim event ever emitted for it. A classifier that only reads interims
cannot see the one kind of utterance it exists for.

The intent of "interim" is *do not wait for the turn to be settled*, and that intent is kept: reading
the final as it arrives still beats the 2 000 ms false-interruption timeout by more than a second.
`pausedSpeech` remains the guard either way — if nothing is paused there is nothing to resume, so a
final arriving after a real interruption does nothing.

### The gate

```
resumed on backchannel {"transcript":"Mhmm.","pausedForMs":402}
```

Four measurements: **147, 354, 402, 463 ms → p50 378 ms**. The gate is **< 300 ms**, so it is **not
met**. Against the 2 000 ms timeout it replaces this is a ~5× improvement, and it is still short of
what D1 asks for.

The remaining latency is **Deepgram's finalisation time for a very short utterance** — the price of
reading the final, which link 5 shows is the only thing there is to read. Closing the last ~80 ms is
an STT-configuration question (endpointing/utterance-end settings), not a classifier one.

**The first version of this number was wrong and worth recording as a lesson.** It read
`pausedForMs: 0` on every resume, because the clock was started in the same handler that stopped it.
It is now measured from `agent_state_changed` leaving `"speaking"` — when the borrower actually
starts hearing silence, which is what the gate is about. A resume whose pause was never observed
reports nothing rather than zero.

## 2026-09-02 — (superseded) D1 `resume`: the chain, link by link

**This supersedes the section below it, which was written on an inference that later evidence
refined.** That section concluded "the SDK never pauses on this configuration". The stronger reading
of the same data is narrower and is in the table here: `pausedSpeech` was observed false on eight
interims, but **all eight were the borrower's own turns**, when the agent was not speaking and there
was correctly nothing to pause. The one case that matters — an interim *during* an agent line — never
occurred, for a reason two links upstream.

`resume` needs five things in a row. Running it found the first two broken:

| # | link | status |
|---|---|---|
| 1 | the harness speaks a backchannel | ✅ |
| 2 | the transcriber emits a **final/interim** for it | ✅ **fixed** — see below |
| 3 | the lexicon recognises what the transcriber actually wrote | ✅ **fixed** — see below |
| 4 | a speech is paused when that interim arrives | ❓ **unverified** |
| 5 | the resume fires | ❌ 0 in every run |

### Link 2 — Deepgram filters backchannels by default

The plugin defaults `fillerWords: false`, which is Deepgram's `filler_words=false`. The effect,
measured across three tier-3 backchannel runs: the `"Mm-hm."` line scores **WER 1.000 with 0
finals**, while every other line in the same calls scores **0**. D1's classifier runs on the interim
transcript of exactly that utterance, so with fillers filtered it has no input and can never fire.

With `WORKER_STT_FILLER_WORDS=true` the same line produces **1 final**. Off by default, because it
changes what every transcript contains and therefore what the word-error gate measures.

### Link 3 — the transcriber's spelling was not in the lexicon

With fillers on, Deepgram returned **`"Mhmm."`**. The lexicon had `mhm`, `mmhm` and `mm`, but not
`mhmm`, so it classified the one utterance the whole mechanism exists for as speech. The lexicon is
data precisely so that a miss like this is a one-line fix with a test beside it; the transcriber's
own spellings now have their own table.

The same run also showed the endpointer merging the backchannel into the next line —
`"Mhmm. Actually,"` as a single final, which carries content and is correctly not a backchannel. The
scenario now leaves 3 500 ms after the backchannel instead of 1 500. This is the third time an STT
merge has broken a tier-3 scenario, after the hold request and the read-back.

### Link 4 — still unverified, and honestly so

After both fixes, `resumed on backchannel` is still **0**, and truncation on seed 3 fell from 2 lines
to 1 — suggestive, and **not** evidence of a resume. Whether a speech is actually paused at the
moment the backchannel interim arrives has never been observed either way: the one instrumented run
that could have answered it collapsed for unrelated reasons. That measurement is the next step, and
it is a single log line on a healthy box.

So the gate — "false-interrupt resume p50 < 300 ms" — remains **unmeasurable rather than unmet**,
with two of its four blocking links now fixed and the third identified.

## 2026-09-02 — (superseded) D1 `resume` is built, and it cannot fire

D5.2 decided `resume` was needed, so it was built: `backchannel()` in `domain` (34 table tests),
`resume-backchannel.ts` in the worker (7 tests), and the wiring on the interim transcript, reporting
`resumed_ms` on the next `turn_metrics` so the ledger can tell a false interruption the system
recovered from apart from a real one it did not.

**It never fires, and the reason is in the SDK rather than in the code above.**

Measured on a healthy run, logging every interim: `resumed on backchannel` appears **0** times, and
across eight interims `_activity` is reachable, `startFalseInterruptionTimer` is a function, and
`pausedSpeech` is **undefined every single time**.

Read in the installed 1.6.4 rather than assumed (`voice/agent_activity.js`):

- The pause happens in `onStartOfSpeech`, guarded by
  `agentSession.agentState !== "speaking" && pauseEnabled() && ... allowInterruptions` (line 1079).
- `startFalseInterruptionTimer` is only called `if (this.pausedSpeech)` (line 1105).
- `pauseEnabled()` additionally requires `output.audio.canPause` (line 3471), and the SDK logs
  *"resumeFalseInterruption is enabled but audio output does not support pause, it will be ignored"*
  when that fails. **That warning is absent from our logs**, so `canPause` is not the blocker.

So on this configuration the barge-in never pauses the agent's audio — it cuts the line outright —
and the SDK's resume path, which D1 says to reach ("resumes the paused speech immediately through
the SDK's existing resume path"), has nothing to resume.

**The gate is therefore unmeasurable rather than unmet.** "False-interrupt resume p50 < 300 ms"
cannot be computed when the count of resumes is structurally zero. The lexicon and wiring stay: they
are correct, they are inert, and they fire the moment pausing engages — which is the next piece of
work, and it is an SDK-behaviour question (why `agentState` is `"speaking"` at
`onStartOfSpeech`, and whether the interruption path should be pausing at all under
`mode: "vad"`), not a lexicon one.

## 2026-09-02 — Phase 2: two read-backs become one, and D5.2 decides `resume` is needed

Deepgram came back (it had been unreachable — `curl` timing out at 15 s from the host, every TTS
synthesis exhausting its retries), so Phase F's owed run and Phase 2's own gates could all be run.

### Phase F's owed N=5 equivalence — passed

`2026-09-02-tier2-n5-phase-f-owed.json`: **5/5 equivalent**, 5/5 hung up, 0 never served, **0/15
silent playouts**, WER p50/p95 **0.000 / 0.1111** against the 0.2 gate, turn latency p50/p95
2 943 / 3 825 ms, `agent_stretch_disagreements: []`.

### D1 `wait` — the borrower asks for a moment and the agent says nothing

Verified on a real voice call, from the ledger rather than from the silence:

```
Yes. This is Jordan.                 -> respond
Hold on. Let me get my card.         -> wait,  extendAwayMs 15000
Actually, wait. I can pay $550 ...   -> respond
Yes. That's correct.                 -> respond          outcome PROMISE_TO_PAY
```

Two defects in getting there, both found by running it. The scenario's assertion **passed vacuously**
on `["respond","respond","respond"]` — the edit adding the expectation had not landed — and there is
now a unit test that the check fails on all-`respond`. And the scenario never produced a hold at all:
spoken back-to-back, the STT merges the confirmation and the hold into `"Yes. This is Jordan. Hold
on. Let me get my card."`, one final that carries content and is therefore correctly *not* a hold.

### D1 `held` — the read-back stops repeating

The read-back is now `allowInterruptions: false`, so F2's `held` can park a turn that arrives during
it. Same seed, same scenario, the whole point of tier 3:

| | read-backs | outcome |
|---|---:|---|
| before | **2** | PROMISE_TO_PAY |
| after | **1** | PROMISE_TO_PAY |

`yes-during-read-back` flipped from `readBacks: { atLeast: 2 }` to `{ atMost: 1 }`, which the scenario
said from the day it was written would be Phase 2's verification.

**Open, and the remaining half of D1:** words spoken *into* a non-interruptible segment are dropped at
the worker rather than deferred to the control plane as Q4 intends — the early "yes" produced no
`USER_TURN_FINAL` at all. `held` is protecting the read-back by suppression rather than deferral. A
borrower who is talked over simply repeats themselves, and that now works first time
(`clean-happy-path` green), but it is not what the design says.

### D5.2 — and it decides `resume` **is** needed

The spec makes this measurement the gate on building the interim backchannel classifier: *"if raising
`interruption.minDuration` to ~700 ms removes most backchannel pauses on the simulator's backchannel
scenario, the interim classifier is not built."*

| `minDuration` | seed 3 | seed 11 | outcome |
|---|---:|---:|---|
| **500 ms** (SDK default) | 3 lines cut | 2 lines cut | null / NO_ANSWER |
| **700 ms** | 4 lines cut | 2 lines cut | PROMISE_TO_PAY / PROMISE_TO_PAY |

**It does not remove them.** So the knob is not the fix and `resume` is owed. N=2 per arm and the
calls are real, so treat the counts as an order of magnitude, not a rate — but the direction is not
ambiguous: 700 ms cut as many lines as 500 ms did. The knob stays at its default; the compose file
carries it so the arms are reproducible.

### The tripwire was lying, and running it is what showed that

`expectedToFail` excused **every** failure rather than the one it names. A broken worker produced
`NO_ANSWER` with no tools at all and the run reported *"failed as expected"* and exited 0. A
known-red scenario that goes green on a broken box is worse than no scenario. The mark now carries a
`matches` pattern and any other failure fails the run — which it immediately did, on the A arm above.

### Environment: recreate the worker with **both** profiles

`docker compose --profile app up -d worker` leaves a worker that transcribes nothing — `0 final(s)`
on every line, WER 1.000 by deletion, no tools called, `NO_ANSWER`. Deepgram was reachable throughout
and the STT socket simply idled out for want of audio. `--profile app --profile livekit` recreates it
correctly. This cost two runs before the control (`clean-happy-path`) isolated it.

## 2026-09-02 — Phase F, and what wiring `held` in taught immediately

Phase F is six refactors D1/D2 need. Two of its six premises did not describe the tree, and both were
checked in source before acting rather than after:

- **F1 asked for one `Orchestrator` per process. There already is one.** Effect memoizes layers **by
  reference** within a build, and `Orchestrator.Default` is one layer value, so the three services
  listing it in `dependencies` and `ServicesLive`'s own `mergeAll` share the instance. Measured by
  instrumenting the constructor and building `ServicesLive` once: **1**. A comment in `Sweeper.ts`
  asserted the opposite; the comment was wrong, and no code needed changing.
- **F5 named four module-level mutable gauges. Two of them are not that.** The limiter is a
  module-level `const` singleton with a documented import-cycle reason, and the daily cap is a
  `Metrics` counter, not a gauge. Only `liveTurnCount` and `subscriberCount` were `export let`s, and
  only those moved to the `Gauges` service.

### `held` fired on the opening, and running it was the only way to find out

F2 puts a `held` phase before T1: wait for a non-interruptible agent segment to finish before
claiming a turn, so the borrower's "yes" during the read-back does not commit a turn the fully-heard
guard will refuse. The first live call after wiring it in:

```
  outcome NO_ANSWER, propose_promise_to_pay missing, 0 read-backs
  conversation_turns: heldMs 4257 on turn one; the payment offer SUPERSEDED
```

The opening is written `speak_mode: "non_interruptible"` with `turn_id: "opening"`, and the worker
reports it with the **`opening_played` signal — never an `AGENT_TURN_PLAYOUT`**. So it is permanently
unreported, and the first real turn of every voice call was held waiting for evidence that would
never arrive. The ledger query excludes it now, with a test that says why.

### `held` is dormant on today's tree, and that is the correct Phase F outcome

Every non-interruptible line today is a call-*closing* one — the confirmations, the closes, the
transfer hold. **The promise read-back is `allowInterruptions: true`**, so nothing mid-call triggers
the hold: three live tier-3 calls after the fix recorded no `heldMs` at all. Marking the read-back
non-interruptible is a behaviour change and belongs to D1 in Phase 2, which is what the mechanism was
built for.

### Phase F verification

`pnpm check` **280 domain / 101 control-plane / 94 voice-worker / 48 load-test**; `pnpm test:db`
**110 passed, 0 skipped** (100 before F); **20/20 scenarios** on real Postgres. The `Gauges` move was
checked on the running server rather than in types: after one streamed turn,
`feather_lite_live_turns` reads **1** where it read 0, so `TurnRunner` and `main.ts` share one
registry, and `/status` reports `"basis": "per process, since boot"`.

### Phase F's tier-2 N=5 equivalence run is OWED, not passed — Deepgram is unreachable

Attempted twice and **not completed**, and it is recorded as owed rather than explained away.

| run | equivalent | calls | silent playouts |
|---|---|---|---|
| `phase-f` | 3/5 | 127–177 s | — , WER p95 1.000 |
| `phase-f2` (fresh worker) | **0/5** | 208–258 s, none hung up | **9/9 (100 %)** |

The cause is external and it is unambiguous:

```
tts: deepgram.TTS  attempt 3  APITimeoutError: Deepgram TTS WebSocket connect timeout
$ curl --max-time 15 https://api.deepgram.com/     -> timed out at 15.009 s (from the Windows host)
```

Every synthesis attempt exhausts its retries, so every playout is silent and no call can complete.
`api.deepgram.com` does not answer from this machine at all.

**It is not Phase F.** Checked rather than assumed: across the 13 turns of the first run,
`count(*) FILTER (WHERE result ? 'heldMs')` is **0** — the `held` phase never fired, exactly as its
dormancy predicts. The one thing F2 does add to every turn is the ledger read, and that is
`Execution Time: 0.236 ms`, fully index-driven, against calls running four minutes.

What the same runs *did* verify live, on real voice calls through the real decider: **F3 and F4**.
`conversation_turns.result` reads `model|tool` × 11 and `model|spoke` × 2 — the arm that decided each
turn and how it ended, which is what F4's turn-level SLO predicate selects on.

This also blocks issue #1's Phase 2, whose D5.2 verification is an N=5 A/B on the same path.

### Open: the box stopped being quiet, and tier-3 runs stopped being usable

Three tier-3 calls late in the Phase F session failed with `no_input` hangups — `NO_ANSWER`, and in
one case no tools at all. **Not F2**: no turn recorded a `heldMs` in any of them. The worker was
starved — `tts_metrics ttfbMs 1997` against a ~375 ms baseline, host free memory down to **2 067 MB**
with Firefox reopened and holding ~1.5 GB. `stack:quiet` passed throughout, because it reads the
**container VM** (8 040 MB free), not the Windows host. That threshold is the third open item below,
and this is the second time it has mattered.

## How to start a stack you may quote numbers from (P4)

The load-run configuration is a **file** now, not something to remember:

```
docker compose --env-file .env --env-file compose.loadrun.env   --profile app --profile livekit up -d
```

Both files, in that order. `--env-file` **replaces** the default `.env` rather than adding to it, so
`compose.loadrun.env` alone brings the stack up with `OPENAI_API_KEY: ""` and no decider. Later files
win, so `.env` supplies the secrets and `compose.loadrun.env` pins the four values a run must not
inherit: `JUDGE_ENABLED=false`, `LANGFUSE_ENABLED=false`, `TURN_DECIDER=openai` and a
`RATE_LIMIT_BYPASS_TOKEN`. Both forms were checked with `docker compose ... config` before this was
written.

Why it matters: compose interpolates those from the repo `.env` unless they are in the shell at `up`
time, so a fleet run started in a fresh terminal quietly measured a server with the LLM judge on —
billing a reasoning-model call per conversation and putting its latency inside the window under
measurement. Tier 1's judge gate caught it once. It should not have to.

`pnpm stack:quiet` green and `pnpm lf:down` still come first.

## 2026-09-02 — tier 3, and the read-back defect reproduced on demand (issue #1 Phase 1)

Tier 3 is one seeded scenario, one call, and the ledger shape that call must leave. It is a
**composition, not a second harness** (issue #1, user story 29): `bootstrapRoom` and
`runScriptedCall` join the room and run a `BorrowerScript` (H9), the line cache synthesises the
persona (H9), the RMS detector keeps every sample (H1), `withPlayoutTruth` attaches the ledger's
playout truth (H11), `turnTakingMetrics` produces D4's six numbers, `makeRng` makes the stochastic
parts reproducible (H7). `sim-borrower.ts` wires those to a scenario table.

```
pnpm --filter @feather-lite/voice-worker sim-borrower -- --scenario yes-during-read-back --seed 7 --label onset
```

The report is `${date}-tier3-${scenario}-${label}.json` and it carries the **seed, the scenario, the
persona and the interruption mode**, because a tier-3 number without those four is not reproducible
and should not be quoted.

### Three scenarios run; two are declared and refused

`clean-happy-path`, `yes-during-read-back`, `backchannel-mid-line` and `hold-request` run today.
`third-party-pickup` and `accent-noise-ablation` need Phase 4's machinery (a second participant in
the room, the degradation chain), so they declare it in `needs` and the runner **exits 2 rather than
running one it cannot exercise** — a scenario that ran without its machinery would report a green it
did not earn. Declaring them now is the point of a table: the shapes are reviewable before the
machinery exists.

Each scenario also declares what it **runs but does not yet check**. D4 asks the backchannel scenario
for a recorded `resume` and the hold scenario for a `wait`; both are decisions issue #1's D1/D2
introduce and neither exists to assert against. That half is named in `notYetAsserted`, printed on
every run and carried in the report — a gate you think you passed is worse than one you know you
skipped.

### Every run on the final tree

| scenario | seed | outcome | read-backs | response | yield | yield_ms | excluded (H11) | exit |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| `clean-happy-path` | 1 | PROMISE_TO_PAY | 1 | 1 | 1 | 950 | 1 | **0** |
| `yes-during-read-back` | 7 | PROMISE_TO_PAY | **2** | 0.75 | 0.5 | 761 | 2 | **0** |
| `backchannel-mid-line` | 3 | PROMISE_TO_PAY | 1 | 0.75 | 1 | 739 | 1 | 0 (known-red) |
| `backchannel-mid-line` | 11 | PROMISE_TO_PAY | 1 | 0.75 | 1 | 682 | 1 | 0 (known-red) |
| `hold-request` | 3 | NO_ANSWER | 1 | 0.5 | n/a | n/a | 2 | 1 |

**These are VAD-interruption numbers** (amendment 8), and they are single calls — the N=5 medians
above remain the baseline.

### A known-red scenario is a tripwire, not a permanent failure

`backchannel-mid-line` asserts D4's clause verbatim — "expects no truncated agent line" — and the
current system truncates: VAD stops the agent for "mm-hm". Neither available option was acceptable.
Relaxing the expectation asserts the defect and has to be rewritten the day it is fixed; leaving the
run permanently red teaches a reader that red means nothing.

So a scenario may carry `expectedToFail: { reason, until }`. The expectation stays as D4 wrote it,
the run **passes while it fails for the stated reason**, and it **fails the moment it starts
passing** — which is the signal that the phase named in `until` landed. Truncation is read from
`AGENT_TURN_PLAYOUT.interrupted`, and **no playout rows fails** rather than passing for want of
evidence: that is the defect C1 fixed in the read-back guard, and a harness must not reintroduce it
one directory over.

**The tripwire earned its keep within the hour.** `hold-request` was marked known-red on a single
observation — one run ended `NO_ANSWER` at 161 s with the promise never recorded. The very next run
of the same seed passed cleanly and the runner refused it: *"passes now, and the scenario still says
it should not."* The mark came off. A scenario is known-red only when it is reliably red;
`backchannel-mid-line` was red on three runs across two seeds before it kept its mark.

### The defect reproduces, and the first attempt to reproduce it did not

### The defect reproduces, and the first attempt to reproduce it did not

`yes-during-read-back` asserts `readBacks: { atLeast: 2 }`, and it now gets two:

```
+63882ms agent said: "To confirm: you will pay 550 dollars"
+76319ms agent said: "Let me repeat that. To confirm: you will pay 550 dollars by Friday, ..."
```

The borrower's "yes" lands mid-read-back, is transcribed, commits a turn, is refused by the
fully-heard guard, and eight seconds of read-back play again — on the turn the borrower was most
ready to agree on. This is the shape of conversation `da3dcff9-…`, and it is what issue #1's D1
(`held`) exists to fix; Phase 2 flips `atMost` to 1 as its own verification.

**The first version of this scenario reported one read-back, and the fault was the scenario's.** It
waited for the read-back's *transcript* and then spoke. A transcript segment arrives when it
**closes** — i.e. once the agent has finished saying the line — so the "yes" was landing *after* the
read-back, which is an ordinary confirmation and reproduces nothing. Nothing was wrong with the
system; the harness was measuring a different act.

The fix is the seam H1 built for exactly this: `CallContext.waitNextStretchStart` returns the
**onset** of the agent's next stretch of speech. Onsets are the only thing that can say "the agent is
talking *now*". Same seed, same scenario, same tree, one changed line of timing — 1 read-back became
2. **Worth keeping: in a voice harness, the transcript is a lagging indicator and cannot be used to
time an interruption.**

### Three defects the tier-3 work exposed in code already committed

1. **`harness` was on the column and never on the wire.** Migration 0009 added
   `conversations.harness`, `Workflow.StartCallInput` accepted it and `latencyAggregateForSegment`
   filtered on it — but `POST /api/voice/sessions` had no such field, `VoiceSessions.create` had no
   such input, and `ConversationDetail` did not return it. Every simulator call was landing with
   `harness = null`, i.e. **inside** the window the product's latency claim is made from, which is
   the one thing the column exists to prevent. Wired end to end; the report now reads `"sim"` back,
   which is what proves the column was written.
2. **Tier 3 re-invented the command line H6 had already fixed.** Its first cut carried an ad hoc
   `flag()` helper with an optional `--label` defaulting to the scenario id — the exact collision
   that cost a tracked report earlier the same day — and silently ignored unknown flags. The scanner
   moved to `harness-args.ts`; `fleet-args.ts` and `sim-borrower.ts` now share it, each declaring
   only its own flags. (`shed-probe.ts` still has its own; it is next.)
3. **Tier 3 dialled the seeded demo borrower every run** and the sixth call of the day was refused
   with `FREQUENCY_CAP` — a real pre-call rule doing its job, and a harness that cannot be run twice
   is not a harness. It mints a throwaway fixture per run now, the way the fleet does;
   `TRACER_BORROWER` still overrides.

### Open: what a hold does to a call

`hold-request` ended `NO_ANSWER` on two of three runs (seed 3), at **156 s and 161 s** against a
clean path's ~99 s, with `confirm_right_party` and `propose_promise_to_pay` recorded but never
`record_promise_to_pay` — the promise the borrower offered is lost. The third run passed cleanly.
Not diagnosed, and deliberately **not** marked known-red on a 2-of-3 signal.

## 2026-09-02 — the first turn-taking numbers (issue #1 Phase 1)

D4's six metrics, computed from a real call for the first time. Every piece existed and none of them
had been joined: H1 keeps the agent's speech stretches, `withPlayoutTruth` attaches the ledger's
`AGENT_TURN_PLAYOUT.interrupted` to each, the script records what the borrower did and when, and
`turnTakingMetrics` turns the pair into numbers. This is the joining.

**These are VAD-interruption numbers, and the report says so** (issue #4, amendment 8). Adaptive
interruption has never run on this profile — W1 made the config admit it — so Phase 2's A/B has to
compare like with like.

`2026-09-02-tier2-n5-phase1-baseline.json`, 5/5 equivalent, WER p50/p95 0.000 / 0.000:

| metric | median over 5 calls |
|---|---:|
| `turn.response_rate` | 0.667 |
| `turn.yield_rate` | 0 |
| `turn.yield_latency_ms` | 999.5 |
| `turn.false_interrupt_rate` | n/a |
| `turn.agent_interrupt_rate` | 0.333 |
| `turn.selectivity` | n/a |
| stretches with no playout (excluded) | **8** |

**Read the last row before any of the others.** Eight of the run's agent speech stretches had no
playout report behind them, so they are `truncated: null` — excluded from every rate and counted
(H11). What is left is a thin denominator, and the rates move with it: an N=2 run an hour earlier, on
the same code, gave `response_rate` 1.0, `yield_rate` 1.0 and `agent_interrupt_rate` 0 with one or
two unknown stretches per call.

That is not a contradiction, it is the finding: **on the tier-2 script these six numbers are not yet
stable enough to be a baseline**, and the reason is legible rather than mysterious because the count
is reported. Two things narrow it, both in Phase 1's remaining work — the scenario tables supply
`truncated` per turn from `event_timeline` (amendment 7) rather than relying on a time join, and a
scenario knows which of its own events were backchannels, which is what gives
`false_interrupt_rate` and `selectivity` a denominator at all.

`turn.yield_latency_ms` is the number that is already meaningful: ~940–1 000 ms from the borrower's
barge-in to the agent falling silent, on VAD interruption, consistently across both runs. That is the
number D5.2's `minDuration` A/B will move.

### Known open: `GET /api/borrowers` is unbounded, and the chaos probe cannot get past it

The containerised chaos verdict (H12) is **still not recorded**, and now for a diagnosed reason
rather than an unknown one.

`chaos-orphan` starts by reading the borrower directory to find its fixture borrower. Measured on
2026-09-02:

```
GET /api/borrowers -> HTTP 200 in 28.4 s, 11 892 459 bytes   (27 893 borrowers)
```

The probe reports `no conversation id; cannot assert. FAIL` at 27 889 ms — it is not failing on the
chaos path at all; it never reaches it. The route has no limit and no pagination, and every fleet run
and soak that has ever minted fixtures has added to it.

That is worth fixing on its own account: a 12 MB response on the demo's own directory route is a
denial of service the harness happens to be pointing at, and the console reads the same route.

H12's two code defects are fixed and verified by other means (below); what remains is running the
probe end to end, which needs either a bounded directory route or a probe that mints its own fixture
the way the fleet does.

### Known open: the containerised sampler takes no container rows

**A containerised fleet run currently reports `cores used n/a` and no container rows**, and says so
in a note rather than leaving the absence to be read as zero. The per-core budget from a container
run is therefore not available yet; the numbers above it — equivalence, WER, silent playouts, the
latency waterfall — are unaffected.

Narrowed, not closed. Each command the sampler issues works from inside the harness container when
run by hand: `docker ps` 55 ms, `docker stats --no-stream` **2 040 ms returning all four rows**,
`docker exec … cat /sys/fs/cgroup/cpu.stat` 70–82 ms. Under the sampler's own `spawn` options
(`stdio: ["ignore", "pipe", "ignore"]`) the `stats` call never settles: instrumentation showed the
poll entered three times in fourteen seconds and the line after the `stats` await never reached.

The earlier N=5 container run in the table below **did** produce container rows — it ran an image
built before `feather-lite-harness` joined the default container set, and `docker stats` fails the
whole call if any one name is absent (`docker compose run` names its container
`feather-lite-harness-run-<hash>`, so that name never exists). Filtering to running containers fixed
that specific failure and did not make the rows come back, so there is a second cause.

What is in place meanwhile: the sampler filters to containers that exist, refuses to re-enter a poll
while one is in flight, and **names the absence in the report's notes**; `validateReport` refuses a
report whose `per_core.basis` claims a container it has no row for. So the failure is loud, and no
run can publish a container-basis figure it did not measure.

### 2026-09-02 — the harness moves into Docker (Phase D), and both arms measured

The harness was the last piece of the system on the host, and it is the piece that decides whether
every number is comparable. It now runs as a compose service (`--profile harness`,
`pnpm loadtest:tier2:docker`). Both arms below were run **within the hour, on the same code, against
the same stack** — the only difference is where the borrower lives.

| | **container harness** | host harness |
|---|---:|---:|
| calls served / equivalent | **5/5** | 5/5 |
| STT WER p50 / p95 | **0.000 / 0.000** | 0.000 / 0.111 |
| **silent playouts** | **0 of 15** | 0 of 15 |
| turn latency p50 / p95 (harness) | 3 212 / 5 454 ms | 3 037 / 3 752 ms |
| `total_ms` p50 / p95 (ledger) | 2 647 / 3 688 ms | 2 357 / 3 304 ms |
| `eou_delay_ms` p50 | 578 ms | 578 ms |
| `transcription_delay_ms` p50 | 430 ms | 481 ms |
| `ttft_ms` p50 | 1 084 ms | 945 ms |
| `tts_ttfb_ms` p50 | 386 ms | 401 ms |

**The media-path delta is +290 ms on `total_ms` p50 — and one N=5 pair cannot attribute it.** The
per-stage p50s sum to 2 478 ms in the container and 2 405 ms on the host, a difference of 73 ms, and
most of that is `ttft_ms` (+139 ms), which is OpenAI's variance and not a path this change touched.
`eou_delay_ms` p50 is identical to the millisecond. So the honest statement is that the containerised
harness costs **somewhere between nothing and about 300 ms at the median**, and separating the NAT
hairpin from provider noise needs more than five calls. Nothing here should be read as an SLO delta
until it is.

What the container arm does have that the host arm does not is a **complete resource picture**:
`per-core (containers: feather-lite-worker) cores used 0.671, MB/call 272`, with rows for all four
containers. The host arm reports `cores used n/a`, because on this box the procfs sampler cannot see
into the VM where the worker tree lives.

### Two things the first containerised run found

- **A worker race, and the harness's location is what exposed it.** `llmNode` switched
  `currentTurnId` before reporting the previous turn, so that turn's trailing TTS metrics landed on
  the next one and it was reported silent — a read-back the guard then repeats. `1/15 silent
  playouts` and one `FAILED` call at 150 s. The host arm never showed it: the race needs the extra
  latency to open. Fixed, and the re-run is the container column above.
- **`docker compose build` takes the last stage when no `target` is given.** Appending the `harness`
  stage to the worker's Dockerfile silently rebuilt `feather-lite-worker:local` from it — same tag,
  no `dist/`, and a container that exits 0 with no log line at all. Both services name their target
  explicitly now.

### W3 and W4 — the playout is the whole turn, attributed to the turn that spoke it

Third N=5 of the day, same box, worker rebuilt, nothing else changed. This is the change that
rewrites the path the fully-heard guard reads, so the gates are the verification.

| | after W2 | **after W3 + W4** |
|---|---:|---:|
| calls served / equivalent | 5/5 | **5/5** |
| STT WER p50 / p95 | 0.000 / 0.111 | **0.000 / 0.000** |
| **silent playouts** | 0 of 15 | **0 of 15** |
| turn latency p50 / p95 | 3 009 / 3 313 ms | 3 302 / 4 551 ms |
| `tts_ttfb_ms` p50 / p95 (ledger) | 375 / 456 ms | 433 / 452 ms |
| `total_ms` p50 / p95 | 2 405 / 2 746 ms | 2 506 / 3 654 ms |

Zero silent playouts is the number that matters: the silent-playout detection moved from "the first
item of the turn" to "the turn, once it is over", and a false positive there repeats a read-back the
borrower already heard while a false negative records a promise nobody heard.

### A correction to the W2 entry above

The W2 section reports the chars-per-second outlier count moving **5 of 15 → 0 of 15** and treats it
as the finding. Across three runs the same count reads **5, then 0, then 2** — so it is noisy, and
one before/after pair overstates the effect.

The mechanism is not in doubt and does not rest on that count: `tts/tts.js` emits once per segment
and resets its accumulators, so the ledger was keeping the last sentence's characters against the
last sentence's audio. What the three runs support is that the ratio is now taken over a turn's whole
speech; what they do not support is a precise effect size on the outlier count, and the earlier
wording should be read with that correction.

### And the reason this run took two attempts

The first attempt refused to start: `no online worker is reporting its mode`, with
`production=null max_jobs=null`. All four containers were healthy and `/readyz` was green.

The cause was three layers away and was introduced by C2's own commit. Compose began passing
`API_BEARER_TOKEN: ${API_BEARER_TOKEN:-}` so the server and worker would agree about the token; the
repo `.env` does not set it; and `API_BEARER_TOKEN=` reads as `Some("")` rather than `None`. That
switched authentication **on** with an empty secret, so every worker heartbeat 401'd — silently,
because that call is fire-and-forget — and the fleet's dev-mode gate correctly refused to measure a
worker it could not see.

Worth writing down because the gate did its job: it declined to produce a number rather than
producing a wrong one, and the failure surfaced only under a real run.

## 2026-09-01 — the N=10 acceptance run, and the first SLO verdict that means anything

The efficiency spec's acceptance bar (its Phase 9), due since Q8 said it runs after Phase 0 + W11
rather than after Phase 4. Run on the corrected instruments and the containerised stack.

**It does not pass.** Three of the four gates are met and the fourth — the SLO verdict — reads
`breach`. That is the first time it has been able to read anything: 30 turns against
`SLO_MIN_SAMPLE` 20, where every previous run had 15 and the honest answer was `insufficient`.

Box: quiet (browser closed, `pnpm stack:quiet` green), Langfuse down, `JUDGE_ENABLED=false`,
`TURN_DECIDER=openai`, `RATE_LIMIT_BYPASS_TOKEN` on both sides, `aura-2-orion-en`,
`LIVEKIT_NODE_IP=192.168.1.4`. Everything in containers except the borrower harness.
`2026-09-01-tier2-n10.json`.

### The first attempt, and why a ceiling of ten does not serve ten

The run was configured `WORKER_MAX_JOBS=10` — the spec's own figure — and came back **8/10 with
the WER gate breached**. Diagnosed before anything was changed:

| evidence | reading |
|---|---|
| worker log: **9 `job started` lines for 10 calls**, and no refusal | the tenth call never reached the worker |
| call07 ledger: `FAILED / NEVER_SERVED`, zero turns, `CALL_CONTROL HANGUP reason NEVER_SERVED` | the sweeper finalized a call no worker ever claimed |
| `loadFunc` = `activeJobs / WORKER_MAX_JOBS`, SFU stops at `load >= WORKER_LOAD_THRESHOLD` (0.75) | nine active calls report 0.9, and the SFU stops assigning |

`WORKER_MAX_JOBS` is the **denominator of the load the worker reports**, not the concurrency the
SFU will hand over. `agent.ts` says so beside the constant — "the admitted concurrency is
`floor(MAX_JOBS * THRESHOLD)` — 6 at the defaults, not 8 … reaching [ten] means raising
`WORKER_MAX_JOBS`" — and the acceptance run walked into it anyway. Only the 2.5 s staleness in the
reported load let the ninth call through at all.

Two things worth keeping from a run that was thrown away:

- **The shed path is correct.** A call the SFU would not assign finalized `NEVER_SERVED` with zero
  turns, not a hang, and the borrower is not blocked. That is the behaviour the spec asked to see
  if a refusal occurred, observed rather than assumed.
- **The per-call memory term is exact.** 2 917 MB peak with nine concurrent calls on a 755 MB idle
  tree is `(2917 - 755) / 9 = 240 MB` a call — the figure `docker-compose.yml` has carried since
  W11, confirmed at N=9 rather than extrapolated from N=5.

The WER "breach" was an artefact: the harness scored the never-served call's three lines at 1.000,
because a call nobody answered has no transcript. Worth knowing before reading a WER gate on any
run where a call is shed.

Re-run at `WORKER_MAX_JOBS=14` (14 × 0.75 = 10.5, so ten are assigned and an eleventh would be
shed) with `mem_limit` at 5 GB to cover the ceiling rather than the bar.

### N=10, ten calls, all served

| | 2026-09-01 N=5 | **2026-09-01 N=10** |
|---|---:|---:|
| calls served | 5/5 | **10/10** |
| agent hung up | 5/5 | **10/10** |
| equivalence | 5/5 | **10/10 green** |
| STT WER p50 / p95 | 0.000 / 0.000 | **0.000 / 0.000** (gate 0.20) |
| worst line | 0.000 | 0.111 (the barge-in, structural) |
| silent playouts | 0 of 15 | **0 of 30** |
| turn latency p50 / p95 (harness) | 3 115 / 4 501 ms | **2 961 / 3 495 ms** |
| TTS TTFB p50 / p95 | 391 / 417 ms | 385 / 406 ms |
| worker container peak | 2 018–2 095 MB | 3 144 MB |
| CPU-seconds per call-minute | 6.74–6.85 | 4.51 |

Ten concurrent calls, every one served, every one equivalent to the simulation scenario, and the
median turn **faster** than at N=5. The 2026-08-21 finding — that N=10 was this laptop's CPU
ceiling natively, 10/10 then 9/10 — does not reproduce on the container stack with the native VAD.
That was the prior this run existed to test, and the answer is that it no longer holds.

### The waterfall, and the gate that fails

`/api/system/latency?calls=10`, the same 30 turns:

| stage | p50 | p95 | target | vs N=5 p95 |
|---|---:|---:|---:|---|
| `eou_delay_ms` | 578 | 647 | 700 | 582 → 647 |
| `transcription_delay_ms` | 522 | **645** | 600 | 555 → 645 **breach** |
| `ttft_ms` | 975 | 1 489 | 1 500 | 2 321 → 1 489 |
| `tts_ttfb_ms` | 385 | 406 | 600 | 417 → 406 |
| `total_ms` | **2 440** | **2 933** | 2 500 | 3 696 → 2 933 **breach** |

**`total_ms` p50 is 2 440 against N=5's 2 441.** Doubling the concurrency did not move the median
turn by a millisecond. What moved is the tail, and it moved *down*: `ttft_ms` p95 went 2 321 → 1 489
because OpenAI's tail happened to be calmer, which ADR 0008 already records as a thing that varies
0.8–4.6 s on identical prompts and is not ours to control.

`/api/system/quality?calls=10`, the verdict:

```
verdict: "breach", pass: false, calls_found: 10, min_sample: 20
  total_ms                target 2500  p95 2933  n 30  breach
  eou_delay_ms            target  700  p95  647  n 30  pass
  transcription_delay_ms  target  600  p95  645  n 30  breach
  ttft_ms                 target 1500  p95 1489  n 30  pass
  tts_ttfb_ms             target  600  p95  406  n 30  pass
```

**This is not a regression.** `total_ms` p95 has been over 2 500 on every run ever recorded here —
the 2026-09-01 N=5 read 3 696 against the same target — and the verdict could not say so, because
15 turns is below the minimum sample and `insufficient` is the honest answer at that size. Phase 0
made the verdict tri-state and this run is the first with enough turns for it to be `pass` or
`breach` at all. It is `breach`, and it always was; the instrument just could not reach it.

`transcription_delay_ms` is the one thing that genuinely degraded with load: 555 → 645 ms p95,
from 448 → 522 at p50. That is Deepgram's finalisation under ten concurrent streams rather than
five, and it is a 45 ms overshoot of a 600 ms target.

`latency.slo_pass` per call reads **0.7** — seven of ten calls had no turn over any component's
target.

### The four gates

| gate | result |
|---|---|
| voice/sim equivalence | **10/10 pass** (`harness.equivalence_pass` 1.0) |
| WER ≤ 0.20 | **pass** — p95 0.000, worst line 0.111 |
| SLO verdict, voice + openai | **breach** — `total_ms` and `transcription_delay_ms` |
| compliance scores | **pass** — `mini_miranda_first`, `no_promise_without_readback`, `no_protected_before_rpc` all 1.0 over 10 calls |

Plus: zero silent playouts in 30 turns, no refusals, and the funnel reads 10 attempts → 10
connected → 10 right-party → 10 promises.

### Resources

```
container feather-lite-worker    idle  739 MB, peak 3144 MB, cpu peak 381.2% mean 67.3%, 145.3 CPU s
container feather-lite-server    idle  163 MB, peak  473 MB, cpu peak 169.5% mean 88.3%, 185.1 CPU s
container feather-lite-postgres  idle  276 MB, peak  301 MB, cpu peak 141.7% mean 91.7%, 187.7 CPU s
container feather-lite-livekit   idle   27 MB, peak   77 MB, cpu peak  22.4% mean  5.7%,  13.6 CPU s
per-core (containers: feather-lite-worker)  MB/call 240.5 rss, CPU s/call-min 4.51
```

3 144 MB peak against the 5 GB cap and against the 4 453 MB the ceiling of fourteen is sized for.
The worker is **not** the constraint at N=10 — `feather-lite-server` and `feather-lite-postgres`
each ran hotter on average (88 % and 92 % of a core) than the worker did (67 %), which is the
opposite of the shape at N=5 and the first thing to look at if N=20 is ever asked for.

### What this run says to do next

- The acceptance bar is **not met**, on latency alone, and the miss is a standing one rather than
  anything this session changed. Nothing was reverted, because nothing regressed.
- `total_ms` is a sum, and at N=10 no single stage owns it: 578 + 522 + 975 + 385 = 2 460 at p50
  against a 2 500 target. Meeting it means taking time out of two stages, not one — which is what
  issue #1's D2 fast path (a rules turn that skips `ttft_ms` entirely) and D5's knobs are for.
- `transcription_delay_ms` under concurrency is a new, specific finding and belongs in D5's A/B
  list rather than being absorbed.

## 2026-09-01 — Phase 0, the instruments straightened

Eleven fixes from `docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md`, and then every
number retaken, because five of the eleven were instruments that read in the direction of "fine".
**Nothing in this section should be compared with the 2026-08-28 table**: the point of the phase is
that the earlier numbers were taken through bent instruments, and the spec says so.

Box: quiet (`pnpm stack:quiet` green at 5.4 GB free after the browser was closed), Langfuse down,
`JUDGE_ENABLED=false`, `TURN_DECIDER=openai`, `RATE_LIMIT_BYPASS_TOKEN` set on both sides,
`aura-2-orion-en` to match the previous tier-2 voice.

### The shed probe, made able to discriminate

The 2026-08-28 probe could not tell the fix from its absence. It created its rooms over separate
HTTP calls, so the first job had already reached `activeJobs` before the second request arrived —
and "one served, two refused" follows from the stale `activeJobs` count alone. The window the
admission counter exists for is the gap between the accept and `launchJob`, and the only way to be
inside it for every request is to make every request at once.

`pnpm --filter @feather-lite/voice-worker shed-probe -- --calls 4`, four sessions created in one
`Promise.all`, against a worker started `WORKER_MAX_JOBS=2 WORKER_IDLE_PROCESSES=1`:

| job | arrived | decision | worker's own numbers |
|---|---:|---|---|
| 1 | +0 ms | accepted | — |
| 2 | +2 ms | accepted | — |
| 3 | +14 ms | **refused** | `in_flight 2, running 1, admitting 2, max_jobs 2` |
| 4 | +57 ms | **refused** | `in_flight 2, running 1, admitting 1, max_jobs 2` |

**Two served, two `NEVER_SERVED`.** The `admitting` figures are the discrimination: at the moment
job 3 was refused, `activeJobs` held one job and the ceiling was two, so the code this replaces
would have read 1 < 2 and accepted it — and job 4 as well. Four calls served against a ceiling of
two, which is exactly what the review predicted and what the old probe could not show.

The two refused calls finalized `FAILED` / `NEVER_SERVED` about 38 s later, on the sweeper's own
schedule. A refused job is not a lost call; it is a worker saying no, and the ledger records which.

One thing the live run corrected in the fix itself: with a warm slot, `launchJob` put job 1 into
`activeJobs` **26 ms** after the accept — one millisecond before the 25 ms admission poll noticed —
so a plain counter briefly counted one job twice. Over-counting refuses early rather than late and
was never dangerous, but the ceiling is claimed to be exact, so `admitting` became a set of job ids
and `in_flight` a union.

### W11 — the native VAD, which failed on Windows and shipped on Linux

`inference.VAD` replaces `silero.VAD.load()`: the same Silero model, in the same napi addon the
end-of-turn detector already lives in, taking `onnxruntime-node` — 513 MB of prebuilt binaries,
336 MB of it a CUDA provider nothing here can use — out of the tree along with the Dockerfile's
hand-prune.

**On the Windows dev box it failed 0/5.** Every call `NO_ANSWER`, zero turns of fifteen, WER 1.000,
and the worker log said why once per job process:

```
job process exceeded  memoryUsageMB 1907.3  memoryLimitMB 800  baselineMemoryMB 160.3  growthMemoryMB 1747
```

`pnpm --filter @feather-lite/voice-worker vad-cost` localises it. On win32-x64 with
`@livekit/local-inference` 0.2.6:

| | RSS |
|---|---:|
| node baseline | 44 MB |
| after loading the addon | 385 MB |
| after `createVad()` | 388 MB |
| after 1 predict | **517 MB** |
| after 551 predicts | 517 MB |
| after a second detector | 517 MB |
| after `global.gc()` | 517 MB |

~450 MB of native memory, once per process, flat across detectors and predicts, and not reclaimable.
That matters because of *where the model runs*: the EOU model runs in the **shared inference
process**, once per worker, but `inference.VAD` predicts wherever the stream is opened, which is the
**job process** — one per concurrent call. On Windows the swap does not move a cost already paid; it
buys a copy of it per call.

**On Linux the same probe reads 37 MB.** Inside the worker image (`linux/x64`, node 22):

| | RSS |
|---|---:|
| node baseline | 45 MB |
| after importing `_warmup` | 78 MB |
| after loading the addon | **78 MB** |
| after `createVad()` | 79 MB |
| after 551 predicts | 81 MB |
| after `global.gc()` | 82 MB |

The 450 MB arena is a **win32 artefact**, not a property of the native VAD, and the deployment
target is Linux. So W11 was implemented, reverted on the evidence of one platform, and then
re-measured on the platform that ships — which is why everything below runs in containers.

**Containerised N=5, twice, both green:**

| | run 1 | run 2 |
|---|---:|---:|
| equivalence | **5/5** | **5/5** |
| agent hung up | 5/5 | 5/5 |
| STT WER p50 / p95 | 0.000 / 0.000 | 0.000 / 0.111 |
| silent playouts | 0 of 15 | 0 of 15 |
| TTS TTFB p50 / p95 | 382 / 407 ms | — |
| worker container peak | 2 018 MB | 2 095 MB |
| CPU-seconds per call-minute | **6.74** | **6.85** |

`eou_delay_ms` p50 578 / **p95 580**, against the Phase 0 baseline's 579 / **582** — unchanged, which
is the gate and also the expectation: end-of-turn is the audio-native detector's job, not the VAD's.
CPU per call-minute is **6.74-6.85 against 8.1** on the host with the plugin, though the two are not
a controlled comparison — platform, container and VAD all changed at once.

**The idle tree, which is the number the sizing rests on:**

| | worker tree, idle, 4 warm slots |
|---|---:|
| host, Silero plugin (main 128 + inference 914 + jobs 609) | 1 651 MB |
| container, native VAD (`docker stats`) | **1 093 MB** |

and the worker image drops from **781 MB to 724 MB** with `onnxruntime-node` and
`@livekit/agents-plugin-silero` gone — a smaller number than the 513 MB the package weighs, because
the Dockerfile was already hand-pruning most of it. The win is that there is no longer a prune to
maintain, and no addon to be wrong about across architectures.

That fixed term is what lets `docker-compose.yml` carry `WORKER_MAX_JOBS=8` in 3 GB: 1 093 idle plus
eight calls at ~200 MB each (240 with margin) is 3 013 MB. With the plugin the same eight demanded
~4.4 GB, which is why the sizing fix earlier in this phase had to set it to four.

**What is now measured in containers, and what that changed.** The application runs entirely in
Docker — Postgres, the SFU, the server and the worker — and only the borrower harness is on the host,
because it is the caller. Two things had to be fixed before any of it worked:

- **The SFU advertised an unreachable media address.** `--node-ip 127.0.0.1` is right for the browser
  demo and means "this container" to a containerised worker, which is why "a container-to-container
  voice call is not verified" sat on the README's Not-built list. It is `LIVEKIT_NODE_IP` now,
  default unchanged; set to a host address both sides can reach, media flows and the call completes.
  **That item is now verified rather than assumed.**
- **The resource sampler could not see the application containers.** It knew about `livekit` and
  `postgres` only, so a `--profile app` run reported `cores used n/a` and no worker memory at all —
  the per-core budget, which is the whole of D1, was silently unavailable for exactly the runs the
  acceptance bar is defined on. It now samples all four, takes CPU from each container's
  `cpu.stat` counter rather than integrating `docker stats` percentages, and `per_core.basis` says
  `containers: feather-lite-worker` so a container figure is never read as a host one.

### Tier 2 — N=5, real calls, on the corrected tree

`2026-09-01-tier2-n5.json`. `WORKER_MAX_JOBS=8`, four warm slots, borrowers in a forked child.

| | 2026-09-01 |
|---|---:|
| agent hung up | 5/5 |
| equivalence | **5/5 green** |
| STT WER p50 / p95 | **0.000 / 0.000** (gate 0.20) |
| silent playouts | **0 of 15** |
| harness turn latency p50 / p95 | 3 115 / 4 501 ms |
| TTS TTFB p50 / p95 | 391 / 417 ms |
| CPU-seconds per call-minute | 8.1 |
| calls per vCPU | 3.63 |

The waterfall, from `/api/system/latency` over the same 15 turns, is where the turn latency comes
from:

| stage | p50 | p95 | target |
|---|---:|---:|---:|
| `eou_delay_ms` | 579 | 582 | 700 |
| `transcription_delay_ms` | 448 | 555 | 600 |
| `ttft_ms` | 1 020 | **2 321** | 1 500 |
| `tts_ttfb_ms` | 391 | 417 | 600 |
| `total_ms` | 2 441 | 3 696 | 2 500 |

`ttft_ms` p95 owns the tail, which is the finding ADR 0008 already recorded and could not fix:
decide latency on identical prompts varies 0.8–4.6 s and it is OpenAI's tail, not prefill. Every
other stage is inside its target. This is a new baseline and not a regression against 2026-08-28 —
the same night ADR 0008 was written, two N=5 runs on this box read p50 2 145 and 3 039 ms with
identical per-stage numbers.

### The SLO verdict, proving itself on the run that produced it

`/api/system/status` over that window:

```
verdict: "insufficient", pass: false, calls_found: 5, min_sample: 20
insufficient: [total_ms, eou_delay_ms, transcription_delay_ms, ttft_ms, tts_ttfb_ms]
breaches: []
```

Fifteen turns against a minimum sample of twenty, so no component was judged. **Before this phase
that window badged "SLO MET"** — `pass` was `breaches.length === 0`, and an empty breach list over
nothing measured is not a pass. The console now shows "NOT ENOUGH DATA" in a neutral badge.

### The worker heartbeat, now reporting what it resolved

The same run, from `/api/system/status`:

```
production: true, simulation: false, max_jobs: 8,
load_threshold: 0.75, load_shedding_disabled: false,
idle_processes: 4, idle_processes_configured: 4
```

`idle_processes` is the pool's own count of forked job processes, not the constant it was
configured with — which makes "verify live that the pool actually pre-warms" (W3) answerable for the
first time. It reads 4 of 4 here. A `dev`-mode worker reports `production: false` and the fleet
refuses it; the refusal message no longer claims dev mode disables load shedding, because it does
not: `ServerOptions` forces `loadThreshold` to `Infinity` only under `--simulation`, which is now
its own refusal with its own flag.

### The idle tree, and a review claim that did not reproduce

`2026-09-01-idle-tree-phase0.json` against `2026-08-28-idle-tree-bundle.json`, both `start` mode
with four warm slots:

| role | 2026-08-28 peak RSS | 2026-09-01 peak RSS |
|---|---:|---:|
| worker-main | 133 MB | **128 MB** |
| worker-inference | 916 MB | 914 MB |
| worker-job (×4) | 617 MB | 609 MB |

The review put the top-level `import * as silero` at **+73.8 MB per process**. Moving it into
`prewarm` is worth **5 MB** on this box under the bundle — the import chain is real
(`index.js` → `vad.js` → `onnx_model.js` → `onnxruntime-node`, all static), so the change is right
in principle and the main process no longer loads a native addon for a plugin only `prewarm` uses.
But the number does not reproduce at anything like that size here, and it is recorded at what it
measured rather than at what was expected. W11 removes the package from the tree entirely and is
where the real figure will be.

### What the run found that was not being looked for

**`mode: "adaptive"` interruption is not running on the self-hosted profile.** The worker log, on
every job:

```
adaptive interruption disabled due to unrecoverable error, falling back to VAD-based interruption
error: "WebSocket connection rejected with status 401"
label: "AdaptiveInterruptionDetector"
```

The adaptive detector is hosted inference resolved from `LIVEKIT_INFERENCE_URL` / `LIVEKIT_API_KEY`,
and the self-hosted SFU's key is not a LiveKit Cloud inference credential. So every interruption
number this project has ever taken was taken on **VAD-based** interruption, and the config's
`mode: "adaptive"` has been a request, not a fact. That is the spec's D5.1 question, answered
before it was asked; `interruption.minDuration` (D5.2) is therefore the live knob, and D5.1 becomes
a config correction rather than a measurement.

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
