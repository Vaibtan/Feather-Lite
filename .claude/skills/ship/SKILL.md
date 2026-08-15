---
name: ship
description: Ship workflow — merge base, run tests, audit coverage and plan completion, review, bump version, write CHANGELOG, commit bisectably, verify, push, open the PR. Fully automated; stops only for judgment calls.
disable-model-invocation: true
---

# Ship

Run the whole pipeline non-interactively. The user typed one command; the
output is a pushed branch with a PR.

**Only stop for:** being on the base branch (abort) · merge conflicts that
can't be auto-resolved · in-branch test failures (pre-existing failures are
triaged, not auto-blocking) · review findings that need user judgment · MINOR
or MAJOR version bump · coverage below minimum (gate with override) · plan
items NOT DONE with no override.

**Never stop for:** uncommitted changes (always include them) · PATCH version
choice · CHANGELOG content (auto-generate from diff) · commit message
approval · multi-file changesets (auto-split) · auto-fixable review findings
(dead code, stale comments — fix them).

**Re-run idempotency:** re-running means "run the whole checklist again." Every
*verification* (tests, coverage, plan completion, review, CHANGELOG check)
runs on every invocation; only *actions* are idempotent — version already
bumped → skip the bump; already pushed → skip the push; PR exists → update its
body instead of creating one. Never skip a verification because a prior run
performed it.

## Step 0 — Platform and base branch

Detect GitHub (`gh`) vs GitLab (`glab`) vs bare git from the remote URL.
Resolve the base branch (`gh repo view --json defaultBranchRef`, or
`origin/HEAD`) — use it everywhere below; never hardcode `main`.

## Step 1 — Pre-flight

Abort if on the base branch. `git status`; read the full diff and commit log
vs base. Note which reviews have already run on this branch (from the
conversation, PR comments, or plan-file review reports) and how many commits
have landed since each — a review 4+ commits stale was done on different code.
For diffs over ~200 lines with no engineering review on record, recommend
running the code-review skill before shipping (don't block).

## Step 2 — Merge the base branch (BEFORE tests)

`git fetch` + merge `origin/<base>` into the branch. Auto-resolve trivial
conflicts; STOP and show any complex ones. Testing before merging tests the
wrong tree.

## Step 3 — Tests

Run the project's test command from CLAUDE.md (ask once and persist it there if
missing). In-branch failures: fix or STOP. Pre-existing failures on base:
triage and note in the PR body — prove they're pre-existing by running the same
test on base, never just claim it.

## Step 4 — Coverage audit

Read [coverage.md](coverage.md) and execute it: decision matrix, regression
rule, coverage diagram, test generation, gate.

## Step 5 — Plan completion audit

If a plan file drove this branch, read
[plan-completion.md](plan-completion.md) and execute it: extract items, verify
each honestly, gate on NOT DONE / UNVERIFIABLE, then run its scope-drift check.

## Step 6 — Pre-landing review

Run the code-review skill (or the project's review process) on the diff. Hold
its findings to calibration discipline: every finding quotes the motivating
file:line verbatim — a finding that can't quote its evidence is suppressed, not
reported. Fix-first: apply auto-fixable findings (dead code, stale comments,
obvious bugs) and commit them; surface judgment calls via AskUserQuestion.

## Step 7 — Version bump (if the project keeps a VERSION/version field)

Decide from the diff: **PATCH** for fixes and small additions; **MINOR** — ASK
— for any feature signal (new route/page/module, migration) or 500+ lines;
**MAJOR** — ASK — breaking changes or milestones. Scale honestly: if you're
debating whether a 10K-line diff is "really a patch", it isn't.

## Step 8 — CHANGELOG (if the project keeps one)

1. Enumerate every commit on the branch (`git log <base>..HEAD --oneline`) —
   this list is your checklist.
2. Read the full diff to know what each commit actually changed.
3. Group commits by theme (features / fixes / cleanup / infra / refactoring),
   then write ONE entry for the shipping version covering all themes, replacing
   any branch-internal entries that never landed on base.
4. **Voice:** lead with what the user can now DO that they couldn't before.
   Plain language, not implementation details. Never mention internal tracking
   or branch development narrative — the entry is the diff between base and
   this branch, not how the branch got there.
5. **Cross-check:** every commit maps to at least one bullet. Unrepresented
   commit → add it now.

Never ask the user to describe the changes — infer from the diff.

## Step 9 — Commit in bisectable chunks

First, if the branch carries `WIP:` checkpoint commits, squash them into their
logical commits — **anti-footgun: NEVER blind `git reset --soft <merge-base>`
when non-WIP commits exist** (it uncommits real landed work). Use a rebase that
fixups only the WIP commits; reset-soft is safe only when the branch is 100%
WIP. Unsure → ask.

Then group the changes: one coherent logical unit per commit (not one file).
Order: infrastructure (migrations, config, routes) → models & services →
controllers & views → VERSION + CHANGELOG always last. A model and its test
travel together. Each commit must be independently valid — no broken imports,
dependencies come first. Small diffs (<50 lines, <4 files) can be one commit.
Messages: `<type>: <summary>` (feat/fix/chore/refactor/docs/test).

## Step 10 — Verification gate

**IRON LAW: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

If ANY code changed after Step 3's test run (review fixes, generated tests —
CHANGELOG/docs-only edits don't count), re-run the suite and paste fresh
output — stale output is not acceptable. If
the project builds, run the build. Rationalization prevention:
- "Should work now" → RUN IT.
- "I'm confident" → confidence is not evidence.
- "I already tested earlier" → code changed since then. Test again.
- "It's a trivial change" → trivial changes break production.

Tests fail here → STOP, do not push, fix and return to Step 3. Claiming work is
complete without verification is dishonesty, not efficiency.

## Step 11 — Push and PR

Push the branch. Create the PR (or update the existing PR's body): what shipped
and why, test/coverage results, plan-completion notes, any accepted risks
verbatim from the gates above. The body describes the released change for a
reviewer who wasn't here — not the branch's internal journey.

Close by telling the user what shipped, the PR URL, and anything they accepted
along the way (coverage overrides, deferred plan items).
