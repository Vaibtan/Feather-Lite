---
name: qa
description: Browser QA — test a web app like a real user, document evidenced issues with a health score, then fix, regression-test, and re-verify. `report-only` mode finds without fixing.
disable-model-invocation: true
---

# QA

Test the app as a user, not a developer. **Requires a browser tool** (a browser
MCP such as Chrome DevTools MCP or Playwright MCP). If none is available, say so
and stop — never substitute code reading or unit tests for browser testing.
Even if the diff appears to have no UI changes, backend changes affect app
behavior — always open the browser and test.

Reference files: [issue-taxonomy.md](issue-taxonomy.md) (severities, categories,
per-page checklist) and [report-template.md](report-template.md) (the report
skeleton). Output goes to `.context/qa-reports/` (report + `screenshots/` +
`baseline.json`).

**Report-only mode** (`report-only`, or when invoked as a find-don't-fix
request): run Phases 1-6 and the report, skip Triage and the Fix Loop entirely.
Never read source code, never edit files, never suggest fixes in the report.

**Tiers** decide which issues get fixed: **Quick** = critical + high only;
**Standard** (default) = + medium; **Exhaustive** = + low/cosmetic.

## Modes

- **Diff-aware** (default on a feature branch with no URL): analyze the branch
  diff (`git diff <base>...HEAD --name-only`, `git log <base>..HEAD --oneline`)
  and map changed files to affected pages/routes (controllers/routes → URL
  paths; views/components → pages rendering them; models/services → pages using
  them via their controllers; CSS → pages including it; API endpoints → test
  directly). Detect the running app by probing common dev ports (3000, 4000,
  8080); if nothing is running, ask for a URL. Test each affected page,
  cross-reference commit messages for *intent* — verify the change does what it
  claims — and check adjacent pages for regressions. No obvious pages
  emerging from the diff → fall back to Quick mode on the homepage.
- **Full** (default with a URL): systematic exploration of every reachable
  page. 5-10 well-evidenced issues, health score.
- **Quick**: 30-second smoke test — homepage + top 5 navigation targets; loads?
  console errors? broken links? Health score, no detailed issue docs.
- **Regression** (`--regression`): run Full, then diff against the previous
  `baseline.json` — issues fixed, issues new, score delta.

## Phases 1-6 — Test

1. **Initialize:** create the output dirs, copy the report template, start a
   timer.
2. **Authenticate (if needed):** log in with provided credentials (write
   `[REDACTED]` for passwords everywhere), or import a provided cookie file.
   2FA → ask the user for the code. CAPTCHA → ask the user to complete it in
   the browser.
3. **Orient:** open the target, take an annotated screenshot, map navigation
   links, read console errors. Detect the framework for the report (`__next` →
   Next.js; `csrf-token` meta → Rails; `wp-content` → WordPress; client-side
   routing → SPA). For SPAs, find nav elements from the page snapshot — link
   extraction misses client-side routes.
4. **Explore:** visit pages systematically; per page take a screenshot, check
   console, then run the per-page checklist in
   [issue-taxonomy.md](issue-taxonomy.md). Spend more time on core features
   (homepage, dashboard, checkout, search), less on secondary pages.
5. **Document — immediately when found, don't batch.** Interactive bugs get a
   before-screenshot, the action, a result-screenshot, and repro steps; static
   bugs get one annotated screenshot + description. Verify by retrying once
   before documenting. Append each issue to the report as you go.
6. **Wrap up:** compute the health score, write "Top 3 Things to Fix", the
   console-health summary, severity counts, metadata, and save `baseline.json`
   (date, url, healthScore, issues[], categoryScores).

**Health Score Rubric** — per-category 0-100, then weighted average:
- Console (15%): 0 errors → 100; 1-3 → 70; 4-9 → 40; 10+ → 10.
- Links (10%): 0 broken → 100; each broken link → −15 (min 0). (The taxonomy
  files broken links under Functional; they deduct here, not there.)
- Visual (10%), Functional (20%), UX (15%), Performance (10%), Content (5%),
  Accessibility (15%): start at 100; deduct per finding — critical −25,
  high −15, medium −8, low −3 (min 0).

**Framework-specific checks:** Next.js — hydration errors, `_next/data` 404s,
client-side navigation, CLS. Rails — N+1 warnings in dev, CSRF tokens in forms,
Turbo/Stimulus transitions, flash messages. WordPress — plugin-conflict JS
errors, `/wp-json/` endpoints, mixed content. SPA — stale state on
navigate-away-and-back, browser back/forward history handling.

