# Audit findings: observability correctness, and where CPU and memory go (2026-08-27)

Companion to `2026-08-27-efficiency-and-observability-hardening-spec.md`. This is the evidence; the
spec is the decisions. Five read-only reviews were run against `main` at `0e858db` on the dev laptop
(Ryzen 5 5600H 6C/12T, 15.35 GB, Windows 11, Docker Desktop on WSL2, `.wslconfig` memory=8GB
processors=4). Nothing in the tree was changed. Numbers marked **measured** were produced during the
audit; numbers marked *estimated* were not.

## 1. The observability & quality layer — what works

- `pnpm check` green: 173 domain + 33 control-plane unit tests. `pnpm test:db` 59/60, the one
  failure being the pre-existing `test/db/workers.test.ts:145` pinned date.
- A simulated call produced 11 EVALUATOR + 6 JUDGE scores in `conversation_scores`, readable at
  `GET /api/conversations/:id/scores`; the judge ran from the outbox ~12 s after close, model call
  outside the transaction as ADR 0009 says.
- The `1aabd9d` fix is real: in the self-hosted ClickHouse, a turn-level score carries
  `trace_id` + `observation_id` and that span exists (`turn:DISCUSSING_PAYMENT`); a call-level
  score carries `session_id` only. No `Error ingesting scores` in the server log.
- Tracing is not on the hot path — **measured**: 36 `simulate_turn` calls with Langfuse on, mean
  30.8 ms / p95 40.6; off, mean 31.0 / p95 44.6.
- Per-turn DB writes for metrics: none (the worker's `turn_metrics` signal updates
  `conversation_turns.result`; no event, no `sequence_no`).
- Buffers are bounded: `Tracing` pending ≤ 500, observation-id map ≤ 2000, provider-error ring 20.

### Trace shape (a fact nobody had written down)

**Each turn is its own root Langfuse trace**; the only thing consistent across a call is
`session_id = conversation_id`. The judge is a fourth trace. The voice worker emits nothing to
Langfuse (no `@langfuse/*`/OTel dependency under `apps/voice-worker`); its numbers arrive via the
`turn_metrics` HTTP signal and are folded into the control-plane turn span. There is no
`traceparent` between worker and control plane.

## 2. Observability defects (file:line, severity)

