# Load test results

Raw reports are the JSON files beside this one; this page is the reading of them. Re-run with:

```bash
pnpm loadtest:tier1 -- --concurrency 100 --ramp 2      # control plane (heavy)
pnpm loadtest:tier2 -- --calls 5                       # real voice calls (modest)
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

## Tier 2 — voice fleet, 2026-08-27 (re-measured with the quality layer)

Same harness, same box, now reporting WER and TTS heuristics. **The headline is that N=5 did not
reproduce its August result on this machine, and the cause is the machine.**

| N | equivalence green | WER p50 / p95 | silent playouts | TTS TTFB p50/p95 | turn latency p50/p95 |
|---:|---|---|---|---|---|
| 2 | **2/2** | 0.000 / 0.111 | 0 / 6 | 430 / 459 ms | 3345 / 5490 ms |
| 5 | 3/5 (also 4/5, 3/5 on two earlier attempts) | 0.000 / **1.000** — gate FAILED | 1 / 13 | 398 / 2394 ms | 7170 / 18211 ms |

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