## Phase 7 — Triage

Sort issues by severity; the tier decides which get fixed (others "deferred").
Issues unfixable from source (third-party widgets, infrastructure) are deferred
regardless of tier.

## Phase 8 — Fix loop

**Clean working tree required** — if dirty, offer commit/stash/abort first.
For each fixable issue, in severity order:

- **8a Locate:** grep for error messages/component names/routes. ONLY modify
  files directly related to the issue.
- **8b Fix:** the **minimal fix** — smallest change that resolves it. No
  refactoring, no "improving" unrelated things.
- **8c Commit:** one commit per fix, `fix(qa): ISSUE-NNN — short description`.
  Never bundle fixes.
- **8d Re-test:** navigate back, before/after screenshot pair, check console.
- **8e Classify:** **verified** (re-test confirms, no new errors) /
  **best-effort** (couldn't fully verify) / **reverted** (regression detected →
  `git revert HEAD` → defer).
- **8e.5 Regression test** (skip if not verified, purely-visual CSS, or no test
  framework): read 2-3 nearby test files and match their conventions exactly.
  Trace the bug's codepath first — what input triggered it, which branch broke,
  what adjacent inputs hit the same path — then write a test that sets up that
  exact precondition, performs the action, and asserts correct behavior (never
  just "it renders"). Attribution comment: `// Regression: ISSUE-NNN — {what
  broke} // Found by /qa on {date}`. Run only the new test file: passes →
  commit `test(qa): regression test for ISSUE-NNN`; fails → fix once, then
  delete and defer. Never modify existing tests or CI config.
- **8f Self-regulate — STOP AND EVALUATE** every 5 fixes (and after any
  revert). Compute WTF-likelihood: start 0%; each revert +15%; each fix
  touching >3 files +5%; after fix 15, +1% per additional fix; all remaining
  issues Low severity +10%; touching unrelated files +20%. **If WTF > 20%:
  stop immediately**, show what you've done, ask whether to continue. Hard
  cap: 50 fixes. (Test commits don't count.)

## Phases 9-10 — Verify and report

Re-run QA on all affected pages and compute the final health score. **If the
final score is WORSE than the baseline, WARN prominently — something
regressed.** Write the report per [report-template.md](report-template.md) with
per-issue fix status, commit SHA, and before/after screenshots, plus the
one-line PR summary: "QA found N issues, fixed M, health score X → Y." If the
repo tracks TODOs, add deferred bugs there and annotate any fixed ones.

## Test framework bootstrap (only when fixing and no framework exists)

If no test config/dirs are found and `.context/no-test-bootstrap` doesn't
exist: detect the runtime from manifests, then offer to bootstrap via
AskUserQuestion (decline → write the opt-out marker). Recommendations:
Ruby/Rails minitest+capybara (alt rspec); Node vitest+testing-library (alt
jest); Next.js vitest+testing-library/react+playwright; Python pytest; Go
stdlib+testify; Rust cargo test; PHP phpunit; Elixir ExUnit. Install, create
minimal config + one example test, verify the full run (failure → debug once,
then revert and continue without tests), write TESTING.md ("100% test coverage
is the key to great vibe coding — without tests, vibe coding is just yolo
coding"), append a `## Testing` section to CLAUDE.md (write a test with every
new function, a regression test with every bug fix, tests for BOTH branches of
every conditional), and commit as
`chore: bootstrap test framework ({framework})`.

## Rules

1. **Repro is everything.** Every issue needs at least one screenshot.
2. **Verify before documenting.** Retry once to confirm it's reproducible.
3. **Never include credentials.** `[REDACTED]` for passwords everywhere.
4. **Write incrementally.** Append issues as found.
5. **Never read source code while testing.** Test as a user. (Source is opened
   only inside the Fix Loop.)
6. **Check console after every interaction.** Errors that don't surface
   visually are still bugs.
7. **Test like a user.** Realistic data, complete workflows end-to-end.
8. **Depth over breadth.** 5-10 well-documented issues beat 20 vague ones.
9. **Never delete output files.** Screenshots and reports accumulate.
10. **Show screenshots to the user.** Read each screenshot file after capturing
    so it renders inline — without this they're invisible.
11. **Revert on regression.** A fix that makes things worse gets
    `git revert HEAD` immediately.