| # | Defect | Where | Sev |
|---|---|---|---|
| O1 | Percentile is one rank high: `xs[floor(p/100·n)]` instead of nearest-rank `ceil(p/100·n)−1`. **Measured:** `system.orphan_detect_ms` over two readings (30 895, 38 902) reports `p50: 38902`. This is the function the SLO gate uses. | `services/Quality.ts:45`, `services/Queries.ts:325` | med |
| O2 | No minimum sample size and no channel/decider segmentation in the SLO window. p95 of n=6 is the max. **Measured:** `slo.measured.ttft_ms` went 3228 → 1252 ms and the breach list lost `ttft_ms` because a tier-1 run added 36 scripted turns to the "last 50 calls" window. | `Quality.ts` `sloFrom`, `Queries.ts` `aggregateTurnRows` | high |
| O3 | Funnel `connected` = `final_outcome IS DISTINCT FROM 'NO_ANSWER' AND NOT voicemail` counts in-flight/abandoned calls (`final_outcome IS NULL`). **Measured:** 13 unfinished simulations → contact rate 95.9%. | `Quality.ts:128` | high |
| O4 | Scheduled voice re-dial (`RETRY_CALL`) calls `workflow.startCall({channel:'voice'})` and never dispatches an agent (`VoiceSessions.create` is HTTP-only). The sweeper then books it as an orphan on the long unconfirmed window. **Measured, unprompted:** conversation `ae312a15…` created 14:54:37 from attempt_no 4, swept ORPHANED at 14:59:46, `system.orphan_detect_ms = 308860`; fleet `orphan_detect_ms.p95` went 38 902 → 308 860. | `services/Scheduling.ts:123-131`, `services/Sweeper.ts` | high |
| O5 | `funnel.orphaned ⊆ funnel.failed` but the console shows them side by side as if additive. | `Quality.ts`, `apps/console/src/views/quality.ts:56-58` | low |
| O6 | `latency.slo_pass` is in the closed score vocabulary, typed BOOLEAN, and has **no producer**; `scores.ts:14` says "an entry here is never a metric nobody emits". The SLO verdict is never persisted. | `packages/domain/src/scores.ts:59,122` | med |
| O7 | Langfuse ingestion failures are structurally invisible: `@langfuse/client` `score.create` is `void` (sync enqueue, flush at 10 events / 1 s), so `Effect.try` can catch nothing; `forceFlush` is `Effect.ignore`d. No SDK logger hook, no counter. | `services/Tracing.ts:442` and the flush/finalizer | med |
| O8 | Harness per-turn scores use the scripted *label* as `turn_id` (`"yes this is the borrower"`, `"BARGE-IN: …"`), so they can never join `conversation_turns` and always take the session fallback in `Tracing.score`. `POST /scores` validates the conversation but not the turn. | `apps/voice-worker/src/tracer/harness-scores.ts:65,74`; `scripted-call.ts:406-476` | med |
| O9 | Rate-limit rejections are counted nowhere. **Measured:** tier-1 C=50 from one IP → 14 start + 13 turn errors, all 429, `calls_started: 1`, no counter moved; the run reported 23/50 correct for a reason the status page cannot show. The bucket `Map` at `app.ts:83` is never evicted (unbounded on public IPs). | `http/app.ts:72-83` | med |
| O10 | `reliability.counts` is all-time and a full `conversation_events` scan with a correlated `NOT EXISTS`, executed on every `/status` and `/quality` request, shown under a "last N calls" header. | `Quality.ts:297`, `repos/conversation.ts:208-238` | med |
| O11 | `/api/system/status` is an N+1: `turnRowsFor` loops one query per conversation (each with two correlated `EXISTS`), `sloStatus(50)` on every status poll; the console polls status every 5 s and quality every 10 s. **Measured:** ≈1.4 ms per conversation, linear; `MAX_WINDOW=1000` → ~1.4 s. | `Queries.ts:268-278,186-201`, `handlers.ts:94-119`, `apps/console/src/views/status.ts:175` | med |
| O12 | `compliance.no_promise_without_readback` is `null` on the simulate path (needs `AGENT_TURN_PLAYOUT`) and nothing on the page says why n=2 while promises=5. | `packages/domain/src/evaluation.ts:104-110` | med |
| O13 | Judge cost discipline is documented, not enforced: `.env` has `JUDGE_ENABLED=true` and nothing in `apps/load-test` turns it off; a C=50 run would enqueue 50 GPT-5.6 Luna calls. | `apps/load-test/src/tier1.ts` | med |
| O14 | `Metrics.observe()` has no callers (`histograms` is always `{}`); `Metrics.ts:10` and `main.ts` say the orchestrator counts there — it does not (`grep metrics\. Orchestrator.ts` → 0). | `services/Metrics.ts:10,37,60` | low |
| O15 | README status-table numbers stale: "92 unit" (173), "27 unit + 28 DB" (33 + 60), "18 routes" (OpenAPI enumerates 23). | `README.md:26-29` | low |
| O16 | `docs/loadtest/README.md:65` N=5 row (turn latency 7170 / 18211 ms) matches no committed JSON; `2026-08-26-tier2-n5.json` holds 3049 / 18449. The fleet writes `${date}-tier2-n${N}.json`, so the attempt that produced the row was overwritten. | `docs/loadtest/README.md:65` | low |

### Gaps against what a production team expects

- No process metrics anywhere (event-loop lag, RSS/heap, GC, pg-pool in-use/idle/waiting, active
  handles). `Metrics` is a hand-rolled counter map; pool visibility exists only in the tier-1
  harness's own `pg_stat_activity` scrape.
- OTel resource has no `service.name` (`unknown_service:…node.exe` in ClickHouse).
- `/readyz` is `SELECT 1`; the three background loops and the exporter can all be dead and it
  still says ready.
