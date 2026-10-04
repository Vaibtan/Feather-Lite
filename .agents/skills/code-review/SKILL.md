---
name: "code-review"
description: "Review a branch, PR, staged changes, or work in progress against the applicable specification and repository standards."
---

# Code review

Establish the requested target and pin its base commit before reviewing. Infer the base from the PR, requested ref, or branch tracking information; ask only when competing choices change the scope.

Choose the diff that includes the requested changes:
- Committed branch: `git diff <base>...HEAD`.
- Branch plus working tree: resolve `git merge-base <base> HEAD`, then `git diff <resolved-merge-base>`.
- Working changes only: `git diff HEAD`.
- Staged only: `git diff --cached`.

For scopes including the working tree, also enumerate `git ls-files --others --exclude-standard` and read relevant untracked files. Record excluded paths and keep the target fixed. Recheck for concurrent edits before finalizing.

Read changed code with the callers, tests, and governing ADR/spec needed to assess its behavior. Evaluate two axes: compliance with applicable repository standards, and correctness against the requested behavior. For a substantial review, independent axes may be delegated to subagents with the same pinned scope; synthesize and verify their findings.

Report actionable defects with severity, a tight file/line location, the concrete trigger, and its consequence. Prefer findings supported by code or reproduction. Keep optional simplification separate from defects; size alone is not a blocker. State the reviewed scope and actual validation. If no defects are found, say so and name any material validation limits.
