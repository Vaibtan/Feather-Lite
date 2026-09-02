# Why this repo patches its dependencies

Two patch files, both against `@livekit/agents` 1.6.4 and its plugins, both applied by pnpm
(`patchedDependencies` in `pnpm-workspace.yaml`). Neither is a fork: each is a few lines, and each is
written to be droppable the moment upstream lands the same fix.

**Each entry carries either a measurement or the defect it makes measurable.** Two of the four
below have a number. The other two have none *because neither changes behaviour on a correctly
configured worker*: one exposes values the worker had already resolved and could not report, the
other makes a setting an operator can type mean what it says. What both buy shows up on the
heartbeat rather than in this file. An entry that has neither is not allowed here.

**The version is pinned deliberately.** `@livekit/agents` 1.7+ changes EOU and endpointing
behaviour that every latency number in `docs/loadtest/README.md` was measured on. An upgrade is its
own piece of work with its own fleet baseline, so until then these live here.

---

## `@livekit__agents-plugin-deepgram@1.6.4.patch` — a TTS websocket that never connects

Phase 10, 2026-08-23. The plugin opens a websocket per synthesis and had no connect timeout, so a
hung connect produced a **zero-audio playout** that the framework force-closed and reported as
"played in full" — and the ledger recorded a read-back the borrower never heard, which is the one
thing the fully-heard guard exists to prevent.

The patch adds a 4-second connect timeout, marked retryable so the framework's own retry loop
recovers in ~5 s worst case.

## `@livekit__agents@1.6.4.patch` — the main worker process loads a 69 MB addon to ask whether it exists

Phase 12 (W1), 2026-08-28. `worker.ts` calls `maybeRegisterLocalEotRunner()` at construction. That
function's only question is *may we register the local audio EOT runner* — and it answered it by
`require`ing `@livekit/local-inference`, the napi addon that carries the compiled turn-detector
model. The main worker process never runs inference: the runner is registered as a **URL string**
and executed in the separate inference process.

**Measured on this box** (`tsx`/ESM, `start` mode, idle 90 s, `docs/loadtest/2026-08-28-idle-tree-w1-{before,after}.json`):

| role | before | after |
|---|---:|---:|
| worker-main peak private | 1 051 MB | 177 MB |
| worker-main peak RSS | 1 027 MB | 167 MB |
| whole tree peak private | 3 115 MB | 2 251 MB |

Re-measured under the esbuild bundle (`node dist/agent.js start`, four warm slots,
`2026-08-28-idle-tree-{w1-unpatched-,}bundle.json`), because the audit had seen only −322 MB in
bare CJS and the spec reserved the right to drop the patch if the bundle made it moot:

| role | unpatched | patched |
|---|---:|---:|
| worker-main peak private | 855 MB | 115 MB |

It still pays, and by nearly as much. The patch stays.

The patch replaces the `require` with a `require.resolve` in the same module, as
`_localInferenceResolvable()`. Resolution answers the actual question — is the package installed —
without executing the addon or mapping the model.

**What is given up, and why it is acceptable.** `require.resolve` succeeding does not prove the
native binding *loads*: a package installed without a binary for this platform would now register
the runner and fail later instead of warning here. It fails well. `EotRunner.initialize()` in the
inference process already calls `_getLocalInferenceModule()` and throws
`"@livekit/local-inference native binding unavailable in the inference process"` when it is
undefined — so the check the main process was paying a gigabyte for is a duplicate of one that runs
anyway, in the process that actually needs the module, with a clearer message. The warning text in
the main process is left exactly as upstream wrote it.

Both the ESM (`dist/*.js`) and CJS (`dist/*.cjs`) builds are patched, and the `.d.ts` gains the new
internal declaration, so the patch survives whichever build a bundler resolves.

**Upstream:** not yet filed. Worth filing against `livekit/agents-js` with the table above — the fix
upstream is the same two lines, and every Node worker in production is paying this.

## `@livekit__agents@1.6.4.patch`, part two — a worker that cannot see what it resolved

