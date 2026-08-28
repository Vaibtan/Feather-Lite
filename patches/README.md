# Why this repo patches its dependencies

Two patches, both against `@livekit/agents` 1.6.4 and its plugins, both applied by pnpm
(`patchedDependencies` in `pnpm-workspace.yaml`). Neither is a fork: each is a few lines, each has
a measurement behind it, and each is written to be droppable the moment upstream lands the same fix.

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

---

## Working on a patch

```
pnpm patch @livekit/agents@1.6.4          # prints a scratch directory
#   ...edit dist/ there...
pnpm patch-commit <that directory>        # rewrites patches/*.patch and reinstalls
```

After changing either patch, re-run the measurement it claims. A patch whose number is stale is
worse than no patch, because the next person believes it.
