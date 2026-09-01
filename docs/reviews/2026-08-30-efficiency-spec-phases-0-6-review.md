# Review: efficiency & observability spec, Phases 0–6, against the code

**Date:** 2026-08-30 · **Base:** `main` @ `5dc57d7` · **Spec:**
`docs/plans/2026-08-27-efficiency-and-observability-hardening-spec.md` · **Stance:** the code is the
only source of truth; the handoff, ADR 0010, PROGRESS and the loadtest README were treated as claims
to verify, not as evidence. Three reviewers each took one area (D2/D3, D4/D6/D1, D5/D5b); every
high-severity finding below was re-verified in source by hand before being written down.
`pnpm check` is green (210 / 76 / 42). DB tests were read, not run.

---

## 1. Verdict

1. **Phases 0–6 are substantially implemented and the numbers in the loadtest README are the ones
   the code produces.** Of ~55 spec items, 40 are implemented as written, 5 are deviations with a
   written justification (ADR 0010 D6, code comments), and **10 are missing without a recorded
   decision** (§3). PROGRESS.md still says Phase 5's containers are "not done"; they landed in
   `0d2c4cb`/`b386a77` — the log is one row stale.
2. **One critical defect: the worker's admission control is a no-op.** `JobRequest.accept()` in
   `@livekit/agents@1.6.4` calls `#onAccept` without awaiting it (`dist/job.js:468-471`), so
   `admitting` in `apps/voice-worker/src/agent.ts:341-357` is decremented in the same task it was
   incremented in, and `inFlight()` collapses to the stale `activeJobs` the fix was written to
   replace. Under a burst that exhausts the warm pool (each further launch blocks ~1.8 s behind
   `initMutex`), the worker admits past `WORKER_MAX_JOBS`. The 2026-08-28 shed probe (3 calls at
   `MAX_JOBS=1` → 1 admitted) does not discriminate — the rooms were created over separate HTTP calls
   and the same result follows with `admitting` deleted. ADR 0010 Decision 2 and `patches/README.md`
   describe a behaviour the code does not have.
3. **Four high-severity defects in the observability layer make instruments lie in the direction
   of "fine":** `/readyz` cannot fail for a loop that errors on every tick or never registered;
   the worker's `production` flag reads an env var nothing sets, so the fleet's `--allow-dev` gate
   passes a dev-mode worker; the one log line the audit named as uncorrelated is still uncorrelated
   while its comment says otherwise; and migration 0005 cannot degrade to a warning as its comment
   claims — on a Postgres without `pg_stat_statements` preloaded (which is what CI runs) the
   migrator's single transaction is poisoned and boot fails.
4. **The main worker process still loads a native addon it never uses.** `import * as silero`
   at `agent.ts:18` pulls `onnxruntime-node` in at module scope (measured: +73.8 MB RSS), in the main
   process and again in every job process — the same class of defect W1 removed for
   `local-inference`. W11 (native VAD) deletes the import entirely; until then a dynamic import
   inside `prewarm` is a one-line fix.
5. **The compose `worker` service defaults to `WORKER_MAX_JOBS=8` under `mem_limit: 3g`.** The
   file's own comment sizes 3 GB for four calls. At eight, the arithmetic is ≈ 4.4 GB and the cgroup
   kills the whole worker — all in-flight calls — under exactly the N=10 load the spec's acceptance
   bar names.

---

## 2. Defects, ranked

Severity: **C** critical (measured claim is false / data loss / outage under target load), **H** high
(an instrument lies or a boot/CI path is broken), **M** medium, **L** low.

