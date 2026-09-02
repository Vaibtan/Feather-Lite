# Spec: the full review — defects found, the harness moves into Docker, and issue #1 resumes at Phase 1

2026-09-02. For the implementing session. This spec is the output of a full review of the tree at
`cbd5dbd` (main, pushed, working tree clean but for `skills-lock.json`): the architecture and the
recorded decisions, every source package, both open specs (issues #1 and #2), the container story,
and the live stack. It **supersedes issue #2** (whose phases are complete, with one exception
recorded below) and **amends and resumes issue #1**, whose Phases 1–7 remain the plan. It does not
replace issue #1; read that spec first.

Everything below was verified against the tree or the running stack on 2026-09-02, not inferred
from the handoff. Where a reviewer's claim turned out to be wrong, §Corrections says so, because two
of them would have sent the next session chasing ghosts.

Read before touching code, in this order:

1. **Issue #1's spec** — `docs/plans/2026-08-30-turn-taking-and-conversation-quality-spec.md`.
   Ground rules, Q1–Q8, D0–D7, the phase table and "decisions the implementer should not re-open"
   all still bind, as amended by issue #2 §Amendments and by §Amendments below.
2. **Issue #2's spec** — `docs/plans/2026-09-01-handoff-review-cleanup-and-resume-spec.md`, for
   its §Amendments 1–5 only. Its phases are done.
3. `docs/loadtest/README.md`, the two 2026-09-01 sections. The N=10 numbers are the baseline.
4. ADR 0001 (the worker is a media adapter), 0003 (three-phase turn), 0008 (playout truth),
   0009 (scores), 0010 D2, D3 and D8.
5. The handoff `feather-lite-handoff-2026-09-01-issue-2-complete.md` in the user's temp directory,
   for the environment gotchas — with the corrections in §Corrections.

## State of the tree, checked 2026-09-02