- `Effect.annotateLogs` appears in 3 places repo-wide; `TurnRunner.ts:105` "turn failed after
  start" carries no conversation/turn id.
- `main.ts` logs `tracing: langfuse|off` only in the `openai` decider branch.
- Turn span `output` carries balances and due dates unredacted to the trace backend; the leak test
  covers the judge prompt, not the trace payload.
- `provider_${provider}_${kind}` is keyed by a caller-supplied string from
  `POST /api/system/provider-events` (bearer-gated, but `API_BEARER_TOKEN` is empty in dev).

## 3. The voice worker — process model and footprint

Versions installed: `@livekit/agents` 1.6.4, `@livekit/local-inference` 0.2.6 (68.7 MB napi addon —
**the audio-native EOU model is compiled into it**; there is no ONNX file on disk and
`download-files` is a no-op for it), `@livekit/rtc-node` 0.13.33, `onnxruntime-node` 1.24.3,
`@livekit/agents-plugin-silero` 1.6.4 (`silero_vad.onnx` 2.3 MB, shipped inside the package).
The 441 MB under `~/.cache/huggingface/hub/models--livekit--turn-detector` is two revisions of the
**deprecated text** EOU model (63 MB en, 378 MB multilingual) pulled by the tracer harness; the
production worker does not read them.

Process tree, **measured** idle with no SFU and no call (private commit):

```
pnpm launcher ×2                         ~107 MB each
tsx supervisor                             48 MB
main worker  (tsx src/agent.ts dev)     1 000 MB   ← 772 MB of it: require('@livekit/local-inference')
shared inference proc (EOT)               997 MB
job proc (one warm call slot)             185 MB
                                        ─────────
                                        ~2 445 MB before the first call
```

Where each stage runs: SFU signalling/dispatch/load monitor in the main worker
(`worker.ts:447-509, 751-800`); EOU inference in the one shared inference process
(`ipc/inference_proc_executor.ts:76-103`, `inference/eot/runner.ts:36-66`); room I/O, Opus, Silero
VAD (`onnx_model.ts:9-16`, 1 intra/1 inter thread), Deepgram STT/TTS websockets and `llmNode` in a
**forked one-shot child process per job** (`ipc/job_proc_executor.ts:73-82`, `proc_pool.ts:113`).

Facts that matter for the spec:

- **W1** `worker.ts:52` `require`s `@livekit/local-inference` in the main worker purely as an
  availability probe (`inference/_warmup.ts:27-40`); the main worker never runs inference.
  **Measured:** +772 MB under tsx/ESM, +322 MB in bare CJS. The framework's own comment says the
  model is "~138 MB".
- **W2** `dev` mode (`cli.ts:209`) sets `production=false` → `Default.loadThreshold(false)` =
  `Infinity` (`worker.ts:68-74`, applied at `:260`), so the worker can never report `WS_FULL` and
  the SFU dispatches through the CPU ceiling. `dev` also forces debug pretty logging. All fleet
  measurements to date were taken in `dev` mode (`pnpm dev:worker`).
- **W3** `numIdleProcesses: 1` (`apps/voice-worker/src/agent.ts:235`) and `proc_pool.ts:99-114`
  serialise warm-ups behind one `initMutex`. **Measured** job-proc cold start 2 800 ms (2 655 ms
  module load: `@livekit/agents` 1 400 ms, `contracts`+`domain` as raw `.ts` 1 266 ms; VAD load
  145 ms). A 5-call burst pays ≈14 s of serialised cold start inside the calls, which is the
  shape of the tier-2 duration stretch and why `initializeProcessTimeout` sits at 60 s.
- **W4** CPU per call, **measured**: Silero 6.3 ms CPU per second of audio; EOT 42–48 ms wall
  per 1.2 s window, 1–3 predictions per user turn, in the shared process. EOT ceiling ~65
  predicts/s at `UV_THREADPOOL_SIZE=4`, ~80/s at 12 (concurrency-10 burst wall 160 → 124 ms).
