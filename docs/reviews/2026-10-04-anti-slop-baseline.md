# Anti-slop baseline and adopted policy

Current policy after the user's follow-up: anti-slop runs only on explicit request through `$anti-slop` or a requested manual lint command. It has been removed from `pnpm check` and CI. The baseline below records the initial integration and findings; the five-rule strict scan is now optional, and the full warning ruleset supports manual assessment rather than automatic enforcement.

2026-10-04. Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b), Oxlint and @oxlint/plugins 1.78.0. Runtime source is vendored unchanged with licenses. Node >=22.18.0 is now required for native TypeScript plugin loading, as documented by the installed Oxlint schema and [official JS-plugin docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).

`pnpm lint` enforces five selected rules over apps, packages, and scripts, including tests. Built-in broad correctness categories are disabled; this is a focused policy check, not a comprehensive linter or type/architecture certification. `pnpm check` and CI execute lint and setup validation.

`pnpm lint:baseline` evaluates all 24 generic/Effect/native companion rules as warnings, excluding test/spec files, dependencies, build output, and agent/vendor assets. Final snapshot: **141 non-test app/package/script files; 2625 warnings**. Including tests: **225 files; 3404 warnings**. These are pattern diagnostics, not a count of confirmed bugs. The new setup validator accounts for 25 spacing warnings; initial non-test snapshot was 140 files/2,600 warnings.

| Rule | Non-test | Including tests | Decision |
| --- | ---: | ---: | --- |
| `oxc/no-accumulating-spread` | 0 | 0 | Enforce: avoid repeated accumulator spread; pair with custom copy rule. |
| `anti-slop/no-array-filter-map` | 10 | 10 | Defer: callback order/index/sparse-array semantics and runtime support require review. |
| `anti-slop/no-reduce-accumulator-copy` | 0 | 0 | Enforce: reject supported non-spread accumulator copies; fresh mutation is allowed. |
| `anti-slop/no-chained-type-assertions` | 11 | 13 | Defer: mapped-schema/SDK compatibility casts and fixtures need individual review. |
| `anti-slop/no-conditional-empty-object-spread` | 44 | 47 | Defer: optional property presence must be preserved; no mechanical rewrite. |
| `anti-slop/no-known-value-widening` | 56 | 61 | Defer: widenings can be intentional API contracts. |
| `anti-slop/no-module-mocking` | 0 | 0 | Enforce: existing tests use real seams; ordinary spies remain allowed. |
| `anti-slop/no-object-parameters` | 0 | 0 | Defer: no current findings; runtime validation decisions belong to boundary contracts. |
| `anti-slop/no-reflect-apply` | 0 | 0 | Enforce: ordinary typed calls are preferred; shadowed local names are excluded. |
| `anti-slop/no-reflect-get` | 0 | 0 | Enforce: typed access/boundary parsing; shadowed local names are excluded. |
| `anti-slop/no-runtime-typeof` | 41 | 45 | Defer: Schema transforms and recursive redaction legitimately narrow representations. |
| `anti-slop/no-unsafe-dictionary-type` | 72 | 97 | Defer: unknown-valued transport/redaction maps require contextual policy. |
| `anti-slop/no-shape-in-symbol-names` | 47 | 56 | Defer: vocabulary bans do not establish a defect. |
| `anti-slop/no-unknown-parameters` | 18 | 18 | Defer: unknown is intentional at parsing boundaries. |
| `anti-slop/no-unknown-returns` | 4 | 4 | Defer: boundary/recursive redaction helpers intentionally preserve unknown. |
| `anti-slop/no-unknown-type-aliases` | 0 | 0 | Defer: zero findings is insufficient reason for a universal alias ban. |
| `anti-slop/no-widen-then-assert` | 0 | 0 | Defer: zero findings; review assertions in context before expanding policy. |
| `anti-slop/require-readable-spacing` | 2137 | 2762 | Defer: dominant formatting noise; no formatter migration requested. |
| `anti-slop/require-safety-comment-for-type-assertion` | 146 | 208 | Defer: avoid a blanket comment migration; inspect consequential casts. |
| `anti-slop-effect/no-manual-effect-error-tag` | 0 | 0 | Defer despite zero findings: diagnostics also recommend Effect 4 catchReason(s), absent from our pinned API. |
| `anti-slop-effect/no-manual-tag-comparison` | 24 | 40 | Defer: protocol tags and Either/Option discrimination require context. |
| `anti-slop-effect/no-manual-tagged-construction` | 9 | 37 | Defer: legitimate plain TypeScript protocol unions, including TurnChunk factories. |
| `anti-slop-effect/no-service-constructor-imports` | 0 | 0 | Defer despite zero findings: regex bans every relative makeX import without proving it is an Effect service; misses package aliases. |
| `anti-slop-effect/prefer-effect-match` | 6 | 6 | Defer: style preference; existing semantics need individual review. |

## Reviewed compatibility examples

- `packages/domain/src/values.ts:58` narrows the already-declared Schema number/string union inside its transform. A universal typeof prohibition conflicts with that implementation.
- `packages/domain/src/redact.ts:170-181` recursively sanitizes unknown data and returns unknown; its dictionary/narrowing findings require boundary-specific treatment.
- `packages/domain/src/turn.ts:21-26` declares a plain discriminated union and correctly constructs its variants; no Schema or Data constructor exists to substitute mechanically.
- `packages/domain/src/tools.ts:172` has a documented mapped-schema lookup cast. Whether to redesign it is a separate code change, not a reason to enable a blanket cast cleanup.

## Enforcement verification

Temporary fixtures produced errors from all five adopted rules and exited nonzero. A positive fixture passed with test spies, a fresh locally mutated accumulator, and a shadowed local Reflect object. Fixtures were removed. No lint autofix or application rewrites were performed.

Full machine-readable snapshots and fixture diagnostics are preserved at `C:/Users/hp/.codex/backups/Feather-Lite/2026-10-04-codex-setup`. Updating the rule policy requires reviewing actual findings and pinned Effect APIs. JS plugins are alpha; upgrade Oxlint and @oxlint/plugins together and revalidate the vendored runtime.