- `pnpm check` green: 260 domain, 86 control-plane unit, 31 voice-worker, 45 load-test.
- `pnpm test:db`: 73 passed, 1 skipped (issue #3).
- Containers up and healthy (`postgres`, `livekit`, `server`, `worker`); `/readyz` green;
  `pnpm stack:quiet` exits 0 with 9 GB available in the VM.
- A fresh 2-call fleet run through the containers: 2/2 equivalence, WER 0.000, 0 silent playouts,
  turn latency p50 2 207 ms, worker container idle 1 084 MB → peak 1 519 MB. The run overwrote
  `docs/loadtest/2026-09-01-tier2-n2.json` (see finding H6) and the tracked file was restored.
- The running server has `JUDGE_ENABLED=true` and `TURN_DECIDER=scripted`, both inherited from the
  repo `.env` through compose variable substitution. Neither is the load-run configuration; the
  README's instruction to set them in the shell at `docker compose up` time is correct and easy to
  forget (finding P4).

## Ground rules (inherited; unchanged)

1. Nothing is done until it has been run. Every phase ends with its verification.
2. One behavioural change per commit; reasoning and before/after in the message; `code-review` on
   the diff; `commit-work`, never a bare `git commit`; `tdd` for pure modules; `diagnosing-bugs`
   for the voice path; `find-docs` before any `@livekit/agents` API; verify a reviewer's factual
   claim in source before acting on it.
3. **Everything runs in Docker, including the harness** (user directive, 2026-09-02 — this spec's
   Phase D makes it true). `pnpm stack:quiet` first; Langfuse down; `JUDGE_ENABLED=false` and
   `RATE_LIMIT_BYPASS_TOKEN` set in the shell at `docker compose up` time.
4. The four gates are unchanged; D3's amount-entity gate becomes the fifth when it lands.
   Segments never mix.
5. `@livekit/agents` stays at 1.6.4 — and is pinned exactly (finding W6).
6. Push `main` at the end of each phase.

## Problem Statement

The platform passes its own gates and the tree agrees with its documentation, and underneath that
the review found the following. The rule that decides whether a promise may be recorded passes
when the evidence is *absent*, not when it is present. An unauthenticated route can keep any
orphaned call alive forever. A claimed post-call job that dies mid-flight is never reclaimed, so
the borrower's next call loses its history silently. The scheduler re-dials every unanswered
harness call over a SIP trunk that does not exist, forever, taking a worker slot each time. The
worker reports a per-segment TTS number as the turn's, attributes playouts by a mutable field, and
says it runs adaptive interruption when it runs VAD. The harness's onset detector throws away every
sample it does not need for one number, which is the sample tier 3 needs for six. And the last
piece of the system still on the host — the harness — is the piece that decides whether every
number is comparable.

## Solution

Fix the correctness defects in the control plane and the worker first, because Phase 1 of issue #1
would otherwise take its baseline through them. Move the harness into a compose service so the
whole measured path is containers and the Windows dependencies are confined to one pre-flight
script that by nature must run outside the VM. Straighten the harness seams the tier-3 simulator
composes, then build the simulator as issue #1's Phase 1 specifies. Then Phases 2–7 as written,
with the three refactors §Amendments names done *before* D1/D2 rather than during them.

## Findings

Each carries the file it lives in, what was verified, and the fix. Severity is the reviewer's,
checked. Items marked **[verified in source]** were confirmed by reading the code on 2026-09-02;
items marked **[reviewer claim, verify first]** were reported by a review agent with a citation but
not independently re-read, and the implementing session verifies them before changing anything.

### C — control plane

- **C1. The fully-heard read-back guard passes on the absence of evidence** — critical —
  `Orchestrator.ts` `record_promise_to_pay` branch. [verified in source] `heardFully` is "no
  `AGENT_TURN_PLAYOUT` for the read-back turn says `interrupted`", so a read-back whose playout
  report never arrives (worker killed after speaking, signal POST failed, job process died) records
  the promise. ADR 0008's fix covers a report that arrives wrong, not one that never comes. **Fix:**
  on `channel: "voice"`, require positive evidence — a playout for `read_back_turn_id` with
  `interrupted: false` and non-empty `heard_text`; keep the vacuous pass for `simulated`, where no
  reporter exists by design. Three orchestrator-level DB tests: reported interrupted → rejected and
  repeated; reported heard → recorded; **no report → rejected** (today it records).
- **C2. `/api/agents/heartbeat` is unauthenticated and un-rate-limited** — high — `app.ts`
  security middleware's `open` list. [verified in source] The handler upserts
  `conversation_liveness` for any conversation ids the caller names, which is exactly the column
  the orphan sweeper filters on. Anyone reaching the port keeps any call un-swept and its borrower
  blocked. The worker already sends a bearer for `/turn`. **Fix:** remove the path from `open`; the
  worker presents the same bearer on heartbeats. A DB test that an unauthenticated heartbeat is 401
  when a token is configured.
- **C3. Claimed outbox jobs and scheduled actions are never reclaimed** — high —
  `repos/scheduling.ts` claim statements. [verified in source] `CLAIMED` is written by two UPDATEs
  and read by nothing; `claimed_at` is written and never read. A SIGKILL or OOM during a drain
  leaves up to twenty jobs `CLAIMED` forever: no SUMMARY (so no `wrap_up` for the next call), no
  EVALUATION, no judge, and a console that cannot tell stuck from in flight. **Fix:** a lease — the
  claim predicate becomes `status = 'PENDING' OR (status = 'CLAIMED' AND claimed_at < now − lease)`
  with a `retry_count` bump — or a reaper on the existing tick. Test: a job claimed by a "dead"
  process is re-claimed after the lease.
- **C4. The scheduler re-dials every unanswered voice call over a SIP trunk that does not
  exist** — high — `Scheduling.ts` `prepare`, `mode: "sip"`. [verified in source and observed live]
  A harness call that ends `NO_ANSWER` or `NEVER_SERVED` schedules `RETRY_CALL`; the retry is
  dispatched in `sip` mode; the worker has no trunk (`sip_not_configured`), hangs up, the call
  finalizes `NO_ANSWER`, and it is rescheduled again until the 7-in-7 cap. The running database
  holds 55 done and 26 pending; the worker log shows 15 such dispatches in the last hour. Each one
  creates a room, takes a worker job slot (it counts against `WORKER_MAX_JOBS` and the admission
  ceiling), and can land inside a fleet run. `hasMediaPlane(cfg)` checks LiveKit only; the SIP
  trunk is worker-side config the control plane never sees. **Fix:** the control plane learns
  whether outbound dialling is possible (`LIVEKIT_SIP_OUTBOUND_TRUNK_ID` in `AppConfig`, or a
  capability on the heartbeat); a voice re-dial with no trunk is `FAILED / NO_SIP_TRUNK` at
  `prepare` time without a conversation row; and a call originated by a harness or browser
  session (mode `browser`) is never re-dialled as `sip`. Test: `RETRY_CALL` with no trunk settles
  `FAILED` and creates no conversation. Then clear the 26 pending rows.
- **C5. A turn re-sent under its own id while still RUNNING is permanently 409'd** — high —
  `claimTurn` predicate `active_turn_id IS NULL`. [verified in source] Masked today by
  `TurnRunner`'s process-local map for 60 s. D1's `held` increases duplicate-turn traffic by
  design. **Fix:** `active_turn_id IS NULL OR active_turn_id = ${turnId}`, treated as attach.
  Test: re-sending the active turn id attaches rather than 409s.
- **C6. A subscriber attached during T1 hangs forever when T1 fails** — high —
  `TurnRunner.ts` T1-failure branch. [verified in source] The branch deletes the key and fails the
  deferred but never broadcasts `END` to subscribers already attached, so the second client's SSE
  stream never terminates. **Fix:** broadcast `END` (or the error frame) and clear subscribers
  before deleting. Test with two subscribers and a failing T1 under `TestClock`.
- **C7. `turn_metrics` takes the conversation row's `FOR UPDATE` and reads the whole ledger** —
  medium — `processSignal`. [reviewer claim, verify first] The signal writes one idempotent row
  and needs neither. On a barge-in it lands exactly when the next turn's T1 holds the lock.
  **Fix:** skip the lock and `listEvents` for `turn_metrics`.
- **C8. `AGENT_TURN_PLAYOUT` can be written twice for one playout with no resolution rule** —
  medium — T1's `playout` field and the `playout` signal. [reviewer claim, verify first] The
  guard, `silentPlayoutTurnIds` and `tts_silent` each resolve a disagreement differently.
  **Fix:** one rule in `domain` (last report wins, or first), used by all three; append only
  when it changes the answer.
- **C9. A superseded turn re-sent under the same id half-executes** — medium — T1 idempotency
  replays only `DONE`. [reviewer claim, verify first] **Fix:** `SUPERSEDED` is terminal for
  idempotency; the retry fails explicitly.
- **C10. Turn fibers are daemons; shutdown strands `active_turn_id`** — medium —
  `TurnRunner` `forkDaemon`. [verified in source] For `simulated` nothing ever releases it.
  **Fix:** a service-owned scope with a bounded drain, and a finalizer that releases turns this
  process claimed.
- **C11. `/readyz` cannot fail on pool exhaustion** — medium — the probe's `SELECT 1` has no
  timeout, and an empty loop registry reads ready. [reviewer claim, verify first] **Fix:** a
  2 s timeout failing `ApiUnavailable`; assert a non-empty expected loop set where schedulers are
  configured.
- **C12. Outbox backoff is stamped from the claim clock** — medium — `Outbox.runOnce` reads
  `now` once and reuses it for `availableAt` after a failure a minute later. [reviewer claim,
  verify first] This is issue #3's defect one layer down. **Fix:** wall clock at failure time for
  `availableAt`; app clock for `processedAt`.
- **C13. A polite goodbye without a tool books the call `FAILED` and re-dials** — medium —
  `outcome === null && nextState === "ENDING"` → `FAILED`. [reviewer claim, verify first] It
  conflates "no disposition" with "system failure" and pollutes the funnel's failed count.
  **Fix:** a distinct reason (`NO_DISPOSITION`) that does not schedule a re-dial by default.
- **C14. Issue #3 — the skipped outbox test.** [verified in source; candidates read from the
  issue] The correct fix is the issue's second candidate: wrap the test body in the existing
  `withFrozenClock("2026-08-16T09:00:00Z")` seam and drop the explicit `now` arguments, so
  `startCall`, the finalize (where `enqueuePostCall` stamps `available_at`) and `runOnce` share
  one instant and the `09:00Z == 14:30 IST` window survives. Add the assertion that
  `available_at` equals the frozen instant so a future divergence fails loudly. Not candidate 1
  (a test-only parameter on the hottest signature, and it would not cover `runOnce`'s own
  `DateTime.now`); not candidate 3 (green by accident, the same accident that made it pass until
  2026-08-16). **Needs the user's approval** (Q4 below); the diagnosis is not in dispute.