Phase 0 (review #4, #17), 2026-09-01. Two getters on `AgentServer`. **No measurement, because there
is no behaviour to measure** — this is the entry the rule above carves out. What it buys is that
three heartbeat fields stop being the config the worker was handed and start being what it resolved:

```js
get options()        { return this.#opts; }
get idleProcesses()  { return this.#procPool.processes.filter((p) => p.started && !p.runningJob).length; }
```

`cli.runApp` builds the `ServerOptions` itself — it takes the ones the app passes, strips
`production`, and re-constructs with the value the CLI subcommand resolved (`cli.js:18-19`) — and
`AgentServer` exposes only `id` and `activeJobs`. So the worker had no way to report what it was
actually running as, and the heartbeat repeated the *config it was handed* instead:

- `production` was inferred from `LIVEKIT_DEV_MODE`, which is nearly right (the SDK's `dev`,
  `connect` and `console` commands do set it, `cli.js:128,144,157`) and says nothing about
  `start --simulation`, the one mode where `loadThreshold` really is forced to `Infinity`
  (`worker.js:166`). The fleet's dev-mode gate is built on this field.
- `load_threshold` was the configured constant, never the resolved one.
- `idle_processes` was `WORKER_IDLE_PROCESSES`, a number nobody had checked against the pool. A
  pool that failed to pre-warm reported exactly the same as one that succeeded — which is the
  single thing W3 asked to verify live, and it could not be verified at all.

`proc.started`, not just `!proc.runningJob`: `procWatchTask` pushes an executor into `executors`
*before* `await proc.start()` resolves (`ipc/proc_pool.js:73-79`), so counting every executor with
no job would report a slot that has not forked yet as warm. `started` is set inside `start()`
(`ipc/supervised_proc.js:52`) — the fork has happened. It is still not proof of a completed
`initialize()`, so a slot that forked and failed its prewarm counts as warm for as long as it
lives; what the number catches is a pool that never filled, which is the case W3 asked about.

`#opts` and `#procPool` are ES private fields, so no cast, proxy or reflection reaches them: a
patch is the only way. Both builds (`dist/worker.js`, `dist/worker.cjs`) and both declaration files
(`.d.ts`, `.d.cts`) carry it.

**Upstream:** worth filing as one issue with the W1 one. `activeJobs` is already public and this is
the same question asked about the other half of the pool; there is no reason a worker should not be
able to report its own resolved options.

## `@livekit__agents@1.6.4.patch`, part three — a warm pool of zero is not a warm pool of four

Phase C1 (review #18), 2026-09-01. One character:

```js
this.numIdleProcesses = numIdleProcesses ?? Default.numIdleProcesses(production);
```

`||` was `??`. **The defect it makes measurable**: `WORKER_IDLE_PROCESSES=0` is a legitimate
setting — it is how you take the warm pool out of a measurement, and each warm slot is ~190 MB of
resident memory doing nothing — and it did not work. Zero is falsy, so `ServerOptions` replaced it
with `Default.numIdleProcesses(production)`, which is **4** in production mode. A run configured
with no warm pool ran with four warm processes and reported `idle_processes_configured: 0` beside
`idle_processes: 4`, and the two disagreeing fields were the only evidence.

That is the same shape as the defect beside it in `agent.ts`: a number the operator set, silently
replaced by one nobody chose. The worker-side half of #18 refuses to boot on a value it cannot
honour; this half makes the one honourable value at the bottom of the range reachable at all.

`loadThreshold` two lines above has the same `||`, and is **deliberately left alone**: a threshold
of 0 means "never accept a job", which is not a configuration anyone wants silently honoured, and
`simulation` already overrides that line. No number to claim here either — the pool size is
reported on the heartbeat, and the verification is that `idle_processes` reads 0.

**Upstream:** file with the other two. `?? ` is the whole fix.

---

## Working on a patch

```
pnpm patch @livekit/agents@1.6.4          # prints a scratch directory
#   ...edit dist/ there...
pnpm patch-commit <that directory>        # rewrites patches/*.patch and reinstalls
```

After changing either patch, re-run the measurement it claims. A patch whose number is stale is
worse than no patch, because the next person believes it.

---

## Not patched: job processes ignore SIGTERM (issue #4, W7)

Recorded here rather than fixed, because it is the framework's behaviour and not this repo's, and
because a probe says the consequence is narrower than it first looked.

`agents/dist/ipc/job_proc_lazy_main.js:187-191` installs the job process's own `SIGINT` and `SIGTERM`
handlers, and both only log. `ipc/supervised_proc.js` then uses `proc.kill()` — plain SIGTERM — as
its fallback in three places: a wedged job, a failed `initialize`, and the memory-limit `close()`.

**Probed on the running container, 2026-09-02.** Four warm `job_proc_lazy_main` processes; the
worker was sent `kill -TERM` on one of them:

```
PID 606 SURVIVED SIGTERM
warm job processes now: 5
```

It survived, stayed in the pool's count, and the worker went on reporting healthy. So on Linux — the
platform that ships — the per-job memory ceiling and the unresponsive-job watchdog both depend on
the **IPC shutdown path**, and a job that stops answering IPC cannot be killed by the framework's
fallback.

**Why it is not patched.** The failure needs a job that is both wedged *and* still holding its slot,
which nothing here has produced: `WORKER_JOB_MEMORY_LIMIT_MB` has fired in anger (the win32 native
VAD arena, 2026-09-01) and the jobs it killed went away, because they were answering IPC. Patching
`process.exit(143)` into a dependency's signal handler to cover a case that has not occurred is the
opposite of this file's rule — every entry here carries a measurement or the defect it makes
measurable.

**What was corrected instead.** The 2026-09-02 review first reported this as a repo defect, on the
strength of `agent.ts`'s own `process.once("SIGTERM", abandonWaits)`. That handler is redundant
inside a job process and is **not** the cause; the SDK installs the same no-op handlers itself. The
correction is in that spec's §Corrections, and this note is the evidence behind it.

**Trigger:** the first job observed surviving a memory-limit `close()`, or a wedged job that holds a
slot through a watchdog timeout. Either makes a `process.exit(143)` patch worth its maintenance.