| # | Sev | Where | Defect | Failure scenario | Fix |
|---|---|---|---|---|---|
| 1 | C | `apps/voice-worker/src/agent.ts:341-357`; `agents/dist/job.js:468-471` | `admitting` is always 0 when the next request is evaluated: `accept()` does not await `onAccept`, so the `finally` runs before the SFU assignment round trip and before `launchJob` sets `runningJob` | Burst after the 4 warm slots are consumed: every request inside the ~1.8 s cold-start window sees stale `activeJobs` and is accepted; at N=10 vs `MAX_JOBS=8` the worker admits past 8 | Increment, `void req.accept()`, then block until `server.activeJobs.some(j => j.job.id === req.id)` or ~8 s; decrement in `finally`. Add a unit test with a fake `JobRequest` whose `accept()` resolves immediately — the voice worker has **no test directory at all** |
| 2 | H | `packages/control-plane/src/db/migrations/0005_measure_and_hot_rows.ts:26-33`; `.github/workflows/ci.yml:11-21` | `catchAll` on `CREATE EXTENSION pg_stat_statements` swallows the Effect error but the Postgres session is in `25P02`; the migrator runs all migrations in one transaction, so the next `ALTER TABLE` dies and boot fails. CI's `postgres:16-alpine` has no `shared_preload_libraries` | `pnpm test:db` in CI fails on migration; any managed Postgres without the extension cannot boot the server, the opposite of the comment's intent | Run the `CREATE EXTENSION` in a nested `sql.withTransaction` (savepoint), or gate on `current_setting('shared_preload_libraries')`; add the flag to the CI service |
| 3 | H | `apps/server/src/main.ts:90-97`; `ProcessMetrics.ts:108-116` | `catchAll` precedes `zipLeft(process.tick(...))`, so a loop that fails every tick still stamps `last_tick_at`; and a loop that dies before its first completed tick never enters the `ticks` map, so `staleLoops()` is `[]` | Outbox with bad credentials or a broken judge model: `/readyz` green forever. First-run `orDie` defect: `/readyz` reports `loops: []` and ready for the life of the process | Register loops with `lastTickAt: null` at construction and treat null as stale after one interval; stamp only on the success path; add a `consecutive_failures` gauge and a handler-level test |
| 4 | H | `apps/voice-worker/src/agent.ts:384`; `fake-borrower-fleet.ts:102-106` | `production: process.env["LIVEKIT_DEV_MODE"] !== "1"` — nothing in the repo, the SDK, `.env`, scripts or Dockerfiles sets that variable | `pnpm dev:worker` heartbeats `production: true`; the fleet gate built to refuse a dev-mode worker passes it; every number from such a run is booked as a `start`-mode measurement. Same hole for `start --simulation` (`loadThreshold` forced to `Infinity`) | Derive from the resolved `ServerOptions.production` / `process.argv`; also report the *effective* `load_threshold`, not the env value |
| 5 | H | `packages/control-plane/src/http/TurnRunner.ts:150-164` | `annotateLogs` is piped *before* `matchCauseEffect`, so `logError("turn failed after start")` at `:164` runs outside the annotation (verified: `annotations: []`). The comment at `:143-148` claims the opposite | Under load, the one failure line where interleaved calls collide carries no `conversation_id`/`turn_id` | Move `annotateLogs` after `matchCauseEffect`; add a `Logger.replace` test asserting both ids on the failure line |
| 6 | H | `apps/voice-worker/src/agent.ts:18` | Top-level `import * as silero` loads `onnxruntime-node` (native) in the main process and every job process; used only in `prewarm` | +73.8 MB RSS per process, measured; the idle-tree table's `worker-main 115 MB` includes it | `await import(...)` inside `prewarm`, `import type` for the cast; re-take the idle tree. Superseded by W11 |
| 7 | H | `docker-compose.yml:138,143` | `WORKER_MAX_JOBS` defaults to 8 under `mem_limit: 3g`, which the comment sizes for four calls | N=10 container run: ≈ 4.4 GB demanded, cgroup kills the worker and every call on it; per-job 800 MB limits do not help (8 × 800 > 3 g) | Default to 4 in compose or raise to ~5g and write the arithmetic beside it; a script asserting `mem_limit ≥ idle + max_jobs × per_call` |
| 8 | H | D5 "incremental replay" | Not built and not recorded. T2 re-reads the whole ledger (`Orchestrator.ts:569`) and `executeTool` replays a third time (`:235`); `applyEvent` (`domain/replay.ts:59`) has no caller outside `replay.ts`. ADR 0010 D6 records two omissions; this, the largest remaining D5 item, is not one of them | "No growth with call length" (the D5 heading) is still false: per-turn DB work is O(events) twice | Either build it (with the fold-equals-replay property test the spec required) or record the decision in ADR 0010 |
| 9 | M | `apps/server/src/main.ts:89-96`; `Outbox.ts:369-381` | Ticks are stamped after `drain` completes; `drain` runs up to 10 batches × 20 jobs, and with the judge on a single batch waits tens of seconds at concurrency 4; stale after 15 s | A *busy* outbox flips `/readyz` to NOT READY — the signal fires hardest when the fiber is healthiest | Stamp per batch inside `runOnce`, or bound `drain` by wall clock |
| 10 | M | `harness-scores.ts:81,87,108`; `migrations/0002_scores.ts:44-45` | O8 fallback posts every per-turn `stt.wer`/`latency.response_ms` with `turn_id: null`; the score key is `NULLS NOT DISTINCT` + upsert | Any fleet call where a barge-in adds an unmeasured turn row: N per-turn scores collapse to one (last write, the mean) with `written` still reading N+1 | Resolve real ids from the `turn_start` frame (what the spec asked), or make the fallback names distinct, or at least log the collapse |
| 11 | M | `Scheduling.ts:113,174` | `dispatchAgent` (HTTP to LiveKit) runs inside `sql.withTransaction` after `startCall` has written and locked rows — the pattern ADR 0003 forbids | A slow LiveKit holds a Postgres transaction and the conversation row on the loop that also serves callbacks; twenty such actions serialise | Commit, dispatch outside, record the result in a second short transaction (`NEVER_SERVED` covers the crash window) |
| 12 | M | `Quality.ts:264`; `console/views/status.ts:226`; `quality.test.ts:325` | `pass: breaches.length === 0` — a window with nothing measured is a pass; the console badges it "SLO MET"; the test pins it | Fresh DB or a window of simulated calls shows green | Tri-state verdict `pass | breach | insufficient`; fix the test |
| 13 | M | `packages/domain/src/redact.ts` | Bare integer amounts ("I can pay 550"), hyphenated identifiers (`555-123-4567`) and numeric JSON leaves (`{"balance_due": 1250}`) are not masked | Account data reaches Langfuse in the exact phrasing the fleet script uses | Currency-adjacent integer rule, digit-group rule, key-allowlisted numeric leaves; extend `spanMask.test.ts` |
| 14 | M | `Outbox.ts:320-326, 148` | The comment "jobs belong to different conversations" is false: `enqueuePostCall` inserts a conversation's whole set with one `available_at`, so they land in one batch and run concurrently; the ledger is read *before* the transaction, so sibling B's snapshot omits sibling A's `OUTBOX_PROCESSED`. Benign today only because no reducer reads that event type — an invariant nothing states or tests | Any future job that writes an event another job reads silently diverges | State the invariant in a test, or claim per-conversation |
| 15 | M | `migrations/0006:91,110-119` | Bare `CREATE INDEX` while the comment tells operators to build them concurrently by hand first — which makes the migration fail with `42P07` and (defect 2) roll back the set | Following the migration's own advice prevents boot | `CREATE INDEX IF NOT EXISTS` |
| 16 | M | `TurnRunner.ts:88-99` | `gc()` runs only from `run()`; nothing sweeps at idle, and the `t.done` predicate never bounds a turn whose fiber never finishes | `feather_lite_live_turns` never returns to zero after a run; a wedged decider stream retains its deltas forever; the soak's RSS slope cannot separate this from real growth | Scoped repeating sweeper (the spec's fiber-scoped expiry) plus a hard ceiling for `done === false` |
| 17 | M | `agent.ts:381-403` | Heartbeat `idle_processes` is the configured constant, never the pool's real count; `admitting` is structurally 0 (#1) | Phase 4's "heartbeat shows idle procs" verification cannot show a pool that failed to pre-warm — the one thing W3 asked to verify live | Read the pool's actual warm count |
| 18 | M | `agent.ts:55,69`; `worker.js:167` | `numIdleProcesses || Default` — `WORKER_IDLE_PROCESSES=0` silently becomes 4; `Math.max(1, Number("abc"))` is `NaN`, so a typo'd `WORKER_MAX_JOBS` disables the ceiling (`busy >= NaN` is always false) | Misconfiguration fails open | `Number.isFinite` guards; pass `undefined`, not 0 |
| 19 | M | `scripts/stack-quiet.mjs:38-56,76-84` | Finds stray workers, prints them, and exits 0; the verdict is free-memory only | `pnpm stack:quiet && pnpm loadtest:tier2` walks into the zombie-worker trap the script exists to prevent | Non-zero exit on a stray worker with `--allow-worker`; stop matching job processes of a healthy worker |
| 20 | M | `deploy/langfuse/docker-compose.yml:145-152` | No `LANGFUSE_*` retention, no ClickHouse TTL (spec required both); Redis runs `noeviction` with no `--maxmemory` under `mem_limit: 64m` | Redis grows past the cgroup, is OOM-killed, `restart: always` loops and stalls ingestion | `--maxmemory 48mb`; retention settings verified with `find-docs` |
| 21 | L | `agent.ts:418` | `initializeProcessTimeout` still 60 s; W3 said reduce toward 10 s once cold start shrank (2 659 → 1 834 ms). No recorded reason | — | Set ~15 s, or record why not |
| 22 | L | `Sweeper.ts:88` | `neverServed = lastSeenAt === null` — a worker that claims and crashes inside its first 10 s heartbeat window is booked `NEVER_SERVED` | A genuine orphan excluded from `orphan_detect_ms` | Use the claim, not the heartbeat, as the "was served" signal |
| 23 | L | `ProcessMetrics.ts:137`; `prometheus.ts:89-92` | The 20 ms sampling floor is subtracted from `max` too, and published under a raw-lateness series name | A scraper comparing with `nodejs_eventloop_lag_max_seconds` sees a systematically low number | Subtract from quantiles only, or name the series as adjusted |
| 24 | L | `resources.ts:446,741-759`; `agent.ts:402` | `idle` taken from `series[0]` before the pool is warm (overstates `mb_per_call`); CPU keyed by pid without start time (Windows recycles pids — undercounts, flattering `calls_per_vcpu`); `mb_per_call` in MB (1e6) vs heartbeat `rss_mb` in MiB | — | Assert warm before `idle`; key by `(pid, start_time)`; one unit |
| 25 | L | docs/comments | `handlers.ts:145` (`histograms` deleted by O14), `main.ts:88`, `TurnRunner.ts:143-148`, `Outbox.ts:320-326`, `docker-compose.yml:13` (extension is 0005 not 0006), `fake-borrower-fleet.ts:60-64` + `Dockerfile:90-92` ("dev sets `loadThreshold` to `Infinity`" — not for this app: `agent.ts:414` passes 0.75 and it survives), `pnpm-workspace.yaml:17` (stale `minimumReleaseAgeExclude`), PROGRESS.md row 12 | Each says something the code does not do | Correct them in the same commit as the code they describe |