- **C15. Secrets compared with `===`; fixed-window bucket count unbounded** — low —
  `app.ts`, `rateLimit.ts`. **Fix:** `timingSafeEqual` for the bearer and bypass token; cap the
  count.

### W — voice worker

- **W1. `interruption.mode: "adaptive"` is a request the self-hosted profile cannot honour** —
  high — `agent.ts` session options. [verified in source] Issue #2 amendment 1 recorded that
  every job falls back to VAD interruption (401 from the Cloud detector) and said "D5.1 becomes a
  config correction"; the correction was never made. Every barge-in number, including Phase 1's
  coming baseline, is a VAD number produced by a config that says otherwise. **Fix:** `mode:
  "vad"` on the plugins profile with a comment naming the 401, env-selectable for Cloud. Verify
  on one call that the fallback log line no longer appears.
- **W2. `turn_metrics` is posted once per TTS segment, not per turn** — high —
  `feather-agent.ts` `onTtsMetrics`. [verified in source that one signal is sent per
  `tts_metrics` event; the per-segment emission is a reviewer claim citing
  `agents/dist/tts/tts.js`, verify first] The ledger's `tts_ttfb_ms`, `tts_audio_ms` and
  `tts_chars` are the *last segment's* values, and the chars-per-second heuristic measures
  sentence length. The 385 ms TTFB p50 in the N=10 table is the last segment's, not the turn's
  first byte. **Fix:** accumulate per turn (first segment's TTFB, summed audio and chars) and post
  once when the turn's item lands. Re-take N=5 and record the before/after on `tts_ttfb_ms`.
- **W3. `reportPlayout` attributes an item by the mutable `currentTurnId`** — high —
  `feather-agent.ts`. [verified in source] ADR 0008 records this as a residual on eight clean
  runs. Tier 3's `withPlayoutTruth` joins by time so the join survives a mis-stamp, but
  `truncated` is read off it and two of the six metrics invert on one wrong flag. **Fix:** the
  per-item mapping ADR 0008 names — a map from the speech handle created in `llmNode` to its turn
  id, looked up by item id. Do before Phase 1's baseline.
- **W4. A `say`-only or mixed turn reports a partial `heard_text`** — medium — [reviewer claim,
  verify first] With no `delta` frames no assistant item is created for the reply, so
  `reportPlayout` fires on the first `say` item and `lastReportedTurnId` suppresses the rest.
  The read-back guard then judges against a partial record. **Fix:** aggregate every assistant
  item between `llmNode` entry and the next turn into one playout signal.
- **W5. Five env knobs bypass the fail-closed parser written to justify them** — medium —
  `agent.ts` `Number(process.env[...])` for `WORKER_LOAD_THRESHOLD`, the two VAD thresholds and
  the two job-memory bounds. [verified in source] A typo'd threshold removes shedding; a typo'd
  memory limit removes the limit and the SDK logs "advisory only". **Fix:** `parseRatio` and
  `parseCount` in `env.ts` with table tests, and a `WORKER_INTERRUPTION_MIN_DURATION_MS` knob
  through the same parser (D5.2 has no knob today). Add `WORKER_LOAD_THRESHOLD` to the compose
  worker service and have `composeLimits.test.ts` read it instead of hard-coding 0.75.
- **W6. `@livekit/agents` is `^1.6.4`, not pinned** — low — `apps/voice-worker/package.json`.
  [verified in source] The patch is keyed on the exact version; a resolution drift drops it with
  a warning. **Fix:** exact pin, like the Deepgram plugin.
- **W7. Job processes ignore SIGTERM — upstream, not ours** — record, do not fix —
  `agents/dist/ipc/job_proc_lazy_main.js` installs its own no-op SIGTERM/SIGINT listeners, and
  `supervised_proc.js` uses `proc.kill()` (SIGTERM) as its fallback for a wedged job, a failed
  initialize and the memory-limit `close()`. [verified in the installed dist] So on Linux — the
  container that ships — the per-job memory ceiling and the unresponsive-job watchdog depend on
  the IPC shutdown path, and a job that ignores IPC cannot be killed by the framework. The repo's
  own `process.once(SIGTERM, abandonWaits)` in `agent.ts` is redundant in job processes but is
  **not** the cause. **Action:** one probe (`docker exec feather-lite-worker kill -TERM <job pid>`,
  then the memory-limit path with `WORKER_JOB_MEMORY_LIMIT_MB` set low) and a line in
  `patches/README.md` and ADR 0010 D8 recording what the framework does; a `process.exit(143)`
  patch only if the probe shows a wedged job survives `close()`.
- **W8. The `tts_metrics` comment states the wrong mechanism** — low — `feather-agent.ts`.
  [reviewer claim, verify first] It fires at end of segment synthesis, not first byte; the
  silent-playout guard holds because synthesis precedes playout completion. Correct the comment
  and prefer the item's `startedSpeakingAt` if present.
- **W9. Admission: `abandonWaits` never rejects new requests** — low — `admission.ts`. A job
  offered during drain is accepted into a pool being torn down. **Fix:** `req.reject()` when
  abandoned. Dead `noInputStrikes` field and the ever-growing `pendingSays` array in
  `feather-agent.ts` go in the same commit.

### H — harnesses

- **H1. The RMS detector runs only while a reply is pending and stops at the first loud frame**
  — high, blocks tier 3 — `scripted-call.ts` audio loop. [verified in source] Every other frame
  is counted and discarded; there is no per-frame sample store and no onset callback. **Fix:**
  hoist RMS out of the pending guard; store `{ atMs, rms }` for the whole call (anchored to a
  monotonic sample counter, not `Date.now()` per chunk); an inline hangover state machine that
  emits `onStretchStart(k, atMs)` / `onStretchEnd`; `pending.audioAt` becomes a consumer.
  `SPEECH_RMS` is imported from `speechWindows.ts`, not duplicated. Return the samples on the call
  result so `speechWindows()` runs once post hoc, pure, and the live *k* is reconciled against the
  post-hoc index (fail the run if they disagree).
- **H2. The audio and transcript handlers subscribe to every participant** — medium, blocks
  D4's third-party scenario — `scripted-call.ts` `TrackSubscribed` filters on kind only;
  `fromAgent` is `identity.startsWith("agent")` for transcripts. [verified in source] A second
  participant's speech would be booked as agent stretches. **Fix:** key streams by identity; only
  agent identities feed RMS; only the borrower's identity feeds WER.
- **H3. `matchLedgerTurns` sorts with `NaN` in the comparator** — medium — `harness-scores.ts`.
  [verified in source] An abandoned line carries `atMs: NaN` and reaches `.sort`, which permutes
  the whole array; every per-turn score can then land under the wrong turn, silently — the
  failure the file's own note says is the worst kind. **Fix:** filter `Number.isFinite(atMs)`,
  count the drops into `unjoined`, bound the last window by the call's end. Test with a `NaN`
  line.
- **H4. The fleet's capacity gate is a warning; a shed call's WER is scored 1.000** — medium —
  `fake-borrower-fleet.ts`. [verified against the N=10 first attempt in the loadtest README]
  **Fix:** refuse when `CALLS > floor(maxJobs × threshold)` unless `--allow-shed`; exclude
  never-served conversations from the WER denominator and say so in the report.
- **H5. One harness request is bare `fetch`** — low — `scripted-call.ts` `GET /api/borrowers`
  without `harnessHeaders()`. **Fix:** route through `harness-http.ts`.
- **H6. The report filename is date and N only; unknown flags are ignored** — low —
  `fake-borrower-fleet.ts` writes `${date}-tier2-n${CALLS}.json`; a second run the same day
  overwrites the first, and `--label` is silently accepted and unused. This overwrote the tracked
  N=2 report during this review. **Fix:** a required `--label` that lands in the filename; refuse
  unknown flags.
- **H7. Nothing is seeded and there is no seam for a seed** — medium, tier-3 prerequisite —
  no RNG anywhere in `tracer/`. [verified] The turn-taking table is data (Q2), so offsets need no
  PRNG; audio degradation does. **Fix:** a `mulberry32`-style generator in `domain` with a table
  test; `--seed` on the tier-3 CLI; the seed in the report.
- **H8. `SCORE_NAMES` is closed and has none of the tier-3 names** — medium — `scores.ts`.
  [verified in source] `turn.response_rate`, `turn.yield_rate`, `turn.yield_latency_ms`,
  `turn.false_interrupt_rate`, `turn.agent_interrupt_rate`, `turn.selectivity`,
  `turn.barge_in_t90`, `stt.entity_er` would all be rejected by `POST /scores`. **Fix:** add the
  eight names and their data types in the same commit as the first consumer.
- **H9. `runScriptedCall` is one 350-line function with the script inlined** — medium, the fork
  risk D4 warns about — `scripted-call.ts`. [verified in source] Five scenarios cannot be driven
  through hard-coded regexes and sleeps. **Fix:** extract `bootstrapRoom` (export it),
  `loadScriptedLines(persona)`, and a `BorrowerScript` interface over a `CallContext`
  (`speak`, `onStretchStart`, `waitAgentSaid`, `agentSaid`); the current script becomes one
  implementation. `borrower-proc.ts`'s request gains `scenario` and `seed`.
- **H10. `readWav` reads chunks positionally** — low, blocks the involuntary-sound asset —
  `line-cache.ts` assumes data at byte 44. **Fix:** a chunk walker; a test with a `LIST` chunk.
- **H11. `withPlayoutTruth` is not the same join as `harness-scores.ts`** — low —
  `speechWindows.ts` docstring. [reviewer claim, verify first] No clock grace, no
  claim-at-most-once, and stretches with no turn behind them (`safeFallback`, the no-input line,
  any `say` with `allow_interruptions: true`) are booked `truncated: false` silently — on the
  hold-request scenario that is the number under test. **Fix:** `CLOCK_GRACE_MS`, and an explicit
  `truncated: null` (unknown) for a stretch with no playout, excluded from the rates and counted.
- **H12. The chaos probe's host branch matches `src/agent.ts`, which only exists in dev mode;
  its container branch parses stdout loosely** — low — `chaos-orphan.ts`. **Fix:** match
  `job_proc_lazy_main` on the host too; parse the last stdout line. Then run the containerised
  verdict once and record it — the one issue #2 item never done (commit `8e0d87e` claims a record
  that does not exist).