- **W5** Room input is 24 kHz and is resampled to 16 kHz three times independently — VAD `QUICK`
  (`silero/vad.ts:221-226`), EOT `QUICK` (`eot/base.ts:336-341`), STT default `MEDIUM`
  (`stt/stt.ts:507-508`). TTS is 24 kHz linear16, matching output. *Estimated* 1–3 ms CPU/s/call.
- **W6** Deepgram TTS opens a new websocket per synthesis inside the measured TTFB
  (`deepgram/tts.ts:293-320`; p50 398–430 ms). ADR 0008 and `scripted-call.ts:82-83` record that a
  pooled Cartesia socket dropped generations under concurrency — do not pool naively.
- **W7** `supervised_proc.ts:12,124-149,289-304` → `pidusage` spawns `wmic` per child every 5 s,
  enforcing `jobMemoryLimitMB = 0` (i.e. nothing). Windows-only cost; unmeasured.
- **W8** The fleet harness runs all N borrowers in one Node process on the same box, each with its
  own `Room`/`AudioSource`/`AudioStream` and a per-frame JS RMS loop (`scripted-call.ts:286-296`).
  Tier-2 numbers measure the laptop, not the worker.
- **W9** `vmmemWSL` held 5.8 GB with `docker-desktop: Stopped`; `.wslconfig` has no
  `autoMemoryReclaim`.
- **W10** Opus/`rtc-ffi` thread CPU is *unmeasured* (needs a live call); which endpointing table
  is in force (300/2500 vs 500/3000, `turn_config/endpointing.ts:40-53`) is unverified from a live
  run; `@livekit/agents-plugin-livekit` is still a dependency though unused since Phase 9 P4 and
  pulls `@huggingface/transformers` + `onnxruntime-web` (~208 MB on disk).

## 4. The control plane — per-turn cost model

ADR 0003 holds: T1 commits at `Orchestrator.ts:481`, the decider streams at `:539`, T2 opens at
`:559` — no transaction spans the LLM call.

Round trips per turn (`pg` extended protocol, no pipelining, pool 10, one event loop):

| Phase | Round trips | Why |
|---|---:|---|
| T1 claim (`Orchestrator.ts:439-481`) | 15 (+2 with a voice playout) | lock, idempotency, CAS, insert turn, **`SELECT MAX(sequence_no)+1` then INSERT**, 6-query `ContextBuilder` (`:55-66`), **full ledger read** (`repos/conversation.ts:478`) |
| T2 commit, chat only | 9 | lock, full ledger read again, AGENT_TURN (2), finish, release |
| T2 with tool + 1–2 transitions | 15–17 | each event = 2 round trips |
| T2 terminal (`finalize` `:185-221` + `enqueuePostCall` `Outbox.ts:66-88`) | 29 | 8 events = 16 round trips inside the row lock |

≈ 43 statements per turn, ≈ 3 600/s at the measured 83.5 turns/s. The ledger is read, key-rebuilt
through `snakeToCamel` (`db/client.ts:22`), decoded through a 20-member `Schema` union
(`repos/conversation.ts:342`, `packages/domain/src/events.ts:194`) and `replay()`ed
(`replay.ts:123`, a 15-field spread per event) **twice per turn**; `executeTool` replays a third
time (`:235`); two `[...events].reverse()` copies for the barge-in lookup (`:516,518`).

What the tier-1 numbers (`docs/loadtest/2026-08-21-tier1-*.json`) establish: knee ≈ 70 turns/s
between C=50 and C=100; Postgres never the constraint (0 lock waits, 6 of 11 backends active at
C=200); pool 40 → 22 idle-in-transaction and 6% *less* throughput — the fingerprint of
round-trip-bound transactions on one event loop. With the scripted decider, tier-1 "TTFT" ≈ T1
duration and `turn_wall − TTFT` ≈ T2; at C=200 they are ≈ 788 and ≈ 800 ms.

Other findings:

- **C1** `http/TurnRunner.ts:24,36,54,62,67` retains every `LiveTurn` **including delta frames** for
  5 minutes and `gc()` iterates the whole map on every `run()` — O(n²) at ~24 000 entries for
  80 turns/s. Invisible to the 2–8 s tier-1 runs.
- **C2** `services/Outbox.ts:263-286` processes claimed jobs sequentially, tick 5 s, limit 20 →
  ≈ 4 jobs/s ≈ 1.3 completed calls/s; every job re-reads and re-replays the ledger, the judge path
  twice (`:139,146`).
- **C3** Sweeper query (`repos/scheduling.ts:167-182`, every 10 s) has no matching index
  (`WHERE ended_at IS NULL AND final_outcome IS NULL AND channel='voice' AND started_at < …`).
- **C4** `llm/prompts.ts:44` `JSONSchema.make` per tool per turn, uncached.
- **C5** `apps/server` and `packages/control-plane` (`exports: ./src/index.ts`) are transpiled by
  tsx at every boot; no `tsc` build, no `NODE_OPTIONS`.
- **C6** SSE frames: `Schema.encodeSync(TurnFrame)` + `JSON.stringify` + `TextEncoder` + one write
  per frame (`handlers.ts:69-74`).
- **C7** Server process, **measured**: idle RSS 152 MB; peak during tier-1 C=50 198 MB; returns to
  157 MB. Postgres container 52 MiB, ≤ 2.7% CPU.
- **C8** Open question worth one experiment: whether `@effect/sql-pg` 0.53 (on `pg` 8.16) uses
  named prepared statements; `pg` 8.x has no pipelining.

## 5. Containers and the host

- **No Dockerfile exists.** `start` scripts are `tsx src/…` and `tsx` is a devDependency in both
  apps. "LiveKit Build" in the deploy doc is a pricing tier, not an image build.
- No `mem_limit`/`deploy.resources` on any of the eight services (verified via
  `docker compose config` for both files). No retention/TTL configured for Langfuse/ClickHouse.
- Images: langfuse-worker 1.81 GB, langfuse 1.65 GB, clickhouse 1.13 GB, postgres:17 645 MB,
  postgres:16-alpine 420 MB, minio 241 MB, redis 170 MB, livekit-server 122 MB — ≈ 6.2 GB.
- **Measured** RSS: Langfuse stack 1.1 GiB at boot, **2.0 GiB while ingesting** (web 713 MiB,
  worker 678, clickhouse 509 at 33% CPU). All six are hard `depends_on`; MinIO is the only one
  replaceable by external S3; Redis is the ingestion queue.
- Host at snapshot: `vmmemWSL` 5.67 GB, **361 MB free system-wide** before any app process.
- `node_modules` 0.75 GB / 31 241 files; the largest items are `onnxruntime-node` 210 MB (all
  platforms), `onnxruntime-web` 69 MB and `@huggingface/transformers` 12 MB — all transitive via
  the unused `agents-plugin-livekit` — plus `local-inference` 66 MB and `rtc-ffi` 23 MB.
- Production dependency trees are lean: worker 11 packages, server 8.
- Alpine is out: `@livekit/rtc-node` and `onnxruntime-node` ship glibc-only prebuilt binaries
  (LiveKit docs: "Alpine (musl) is not supported"). LiveKit's own Node template is
  `node:*-slim`, multi-stage, `ca-certificates` installed explicitly, `npm run build` then
  `node dist/agent.js start`.

## 6. External reference points (with sources)

- LiveKit sizing: "4 cores and 8 GB per agent server … 10–25 concurrent jobs depending on the
  components"; a cited load test used ~3.8 cores / 2.8 GB for 30 agents; scale up at 0.5 when
  `loadThreshold` is 0.7; `terminationGracePeriodSeconds: 600` for voice.
  https://docs.livekit.io/deploy/custom/deployments/
- Worker options: `numIdleProcesses` default `min(availableParallelism, 4)` in production, 0 in
  dev; `loadFunc` default 5 s CPU average, `loadThreshold` 0.7; documented custom
  `loadFunc = activeJobs / N`. https://docs.livekit.io/agents/server/options