---

## 3. Spec items missing without a recorded decision

The spec's rule 1 is "nothing is done until it has been run" and ADR 0010 D6 is where "not built"
goes. These ten are neither built nor recorded:

| Item | Status |
|---|---|
| D5 incremental replay (T2 + `executeTool`) | not built (#8) |
| D5 memoise `toolSpecsFor` (C4) | not built — `prompts.ts:35-42` makes a JSON schema per tool per turn |
| D5 `--max-semi-space-size` A/B | not tried; profile puts GC at 6.2 % |
| D5 prepared-statement experiment (C8) | not done — the spec said "record the answer either way" |
| D5 SSE encode / delta coalescing (C6) | not built — `handlers.ts:79-84` still `Schema.encodeSync` |
| D5b HOT ratio and `n_dead_tup` in the load report | not reported — migration 0005's core claim (`n_tup_hot_upd/n_tup_upd > 0.9`) is unverified |
| D5b bytes/turn, bytes/call in the loadtest README | absent |
| D5b `pg_stat_user_indexes.idx_scan` check | never run |
| O9 `RATE_LIMIT_BYPASS_TOKEN` / per-token bucket | not built — `tier1.ts:528` still says "until O9 gives the harness a bypass token" |
| D6 Langfuse retention / ClickHouse TTL, MinIO note | absent (#20) |
| Testing Decisions: CI image job (`/readyz` against Postgres, sizes printed); CI never runs `pnpm build`, so the bundler's externals guard never runs in CI | absent |
| W1 upstream issue | not filed (`patches/README.md` says so honestly) |
| D3 `/readyz` Langfuse-flush check; worker heartbeat RSS of inference/job processes | absent (the latter justified in a comment) |

Deviations **with** a justification, accepted: `listEventsUnchecked`, `next_sequence_no` (ADR 0010),
O7 batch-posting instead of a logger hook (`Tracing.ts:200-215`), O8 positional pairing and 400
instead of 422 (comments), `postgresql.conf` as `-c` flags, W8 sample-stride instead of frame-stride
(better, and says why), TurnRunner throttled-gc instead of fiber expiry (partial, #16).

---

## 4. Test gaps the spec named

- **No test for `requestFunc`/`inFlight`** — the voice worker has no `test/` directory. The one
  concurrency mechanism Phase 4 added is covered only by a live run that cannot discriminate (#1).
- **`/readyz` fails on a stale loop**: only `staleLoops()` is unit-tested; nothing exercises the
  handler, a never-registered loop, or a long drain (#3, #9).
- **Rate-limit middleware wiring** (`rate_limited_start` vs `rate_limited_turn`) and the bypass
  token: untested / non-existent.
- **Log correlation**: no test, which is why #5 shipped.
- **Redaction**: no case for a bare integer amount, hyphenated id, or numeric JSON leaf (#13).
- **`applyEvent` fold ≡ `replay`** over the 20 scenarios: not written (the path was not built).
- **Migration against a Postgres without `pg_stat_statements`**: CI *is* that environment (#2).
- **Outbox post-concurrency ledger**: per-job results only; nothing asserts the event set (#14).
- **Main process loads no native addon**: a `process.report`/RSS smoke test would have caught #6
  and guards the W1 patch against an SDK bump.
- **Bundle externals ⊆ `--prod` dependencies**: the guard resolves from the build-stage
  `node_modules` where devDependencies exist.
- **`stack:quiet`** has no test or dry run; **compose limits** have no arithmetic check.
- `quality.test.ts:325` asserts the wrong thing (#12).

---

## 5. What is fine (one line each, so it is not re-reviewed)

Single-statement append is dense and unique under every caller (all hold the row lock; verified
`Orchestrator.ts:441,566,812,838`, `Workflow.ts:124`, `Outbox.ts:181,290`, `CallControl.ts:3`).
One-query context is semantically identical to the six selects it replaced and taken under the
lock. The W1 patch is correct in ESM, CJS and `.d.ts`, and `EOT_INFERENCE_METHOD` registers a URL
string so the main process truly never needs the addon. `UV_THREADPOOL_SIZE` is inherited by both
child kinds (`fork()` without `env` override). The memory-monitor option names are real and plumbed
through to `supervised_proc`. Bundles externalise exactly the declared `dependencies`, inline the
workspace, and the resolvability guard works. arm64 binaries exist for all three native packages.
Worker HEALTHCHECK port 8081 is right. The per-core budget formulas match D1. The soak's
scheduled-arrival sleep does not drift. Percentile, SLO segmentation, funnel, `latency.slo_pass`,
`NEVER_SERVED`, Langfuse failure counting, `/metrics`, redaction-on-export: all implemented as
specified.

---

## 6. What to do with this

The companion spec (`docs/plans/2026-08-30-turn-taking-and-conversation-quality-spec.md`) puts #1–#7
and #9–#12 in its Phase 0, because its own gates (the fleet's dev-mode guard, `/readyz`, the
per-turn scores) are the instruments these defects bend. #8 and the §3 list are a decision for the
user: build, or record in ADR 0010 — not both, not neither.