- **H13. The shed probe counts an `HTTP_500` as served and `NOT_STARTED` as neither** — low.

### D — Docker-only

The two app images have no host dependency. What remains on the host, with the verdict:

| Piece | Verdict |
|---|---|
| The borrower harness (tier 1, tier 2, coming tier 3) under `tsx` on the host | **Move into a compose service** (Phase D). |
| `resources.ts` win32 PowerShell sampler | Keep for native comparison runs; re-scope its comment. In a container the procfs path sees only the harness's namespace; the container basis (`docker stats` + cgroup `cpu.stat`) is already primary and needs the socket. |
| `stack:quiet` | **Stays a host script by necessity**: the WSL VM's memory ceiling and `.wslconfig` cannot be read from inside the VM. Its stray-host-worker check becomes a stray-*container* check (exactly one worker container; agent count on `/status` is 1). Re-derive the 3 GB threshold once the harness is inside the VM. |
| `pnpm start:*`, `dev:*`, `tunnel`, `db:up` etc. | Keep, documented as host-only. Settled in issue #2 ("the six docker-audit keeps"); not reopened. |
| `Profiler.ts` / `PROFILE_SECONDS` | Keep as a feature; correct the comments that call it a Windows workaround. |
| `Tee-Object`, `Get-NetTCPConnection` advice in older specs | Moot with `docker compose logs`; no code uses them. |
| The native VAD arena on win32 | Moot for the product; `vad-cost.ts` needs a dev image to re-take. Low priority. |