- Turn detector v1-mini: local CPU, ONNX INT8, "< 500 MB", avoid burstable CPUs.
  https://docs.livekit.io/agents/build/turns/turn-detector/
- Deepgram STT plugin defaults: `endpointing` 25 ms, `interim_results` true.
  https://docs.livekit.io/agents/models/stt/deepgram/
- Node images and glibc: https://docs.livekit.io/deploy/agents/builds/ ;
  https://github.com/livekit/node-sdks/issues/571
- Agents native metrics (STT/LLM/TTS/EOU events; `UsageCollector` deprecated for
  `session.usage`): https://docs.livekit.io/agents/ops/logging/ ; OTel export from a session to
  Langfuse: https://docs.livekit.io/deploy/observability/tracing/
- Langfuse v5: sampling via an OTel `TraceIdRatioBasedSampler`, batching in the span processor.
  https://langfuse.com/docs/observability/features/sampling
- V8: `--max-semi-space-size` 64–128 MB for allocation-heavy throughput; `--max-old-space-size`
  ≈ 75% of the container limit (community guidance, not Node docs).
- Commercial end-to-end latencies cluster 600–900 ms (vendor self-reports, directional only). No
  vendor publishes calls-per-vCPU; LiveKit's 10–25 per 4 cores is the only sourced anchor.

## 7. ADR 0005 revisited: would Python or Go buy real efficiency? (2026-08-27, evening)

The user asked for the language decision to be reopened if a rewrite of any component in Go or
Python gives real gains. Two inputs: a documentation/source review of both LiveKit SDKs and of the
Go ecosystem, and a **measured** Python `livekit-agents` 1.7.1 worker on this box (venv in the
session scratchpad, dead endpoints, no real calls — same method as the Node numbers in §3).

### What is documented

- **L1** Python's default job executor is `PROCESS` (`THREAD` only on Windows,
  `worker.py:126-130`); one process per job, one-shot — the same design as Node. `THREAD` mode
  shares one interpreter and the GIL, and per-job memory warn/limit cannot apply (they are
  per-process). LiveKit's own post "Diagnosing Blocked Event Loops" does not bless it as safe.
- **L2** Defaults are identical across SDKs: `job_memory_warn_mb` 1000 / limit 0,
  `num_idle_processes` `min(cpu,4)` prod / 0 dev, `drain_timeout` 3600.
- **L3** Python also has the shared inference process and a forkserver warm-up that pages native
  weights; the turn-detector README says "< 500 MB, shared inference server".
- **L4** `agents-js` 1.6.4 → 1.7.1 changes nothing about the main-process probe,
  `numIdleProcesses` or dev-mode `loadThreshold` (verified via the compare API and the raw
  changelog; the only inference change is the `local-inference` 0.2.7 bump). W1 is not fixed
  upstream.
- **L5** A LiveKit engineer, on the 1.5.8→1.6.4 memory thread, notes summed RSS double-counts
  copy-on-write pages across parent/child — summed trees overstate real memory on Linux. (Said
  about Python; the private-commit counter used for the Node numbers in §3 is not subject to it.)
- **L6** Python users report the same class of memory pain (issues #2228, #3841, #4483, #4869,
  1–3.5 GB, several closed "not planned").
- **L7** Feature parity is high on every item that matters here (`llmNode` override, `RoomIO`,
  endpointing, metrics, OTel, memory limits, `loadFunc`, audio-native `TurnDetector`). No LiveKit
  statement ranks Node below Python.
- **L8** **Go has no official Agents SDK.** Only a third-party protocol shim
  (`am-sokolov/livekit-agent-sdk-go`) and non-LiveKit frameworks (JARGO, a Pipecat port;
  Streamcore). A Go worker means the dispatch protocol, Pion media, an onnxruntime-go/cgo
  binding to the EOU/VAD models, and every provider client, from scratch.
