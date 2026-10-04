---
name: "anti-slop"
description: "When explicitly requested, review or clean up source with the vendored anti-slop rules, evaluating findings against local TypeScript and Effect conventions."
---

# Anti-slop

Run this workflow only when the user explicitly requests anti-slop. It is a project-local review/cleanup wrapper around the upstream Oxlint plugins, not the upstream installer. Ordinary implementation, code review, required verification, and CI do not imply permission to run it.

Establish the requested scope and mode. Default to review; fix code when cleanup is requested. Prefer named paths, otherwise the current task's changed source files, including relevant staged, unstaged, and untracked files. If no such scope exists, review apps, packages, and scripts and state that scope before scanning. Exclude dependencies, builds, installed skills, and the vendored plugin itself.

Read [TypeScript/Effect conventions](../../../docs/agents/typescript-effect.md) and the [plugin provenance](../../../tools/oxlint/anti-slop/UPSTREAM.md). Use the installed pinned versions and current source to assess findings; do not install an overlapping standards skill, enable automatic checks, or upgrade tooling during a review.

For the full generic/Effect ruleset, run `pnpm exec oxlint --config .oxlintrc.baseline.json --format json <requested-paths>`. Its findings are warnings for assessment, not confirmed defects. With no path narrowing, `pnpm lint:baseline` scans non-test app/package/script files. `pnpm lint` is the optional five-rule strict scan, including tests; it is not the full ruleset.

The baseline config ignores test/spec files. If the user requests them, enumerate exact owned test files and use `--no-ignore` with those explicit file paths; do not apply that flag to broad directories that include excluded assets. Check the reported filenames to confirm the requested files were scanned. Preserve JSON output outside the repository when it is useful evidence. The [official ignore documentation](https://oxc.rs/docs/guide/usage/linter/ignore-files.html) documents the flag's bypass behavior.

Inspect diagnostics with callers and tests. Separate actionable defects or needless complexity from deliberate Schema/unknown boundary handling, SDK or mapped-schema casts, protocol unions, and harmless style preferences. Upstream rules use syntax/scope analysis, and some recommendations reference Effect 4 APIs; apply this repository's pinned Effect 3 semantics. Use the [baseline decisions](../../../docs/reviews/2026-10-04-anti-slop-baseline.md) as context, not a list of mandatory migrations.

When cleanup is requested, make bounded changes that preserve behavior and actual ownership. Do not mechanically replace casts with fake validation, add boilerplate safety comments, alter callback ordering, create gratuitous service abstractions, or reformat unrelated files to eliminate warnings. Rerun the same requested scan and relevant behavioral checks after changes; use project verification for substantive code edits.

Complete with the scanned scope, prioritized actionable findings, intentional patterns left alone, changes if requested, and actual validation limits. Do not commit, publish, or change automatic lint policy unless that action is separately requested.