Media path: **no change needed.** The LAN-address ICE candidate already serves a container peer —
the worker container and CI both prove it. A harness container reaches it the same way. The
alternative (`rtc.addresses` listing both the LAN and the compose-network address, dropping
`--node-ip`) would remove the NAT hairpin and keep the browser demo working, and is worth one
empirical trial, but it is optional and comes after Phase D works on the current setting (Q2).

### P — process and documentation

- **P1.** README's test-count lines (`pnpm check # domain 94, control-plane 30`, `29 DB tests`)
  disagree with its own status table and with the tree (260/86/74). PROGRESS.md row 13's status
  text predates C2 and Phase 1.
- **P2.** The N=10 report JSON carries no SLO verdict and no compliance-score block; two of the
  four gates exist only in README prose. The report schema gains both (tier 3's schema does too).
- **P3.** `turnTaking.ts` and `speechWindows.ts` are exported, tested and unconsumed. README's
  domain row says "turn-taking metrics: done" without the segment caveat user story 35 asks for.
- **P4.** Compose interpolates `JUDGE_ENABLED`, `TURN_DECIDER` and `LANGFUSE_ENABLED` from the
  repo `.env`, so the running server has the judge on. A `compose.loadrun.env` (or a documented
  `env -u`) makes the load-run configuration a file rather than a memory.
- **P5.** `CONTROL_PLANE_URL` (worker, fleet, chaos) versus `LOAD_TEST_API` (tier 1) name the
  same thing. Unify on `CONTROL_PLANE_URL` while writing the harness service.
- **P6.** A stale `feather-lite-agent-container` heartbeat row from 2026-08-28 is still listed on
  `/status`; rows older than a day should age out of the agents list.

## Corrections to the handoff and to this review's own agents

- **"1-in-7 silent playout"** in the handoff does not exist in the tree or in `git log -S`. The
  real figure was 1-in-18 (ADR 0009, `ff25a21`), fixed, and every run since reads zero. Do not
  chase it.
- **The SIGTERM finding** (W7) was first reported as a repo defect; the SDK installs the same
  no-op handlers itself. It is upstream.
- **"The worker is a thin media adapter"** is ADR 0001, not 0002.
- **Commit `8e0d87e`** says the containerised chaos verdict was "recorded with the rest of the
  Phase C1 live checks"; no such record exists. H12 closes it.

## Decisions taken 2026-09-02 (defaults; the user may revisit — see Questions)

| # | Decision |
|---|---|
| R1 | **Correctness before baseline.** Phase C (C1–C6, W1–W3, W5) lands before issue #1's Phase 1 takes its turn-taking baseline, because the baseline reads `truncated` from W3's attribution and `tts_ttfb_ms` from W2's aggregation. |
| R2 | **The harness is a compose service with its own image**, built from the dev dependency set (sources, `tsx`, the docker CLI), under `--profile harness`, with the docker socket read-only, bind mounts for `docs/loadtest/` and the WAV cache, `env_file: .env` plus compose-network URLs, and `depends_on: worker (healthy)`. `feather-lite-worker:local` cannot host it (`--prod` drops the sources and `tsx`). |
| R3 | **`LIVEKIT_NODE_IP` stays the host LAN address** for Phase D's first run. `rtc.addresses` is a follow-up trial, not a prerequisite. |
| R4 | **`stack:quiet` remains on the host** and is the only Windows-aware script left. Its stray-worker check reads the container list and `/status`. |
| R5 | **Positive evidence for the read-back guard on voice; vacuous pass on simulated.** The scenario suite has no playout reporter and must keep running. |
| R6 | **No re-dial without a trunk, and never `sip` for a harness- or browser-originated call.** |
| R7 | The three pre-D1/D2 refactors are their own phase (Phase F), not folded into D1: one `Orchestrator` instance in the process, a uniform decide-phase result carrying `decider`, and a turn-level predicate through the SLO segment. |
| R8 | Native-comparison scripts and the dual sampler paths stay (issue #2's decision), documented as host-only. |

## Questions for the user (the grilling round; defaults above apply if unanswered)

- **Q1 — Harness in Docker.** Confirm R2. The cost is a second image (~600 MB dev tree), the docker socket in a container, and one unmeasured latency term (container → NAT → host NIC → NAT → container for media) that Phase D measures against the host-harness N=5 before any SLO delta is trusted. The alternative is the status quo, with the harness the one host process.
- **Q2 — Node IP strategy.** R3 (keep the LAN address, trial `rtc.addresses` later) versus trying `rtc.addresses` first. Recommendation: R3.
- **Q3 — SIP re-dial.** R6 fails the retry at `prepare` with no conversation row. The alternative is to keep scheduling and let the worker fail fast, which is what happens today and what fills the ledger. Recommendation: R6, plus clearing the 26 pending rows.
- **Q4 — Issue #3.** Approve fixing it with candidate 2 (`withFrozenClock` over the whole test). Ground rule 5 of issue #2 said "ask"; this is the ask.
- **Q5 — Guard semantics on `simulated`.** R5 keeps the vacuous pass for the JSON path. The alternative is a synthetic playout event from the scenario runner, which makes the guard uniform and the suite slightly less honest about what it exercises. Recommendation: R5.
- **Q6 — Order of C13.** "Goodbye without a tool" is behaviour the scripted scenarios may depend on. Confirm it should stop re-dialling, or defer it to Phase 3 where D2's `affirm`/`deny` change the same code.
- **Q7 — Issue #1 phases 5–7.** Unchanged, and "stop after Phase 4 if out of time" still applies. Confirm.

## Implementation Decisions

### Phase C — control-plane and worker correctness

One commit per finding, finding id in the message, before/after where a number moves.

- C1, C2, C3, C4, C5, C6 as specified; C7–C13 after verifying the claim in source (the commit
  message says what was verified); C14 on Q4; C15.
- W1, W2, W3, W5, W6 as specified; W4 and W8 after verification; W7 as a probe plus a record; W9.
- The `interruption.minDuration` knob (in W5) is what Phase 2's D5.2 A/B turns.

Verification: `pnpm check` and `test:db` green (74/74 if Q4 approved); the three guard tests; a
heartbeat without a bearer is 401; a `RETRY_CALL` with no trunk settles `FAILED` with no
conversation; the pending re-dials are gone and the worker log shows no `sip_not_configured` in
an hour; one call's log shows no adaptive-interruption fallback; an N=5 run's `tts_ttfb_ms` before
and after W2, recorded.

### Phase D — the harness moves into Docker

- `apps/harness/Dockerfile` (or a `harness` target in the worker's): `node:22-bookworm-slim`,
  `pnpm install` with dev dependencies, the docker CLI, `tsx` on the path; runs as `node`.
- A `harness` compose service under `profiles: ["harness"]` with the mounts and env in R2;
  `CONTROL_PLANE_URL=http://server:8080`, `DATABASE_URL=…@postgres:5432/…` (tier 1 resets
  `pg_stat_statements`), `LIVEKIT_URL=ws://livekit:7880`, `RATE_LIMIT_BYPASS_TOKEN` identical
  to the server's, and — new — the harness asserts `harnessBypassConfigured()` rather than
  merely recording it.
- Root scripts `loadtest:tier1:docker`, `loadtest:tier2:docker`, `loadtest:idle:docker`
  (`docker compose --profile harness run --rm harness …`); the host scripts stay as the
  native-comparison arm.
- `resources.ts`: the harness container gets its own row in `DEFAULT_CONTAINERS` so harness and
  worker CPU are on one basis; `validateReport` fails a run whose container basis has no
  `feather-lite-worker` row; the report stamps `basis: "container"` and the harness location so
  archived `platform: "win32"` reports remain comparable by name.
- `stack:quiet`: stray-container check; threshold re-derived with the harness inside the VM.
- `classifyProcess` learns `sim-borrower`.
- CI's `images` job additionally runs `tier1 --concurrency 5` through the harness service, so the
  artefact that measures is built and booted too.

Verification: an N=5 tier-2 run from the harness container, 5/5 equivalence, WER ≤ 0.20, zero
silent playouts, with the resource block naming the harness container; the same N=5 from the host
harness the same hour; the two `total_ms` p50s and the media-path delta written into
`docs/loadtest/README.md` as the containerised-harness baseline. `pnpm stack:quiet` green with the
harness container up. CI green with the harness step.

### Phase H — the harness seams tier 3 composes

H1–H13 as specified, `tdd` for every pure piece (the hangover state machine, the `NaN` filter, the
PRNG, the chunk walker, the score names). H9's extraction is done under `codebase-design` before
the first line of `sim-borrower.ts`.

Verification: tier-2 N=5 unchanged after the extraction (the script is the same script); the
onset stretches from a tier-2 call, run through `speechWindows()`, agree with the transcript-based
onsets within the 100 ms the 2026-08-23 measurement established; a synthetic third-party
participant's audio does not appear in the agent's stretches.

### Phase 1 — issue #1's Phase 1, as amended

Exactly issue #1 D4's first half and issue #2's "what the next session does first", on the seams
Phase H built: the seeded turn-taking table (data, not RNG), `sim-borrower.ts` composing
`bootstrapRoom`, `loadScriptedLines(persona)`, `BorrowerScript`, `line-cache`, the equivalence
runner (which now returns the playouts it already fetched), `borrower-proc`, the sampler; the
five scenarios with expected ledger shapes; the report schema with the turn-taking block, the
seed, the SLO verdict and compliance scores (P2), and an entity-block placeholder; the `harness:
"sim"` column beside `conversations.decider`, set from the session-create payload, excluded from
the default SLO segment.

Verification: issue #1's — tier 3 green on the clean persona; the six numbers and T90 reported for
the current system, labelled as VAD-interruption numbers (W1); yes-during-read-back reproduces the
repeated read-back (conversation `da3dcff9-…` in the local database is the shape to match).

### Phase F — the refactors D1/D2 need (before Phase 2)

- One `Orchestrator` in the process: hoist it into `ServicesLive`; `Sweeper` and `VoiceSessions`
  take it from context. D1's `held` waiter must have one home.
- `held` is a phase *before* T1, never inside it: read without `FOR UPDATE`, find an unreported
  non-interruptible segment, wait out `tts_audio_ms` plus a margin by polling the ledger on a
  bounded schedule inside `TurnRunner.run` (correct across replicas, touches no transaction);
  record `held_ms` in `TurnResult`. Not an in-process `Deferred` registry.
- The decide phase returns a uniform `{ decision, decider }` so override, fast path, model and
  scripted share one T2 arm; `decider` and `disposition` go in `TurnResult`, which is already
  serialised whole into `conversation_turns.result` and mirrored onto `turn_end` — no migration.
- `latencyAggregateForSegment` gains a turn-level predicate (`result->>'decider'`) beside the
  conversation-level one, so fast-path and model turns of one call report separately and `harness:
  "sim"` calls are excluded whole.
- Module-level mutable gauges (`liveTurnCount`, `subscriberCount`, the limiter, the daily cap)
  become a `Gauges` service with a zero default; the daily cap is labelled "per process, since
  boot" on `/status`.
- `processTurn` exposes T1's failure as a type, so `TurnRunner` stops re-deriving it from a
  `Cause` with `instanceof`.

Verification: `pnpm check`, `test:db`, 20/20 scenarios, tier-2 N=5 equivalence unchanged;
`turnRetention.test.ts` extended with the two-subscriber case (C6).

### Then: issue #1's Phases 2–7

Unchanged from issue #1's table, as amended by issue #2 §Amendments and by §Amendments below.

## Amendments to issue #1 (in addition to issue #2's five)

6. **D5.1 is a config correction and it is done in Phase C (W1).** Phase 2 starts at D5.2, on the
   `minDuration` knob W5 adds.
7. **D4's scenario expectations supply `truncated` from `event_timeline`'s `AGENT_TURN_PLAYOUT`
   entries via `GET /api/conversations/:id`** — not `/latency`, not `/scores` — and a stretch with
   no playout behind it is `truncated: null`, excluded and counted (H11).
8. **The tier-3 baseline is labelled a VAD-interruption baseline** in the report and the loadtest
   README, so Phase 2's A/B compares like with like.
9. **D3 is buildable on both STT paths**, verified in the installed plugin: Deepgram's
   `updateOptions` carries `keyterm`, `keywords`, `numerals`; the inference path carries them
   through `modelOptions` and its mid-session update is an underscore-prefixed internal. Check
   before building whether either re-opens the socket mid-call, and that the bundle keeps the
   internal.
10. **Every knob D5 turns is parsed through `env.ts`**, never `Number()`.

## Testing Decisions

- A good test asserts external behaviour on an existing seam: the ledger and `conversation_scores`
  after a turn or a job; the `turn_end` frame; the fleet or tier-3 report JSON; the Quality JSON;
  never SQL text, lexicon internals or worker private state. Prior art: `concurrency.test.ts`,
  `quality.test.ts`, `readyz.test.ts`, `turnRetention.test.ts`, `admission.test.ts`,
  `harness-scores.test.ts`, `composeLimits.test.ts`.
- **Control plane (DB):** the three read-back guard cases (C1); an unauthenticated heartbeat
  (C2); a stale claim re-claimed after its lease (C3); a trunkless `RETRY_CALL` (C4); re-sending
  an active turn id (C5); two subscribers and a failing T1 under `TestClock` (C6); a re-sent
  `SUPERSEDED` turn (C9); the supersede race in the *other* order (T2 wins, the barge-in's T1
  finds `final_outcome`); the outbox's retry, budget and drain-loop paths; one frozen clock over
  `workers.test.ts` (C14).
- **Worker (unit):** `parseRatio`/`parseCount` tables (W5); per-turn metric aggregation over a
  two-segment fixture (W2); item-to-turn attribution across a barge-in (W3); `abandonWaits`
  rejecting (W9).
- **Domain (`tdd`):** the hangover state machine (H1) against `speechWindows()` on the same
  samples; the PRNG (H7); `truncated: null` handling in `turnTakingMetrics` (H11); the WAV chunk
  walker (H10); the eight score names (H8).
- **Harness:** `matchLedgerTurns` with a `NaN` line (H3); the capacity refusal (H4); the report
  schema requiring the SLO and compliance blocks (P2) and, for tier 3, the turn-taking block and
  the seed; `validateReport` refusing a container basis with no worker row (Phase D).
- **Live:** every phase's verification above. Each D5 knob remains an N=5 A/B with the D4 metrics.

## Out of Scope

- Everything issue #1 lists: Flux/STT swaps, SDK upgrades past 1.6.4, LLM-driven borrowers,
  KV-cache work, TTS socket pooling beyond D5.5's measurement.
- ADR 0010 D8's recorded items, except #14 (the outbox sibling-jobs invariant) if C3's lease
  changes the claim shape — decide in that commit.
- Migrations as a separate job, `conversation_scores` FK, leader election for the sweeper (claim
  the sweep with `SKIP LOCKED` instead, if N>1 is ever run) — noted in the review, not scheduled;
  one line each in ADR 0010 D8.
- `rtc.addresses` for the SFU (a trial after Phase D, not a prerequisite).
- Deleting the native-comparison scripts or the dual sampler paths.

## Further Notes

### Suggested phase order

| Phase | What | Verification |
|---|---|---|
| C | C1–C15, W1–W9 (C14 on Q4) | listed per phase above; N=5 `tts_ttfb_ms` before/after W2 |
| D | harness compose service, sampler basis, `stack:quiet` container checks, CI harness step | N=5 from the container and from the host the same hour, both green, delta recorded |
| H | H1–H13, `BorrowerScript` extraction | tier-2 unchanged; RMS stretches agree with transcript onsets; third-party audio excluded |
| 1 | issue #1 Phase 1 on the new seams; P1–P6 doc truth in the same phase | tier 3 green on the clean persona; six numbers + T90 labelled VAD; read-back scenario reproduces |
| F | the three refactors, gauges service, typed T1 failure | all suites green; equivalence unchanged |
| 2–7 | issue #1 as amended | issue #1's table |

Push at the end of each phase. `handoff` at the end of the session, and keep its repo-state claims
true — check `git status` and `git log origin/main..HEAD` before writing them.

### Decisions not to re-open

- Issue #1's list, and issue #2's.
- The six docker-audit keeps.
- Nearest-rank percentile everywhere.
- Causation from playout truth, not time windows — and now with `null` for "no truth".
- The harness is a compose service; the media path is the LAN candidate until a trial says
  otherwise.

### Suggested skills, in order

`diagnosing-bugs` for C1–C6 and W1–W3 (each is a live-path change with a reproduction);
`tdd` for every pure module in Phases C, H and 1; `codebase-design` before H9 and before
`sim-borrower.ts`; `find-docs` before touching any `@livekit/agents` API (verify against the
installed `dist/`); `code-review` on each diff, verifying its factual claims; `commit-work` for
every commit; `handoff` at the end.