- **L9** For the control plane, Go's plausible win is `pgx` **pipeline mode**, not the language;
  node-postgres has no pipelining (PR #2706 unmerged), `postgres.js` does. The ~43 round trips are
  a batching problem: a Go port that keeps the query pattern still makes 43 round trips.

### What was measured (Windows, private commit, worker idle in connect-retry, one idle job)

| | Node 1.6.4 (§3) | Python 1.7.1, native EOU, PROCESS | Python, legacy text EOU, PROCESS | Python, THREAD |
|---|---:|---:|---:|---:|
| main process | 1 000 MB | **477 MB** | 477 MB | 490 MB |
| shared inference process | 997 MB | **none spawned** | 1 084 MB | none |
| idle job process | 185 MB | **489 MB** | 490 MB | n/a (0.72 MB per constructed session, floor only) |
| idle tree, 1 warm slot | ≈ 2 200 MB | **≈ 970 MB** | ≈ 2 050 MB | ≈ 490 MB |
| job cold start | 2.8 s | 2.5 s | 2.5 s | 0.09 s |
| VAD, ms CPU per s of audio | 6.3 (Silero ONNX) | 4.4 Silero ONNX / **0.69 native** | same | same |
| EOU per predict | 42–48 ms (shared proc) | **38.5 ms** (in-job, native) | 73 ms | same |
| disk | node_modules 768 MB | **venv 319 MB, nothing to download** | 446 MB + 460 MB HF cache | — |

Two things explain the gap, and neither is "Python is faster":

1. On the recommended audio-native path Python **does not spawn the inference process** — the EOU
   model runs inside each job (`init_eot()` +243 MB resident per job, which is why the Python job
   process is 2.6× Node's). Node 1.6.4 runs EOU in one shared process for all jobs. Below ~N=3
   Python's topology is lighter; **at N=10 it is heavier**: Python ≈ 0.48 + 10×0.49 ≈ 5.4 GB
   commit (Windows `spawn`; Linux `forkserver` COW would be lower) vs Node-after-W1 ≈ 0.3–0.7 +
   1.0 + 10×0.2 ≈ 3.3–3.7 GB.
2. Node pays the 772 MB probe (W1) in its main process; Python's main process does not load the
   weights. That is a patch, not a language.

The Python THREAD executor is the only configuration with a *different* memory shape (~0.5 GB for
the whole worker, sessions as threads). It costs crash isolation and per-job memory limits, is a
Windows default / Linux opt-in, and its safety depends on nothing in the job code holding the GIL
— the VAD and EOU are native and release it, and this worker's own code is thin, so it is
plausible, but it is unmeasured under load.

**A finding for Node, found by accident:** `@livekit/agents` 1.6.4 already exports
`inference.VAD` (native, in the same addon; `dist/inference/vad.js`, `local-inference/index.d.ts`
`createVad`). The worker uses `@livekit/agents-plugin-silero` instead. Python's native VAD measured
**0.69 ms CPU per second of audio vs 4.4–6.3 for Silero-ONNX** — a ~6–9× per-call VAD saving
available without changing language (W11 in the spec).

Caveats: no job ever ran in the Python measurement (idle prewarmed process only); per-session
THREAD cost is a construction floor; Windows numbers; the Node 2.8 s cold start includes tsx
transpilation that D6 removes.

### Verdict (recorded in the spec, §"Language decision")

- **Go: no**, for either component. No Agents SDK; the control plane's bottleneck is round trips
  (C-series), which Node fixes by batching in D5.
- **Control plane in Python: no.** 7.5k LOC + 2.9k domain + 3.8k tests, no measured bottleneck
  the language owns, and the domain/contracts packages are shared with the console.
- **Voice worker: keep TypeScript, patch W1, switch to `inference.VAD`, and keep a time-boxed
  Python THREAD-executor spike in reserve** (spec Phase 7b), triggered only if the N=10 acceptance
  fails after Phase 4 on a memory ceiling. The worker proper is 698 LOC behind an HTTP/SSE contract
  and the equivalence harness validates any implementation, so the spike is ~1–2 days, not a
  project — which is exactly why it need not be done pre-emptively.
