# Spec: the parked work committed, the container story verified, and Phases 1–7 resumed

2026-09-01. For the implementing session. This spec is the output of a full review of the
2026-09-01 handoff (`feather-lite-handoff-2026-09-01-phase0-and-w11.md`) and the tree at `8532c21`:
every Phase 0 and W11 claim was re-verified in source, the working tree was inspected, and the
Docker migration was audited end to end. It **amends and resumes** the spec in
`docs/plans/2026-08-30-turn-taking-and-conversation-quality-spec.md` (GitHub issue #1); it does not
replace it. Phases 1–7 of that spec remain the plan, with the amendments in §Amendments below.

Read before touching code, in this order, and do not re-derive:

1. **Issue #1's spec** (`docs/plans/2026-08-30-turn-taking-and-conversation-quality-spec.md`) —
   its ground rules, Q1–Q8 and phase table are still binding, as amended below.
2. `docs/loadtest/README.md`, the "2026-09-01 — Phase 0, the instruments straightened" section —
   the current numbers and the four findings (adaptive interruption never ran; the win32 VAD
   arena; the silero non-reproduction; the admitting set).
3. `docs/reviews/2026-08-30-efficiency-spec-phases-0-6-review.md` — items #1–#7, #9–#12 are fixed
   and verified (this review, 2026-09-01); items #13, #15, #16, #18, #19 are **scheduled here**
   (Phase C1); everything else in §2/§3 is **recorded, not built** (Phase C1, ADR 0010).
4. `docs/plans/2026-08-30-voice-agent-methods-research.md` §2 for the SDK facts.
   `@livekit/agents` stays pinned at 1.6.4.
5. ADR 0007 D3, 0008 D4, 0009, 0010 D2–D3 (D2 as corrected 2026-09-01).
6. The 2026-09-01 handoff for environment gotchas — noting the two corrections in §Findings.

## Ground rules (inherited from issue #1; the ones that bite here)

1. **Nothing is done until it has been run.** Every phase ends with its verification.
2. **One behavioural change per commit**; reasoning + before/after in the message; `code-review`
   on the diff; `commit-work`, never a bare `git commit`; `tdd` for pure modules;
   `diagnosing-bugs` for the voice path; `find-docs` before any `@livekit/agents` API.
3. **Everything runs in Docker except the borrower harness** (user directive, 2026-09-01).
   `docker compose --profile livekit --profile app up -d --build` with `LIVEKIT_NODE_IP` set to a
   host address both sides can reach; `RATE_LIMIT_BYPASS_TOKEN` set on server and harness for load
   runs; `pnpm stack:quiet` first; `pnpm lf:down` before fleet runs; `JUDGE_ENABLED=false` for
   load runs. The browser is the memory gotcha — ask before killing it.
4. **The four gates are unchanged** (equivalence, WER ≤ 0.20, SLO verdict on the voice+openai
   segment, compliance scores); D3's amount-entity gate becomes the fifth when it lands.
   Segments never mix.
5. **Known-failing test**: `pnpm test:db` `workers.test.ts` pinned-date failure (73/74). Still
   not approved for fixing; ask. Everything else stays green — including, from Phase C0 on, the
   `turnTaking` tests that are red today.
6. `main` is pushed through `8532c21` (2026-09-01). Push at the end of each phase; both Dependabot
   alerts on the repo are in state **fixed** — no action.

## Findings this spec is built on (verified 2026-09-01; do not re-review)

1. **Phase 0 and W11 are real.** All eleven review fixes, the O9 bypass token and the native VAD
   were verified in source with their tests: the admission controller
   (`apps/voice-worker/src/admission.ts`, a Set of job ids, abandon on SIGTERM), the 0005
   savepoint with its poisoning counterexample test, `/readyz` null-tick registration and
   per-batch outbox stamping, the `@livekit/agents` patch's `options`/`idleProcesses` getters,
   the post-`matchCauseEffect` log annotation, compose sizing with `composeLimits.test.ts`, the
   time-bounded score join, dispatch outside the transaction, the tri-state SLO verdict wired
   through console badges, the fail-closed bypass token (empty string normalised to null), and
   `inference.VAD` with silero/onnxruntime fully out of the tree. The commit messages carry the
   before/after; do not re-derive them.
2. **The handoff's "working tree clean, Phases 1–7 not started" was wrong.** The tree holds
   uncommitted Phase 1 work: `packages/domain/src/turnTaking.ts`,
   `packages/domain/test/turnTaking.test.ts`, and an `index.ts` export — and it is **red, 2 of 12
   tests failing**. `pnpm check` fails at the workspace root because of it. The two failures are
   analysed in Phase C0; the module is otherwise good and is kept, not rewritten.
3. **The Docker migration left six loose ends, not a mess.** The compose file, both Dockerfiles,
   `.dockerignore` and the resource sampler are already container-aware; the dual
   native/container paths in `resources.ts` and the root scripts are deliberate (native
   comparison runs, the free-tier demo runbook) and stay. The six: CI never builds or boots the
   images; `chaos-orphan.ts` kills host PIDs and cannot chaos a containerised worker;
   README's "Running it the way it is measured" contradicts the 2026-09-01 container numbers;
   `LIVEKIT_NODE_IP` is absent from `.env.example`; PROGRESS.md still says containers/W11 are
   "not done"; two stale comments (`shed-probe.ts:17` native-only run instructions,
   `scripts/bundle.mjs:15` naming a dependency that no longer exists).
4. **The N=10 acceptance run is due now.** Issue #1's Q8: it runs after Phase 0 + W11, not after
   Phase 4. The handoff's "what is left" omitted it. It is Phase A below.
5. **User decisions, 2026-09-01** (do not re-ask): of review §3's ten deferred items, the **CI
   image job is built** (Phase C1) and the other nine are **recorded in ADR 0010**; review #18,
   #13, #19, #15 and #16 are **fixed** (Phase C1) and #8, #14, #21–#25 recorded; the spec lands
   as a **new `ready-for-agent` issue** pointing at issue #1 for Phases 1–7; `main` is pushed.

## Phase C0 — the parked turn-taking work, fixed and committed

`packages/domain/src/turnTaking.ts` is kept: the shape (pure, events in, six numbers out,
null-denominators, counts alongside rates) is exactly what issue #1's D4 asks for. Two defects,
both understood; fix under `tdd` and commit through `commit-work`.

- **`false_interrupt_rate` infers causation from a time window, and the window lies.** A
  non-directed event counts as having stopped the agent when the agent's audio ends within
  `YIELD_WINDOW_MS` of it — which cannot distinguish "stopped because of the backchannel" from
  "the line ended naturally two seconds later". The spec's own fixture trips it: the backchannel
  at 2 000 ms against a natural end at 4 000 ms lands on `<= 2000` exactly and books a false
  interrupt the test rightly refuses. **The fix is playout truth, which the ledger already has**
  (the 2026-08-23 work exists precisely because "played in full" vs "interrupted" cannot be
  inferred): `AgentSpeech` gains a required `truncated: boolean`, supplied by the harness from the
  `AGENT_TURN_PLAYOUT` / `turn_metrics` interrupted flag joined by time (the same join
  `harness-scores.ts` performs). The rules become deterministic and hand-computable:
  - an **interruption** is unchanged: a `line` starting inside an agent stretch;
  - a **yield** is an interruption whose stretch is `truncated` and stopped within
    `YIELD_WINDOW_MS` of the line's onset;
  - a **false interrupt** is a truncated stretch whose *proximate cause* — the latest borrower
    event starting inside it — is non-directed; an untruncated stretch produces no false
    interrupt no matter what happened during it;
  - `selectivity` keeps its formula over the corrected false-interrupt set.
  The fixture then reads as intended: `agent(0, 4000, truncated: false)` ignores both
  backchannels; `agent(5000, 6400, truncated: true)` yields at 400 ms. Table tests gain the case
  the window could not express: a backchannel followed by a natural end (`truncated: false`, no
  false interrupt) beside the same timing with `truncated: true` (false interrupt).
- **The `bargeInT90` test contradicts the repo's one percentile rule.** Nearest-rank over ten
  samples at p90 is the ninth value (900); the test expects 1 000. The code is right — O1's
  deliberate no-interpolation rule (`percentile.ts`) — and the **test expectation changes to
  900**, with a comment naming the rule so the next reader does not "fix" it back.
- Then: `pnpm check` green at the workspace root, and the three files committed as Phase 1's
  first piece (issue #1's phase table already names it).

Verification: `pnpm check` green including 225 domain tests; the commit message carries the
red→green story and the causation-rule reasoning.

## Phase C1 — the instruments' remaining fail-opens, and the container story verified in CI

Each its own commit, review item number in the message.

- **#18 — env parsing fails open, beside the ceiling Phase 0 just fixed.**
  `agent.ts:55`: `Math.max(1, Number(...))` turns a typo'd `WORKER_MAX_JOBS` into `NaN`, and
  `inFlight() >= NaN` is always false — the admission ceiling silently disabled by a typo. The
  worker must **refuse to boot** on an unparseable `WORKER_MAX_JOBS`/`WORKER_IDLE_PROCESSES`
  (exit non-zero, one clear line): a misconfigured ceiling degrading to "no ceiling" is the same
  class of lie Phase 0 existed to stop. `WORKER_IDLE_PROCESSES=0` additionally dies at the
  framework's `numIdleProcesses || Default` (`worker.js:167`, unpatched): extend the existing
  `@livekit/agents` pnpm patch to `??`. Extract the parsing into a pure function with table
  tests (valid, `"0"`, `"abc"`, empty, negative).
- **#13 — redaction misses the phrasing the fleet actually uses.** `redact.ts` gains the
  review's three rules: currency-adjacent bare integers ("I can pay 550"), hyphenated digit
  groups (`555-123-4567`), and key-allowlisted numeric JSON leaves (`{"balance_due": 1250}`).
  Extend `spanMask.test.ts` with those cases and the counter-cases (a turn count, a latency
  number — never masked).
- **#19 — `stack:quiet` finds the zombie and passes anyway.** Non-zero exit when a stray native
  worker matches, with `--allow-worker` as the escape; the docstring gains one line saying the
  native-process check matters only for native comparison runs now that the measured stack is
  containers.
- **#15 — `CREATE INDEX IF NOT EXISTS`** in migration 0006, so following the migration's own
  build-concurrently advice no longer poisons boot. **#16 — the turn-retention map returns to
  zero at idle**: a scoped repeating sweeper plus a hard ceiling for turns whose fiber never
  finishes; a test that `feather_lite_live_turns` reads 0 after the last turn's window.
- **`chaos-orphan.ts` learns about containers.** The deployed worker lives in its own PID
  namespace; the probe gains a `docker exec feather-lite-worker pkill -f job_proc` path (flag or
  autodetect) and the sweeper's ~40 s FAILED/ORPHANED verdict is re-verified once against the
  containerised worker — the architecture that ships is the one chaos-tested.
- **CI builds and boots what ships** (the one §3 item promoted to built). A CI job that: builds
  both images from the repo root, prints their sizes, brings up
  `--profile livekit --profile app` with a CI `LIVEKIT_NODE_IP`, and gates on the server's
  `/readyz` going green and the worker container's own healthcheck passing. CI also runs
  `pnpm build` on the host so the bundler's externals guard finally runs where the review said
  it never did.
- **ADR 0010 grows its recorded-omissions section**: the nine remaining §3 items (incremental
  replay #8, `toolSpecsFor` memo, semi-space A/B, prepared statements, SSE coalescing, Langfuse
  retention #20, HOT/dead-tuple checks beyond the report line, upstream W1 issue) and the
  unscheduled review items (#14, #21–#25), each with one line of why-not-now. Built or recorded,
  not both, not neither — this closes the ledger on the 2026-08-30 review.

Verification: `pnpm check` + `test:db` (73/74, the known one); a worker started with
`WORKER_MAX_JOBS=eight` exits non-zero with the message; `WORKER_IDLE_PROCESSES=0` yields a pool
of zero on the heartbeat's `idle_processes`; the redaction tests; `stack:quiet` non-zero against a
planted stray; the chaos probe's containerised verdict; CI green **including the image job**.

## Phase A — the N=10 acceptance run (efficiency spec Phase 9, due since Q8)

The efficiency spec's acceptance bar, run on the corrected instruments and the containerised
stack — the first N=10 since the instruments stopped lying, and the first ever where the SLO
verdict can be *met* rather than merely not breached (30 turns ≥ `SLO_MIN_SAMPLE` 20).

- Containerised, per ground rule 3. `WORKER_MAX_JOBS=10` for the run, and the compose
  `mem_limit` raised per `composeLimits.test.ts`'s own arithmetic (its counterexample already
  documents that N=10 does not fit in 3g: 1 093 + 10 × 240 = 3 493 → 4g), with the comment's
  arithmetic updated in the same commit so the test keeps asserting the inequality.
- Quiet box first; Langfuse down; judge off; bypass token on both sides; `aura-2-orion-en`.
- Gates: the four, as ever — equivalence, WER ≤ 0.20, the SLO verdict on the voice+openai
  segment (now a real verdict), compliance scores — plus zero silent playouts and the shed
  behaviour if a refusal occurs (a refused call is `NEVER_SERVED`, not a hang).
- Whatever the outcome, it is written down: the loadtest README gains the run and its waterfall;
  the README status table's "N=10 acceptance not yet run" rows are corrected; a miss is
  diagnosed (`diagnosing-bugs`) before anything is changed, and the 2026-08-21 finding (N=10 was
  the laptop's CPU ceiling natively) is the prior to test against — the container stack's
  6.7–6.9 CPU-s per call-minute suggests it may now fit; the run answers, not the suggestion.

Verification: the run report JSON in `docs/loadtest/`, the README sections updated, and the
efficiency spec's Phase 9 marked closed in PROGRESS.md.

## Phase C2 — the documentation stops contradicting the tree

One commit, or one per file where a file's change carries reasoning.

- **README "Running it the way it is measured"**: qualified by era — native `start` pair through
  2026-08-28; containers from 2026-09-01 on, with the compose line and `LIVEKIT_NODE_IP` as the
  measured path. The "As containers" section stops disagreeing with it.
- **`.env.example` gains `LIVEKIT_NODE_IP`**, commented (default `127.0.0.1` is the browser
  demo; a containerised call needs a host address both sides reach) — it is load-bearing for the
  entire measured path and currently undiscoverable.
- **PROGRESS.md**: row 12 corrected (containers, compose limits, `stack:quiet` and W11 landed;
  the review + Phase 0 recorded), and a row 13 for issue #1's spec with this spec noted.
- **README repository map**: `docs/adr/ 0001–0007` → 0001–0010, and `docs/agents/` added.
- **`shed-probe.ts:17`** run instructions gain the containerised variant (`.env` +
  `docker compose up`, since the env var does not reach the container the way it reaches a native
  process); **`scripts/bundle.mjs:15`** stops naming `onnxruntime-node` as its example.

Verification: a reader following README top to bottom performs the containerised measured run
without consulting git history; `git grep -n "0001–0007" README.md` is empty.

## Then: issue #1's Phases 1–7, as amended

Start at Phase 1 (the tier-3 harness with the clean persona and the scenario tables — the metric
functions exist and are green as of Phase C0). The phase table, gates and decisions of issue #1
stand. Amendments, each already evidenced:

1. **D5.1 is answered; do not spend a phase on it.** Adaptive interruption has never run
   self-hosted — every job logs the 401 fallback to VAD-based interruption (loadtest README,
   finding 1). D5.1 becomes a config correction; `interruption.minDuration` (D5.2) is the live
   knob and the worker's `VAD_OPTIONS` already pins `minSilenceDuration: 550` for timing parity.
2. **Issue #1's Phase 0 wording for review #10 is wrong about the mechanism.** The harness never
   sees `turn_start` frames — it runs over LiveKit media, not the control plane's SSE. It joins
   by `started_at` time, bounded by the next measurement's instant (commit `6c7c4e8`). D4's
   scenario expectations must be written against that join, not against frames.
3. **Phase 1's baseline runs on the native VAD in containers** — Q8's precondition is met. The
   tier-3 harness therefore needs `LIVEKIT_NODE_IP` plumbed exactly as the tier-2 fleet has it,
   and its numbers land in the containerised segment.
4. **The turn-taking metric contract carries `truncated`** (Phase C0). D4's scenario tables must
   supply it from the ledger, and the yes-during-read-back scenario's expected shape asserts the
   read-back stretch untruncated on the pass path.
5. **Verification arithmetic drift**: `test:db` is 73/74 now (six DB tests added in Phase 0), not
   65/66; domain is 225 with turnTaking committed. An N=5 run's SLO verdict reads
   `insufficient` **by design** — it is not a gate failure; N=10 (Phase A) is where the verdict
   is real.

## Out of scope

- Everything issue #1 lists, unchanged: Flux/STT swaps, SDK upgrades past 1.6.4, LLM-driven
  borrowers, KV-cache work, TTS socket pooling beyond D5.5's measurement.
- The nine §3 items and review #8, #14, #21–#25 — **recorded in ADR 0010 by Phase C1**, then
  closed as questions.
- The `workers.test.ts` pinned-date fix (still not approved; ask the user, do not fix).
- `docker-compose.yml`'s unenforced CPU reservation for the SFU (`cpus:` on server/worker) —
  noted in the audit; raise with the user only if an N=10 diagnosis implicates CPU contention.

## Suggested phase order

| Phase | What | Verification |
|---|---|---|
| C0 | turnTaking causation fix (`truncated`), T90 test corrected, committed | `pnpm check` green at root, 225 domain tests |
| C1 | #18 fail-closed env, #13 redaction, #19 stack:quiet, #15/#16, containerised chaos probe, CI image job, ADR 0010 recorded omissions | listed per item above; CI green with the image job |
| A | N=10 acceptance, containerised, corrected instruments | the four gates; run recorded whatever it says |
| C2 | README/.env.example/PROGRESS/comments truth pass | a reader reproduces the measured run from README alone |
| 1–7 | issue #1's phases, as amended above | issue #1's own table |

Push at the end of each phase. `handoff` at the end of the session.

## Decisions not to re-open

- Phase 0 and W11 are verified; do not re-review them. The win32 VAD arena (~450 MB per
  predicting process) and the Linux 37 MB figure stand; `vad-cost` retakes them if doubted.
- `turnTaking.ts` is kept and fixed, not rewritten; causation comes from the ledger's playout
  truth, not from a time window — the same principle ADR 0008 established for "heard".
- Nearest-rank percentile (O1) governs every percentile in the repo, including T90.
- The six docker-audit keeps (dual sampler paths, native scripts, free-tier runbook) are
  deliberate and stay.
