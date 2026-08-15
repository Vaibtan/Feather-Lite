# Plan completion audit

Verify every plan item actually shipped before the branch lands. No plan file →
skip: "No plan file detected — skipping plan completion audit."

## 1. Extract actionable items

Read the plan. Extract everything that describes work to be done: checkbox
items (`- [ ]`), numbered steps under implementation headings, imperative
statements ("Add X to Y"), file-level specifications ("New file: path"), test
requirements, data-model changes.

**Ignore:** Context/Background/Problem sections; questions and open items (?,
"TBD"); review-report sections; explicitly deferred items ("Future:", "Out of
scope:", "P2:"); decision-record sections.

Cap at 50 items (note if more). For each item note its text and category:
CODE | TEST | MIGRATION | CONFIG | DOCS.

## 2. Classify verification mode

The diff alone cannot prove every kind of work — items outside the current
repo or system are structurally invisible to `git diff`:

- **DIFF-VERIFIABLE** — a change in this repo that would manifest in
  `git diff <base>...HEAD`.
- **CROSS-REPO** — names a file in a sibling repo. If the sibling is reachable
  on disk, check file existence: exists → DONE (cite path); missing → NOT DONE;
  unreachable → UNVERIFIABLE.
- **EXTERNAL-STATE** — names state in an external system (DNS, cloud config,
  OAuth allowlists, SaaS settings). Always UNVERIFIABLE — cite the exact
  manual check the user must perform.
- **CONTENT-SHAPE** — a file must follow a convention. In-repo →
  diff-verifiable; elsewhere, run any project-detected validator script
  (`validate-*`, `check-docs`) before falling back to UNVERIFIABLE.

**Path concreteness rule:** an item naming a concrete filesystem path MUST be
classified DONE or NOT DONE via an existence check. UNVERIFIABLE is only valid
for genuinely abstract targets or unreachable roots. "I don't want to check" is
not unreachable.

**Honesty rule:** do NOT classify DONE because related code shipped. Code that
*handles* a deliverable is not the deliverable. When in doubt between DONE and
UNVERIFIABLE, prefer UNVERIFIABLE.

## 3. Classify each item

- **DONE** — clear evidence it shipped; cite the specific files or verified path.
- **PARTIAL** — some work exists but incomplete (model created, controller missing).
- **NOT DONE** — verification produced negative evidence.
- **CHANGED** — implemented differently but the goal is achieved; note the difference.
- **UNVERIFIABLE** — cannot be proven either way; cite the manual check needed.

Be conservative with DONE (a file being touched is not enough), generous with
CHANGED (goal met by different means counts), honest with UNVERIFIABLE (better
to surface 5 manual confirmations than silently mark them DONE).

## 4. Gate logic (priority order)

1. **Any NOT DONE:** AskUserQuestion with the checklist — A) stop, implement
   the missing items · B) ship anyway, defer to follow-up TODOs · C)
   intentionally dropped, remove from scope (note in PR body). Recommend B for
   1-2 minor items (docs/config), A when core functionality is missing.
2. **Any UNVERIFIABLE** (after NOT DONE resolved): **per-item confirmation is
   mandatory** — never blanket-confirm the list (that's the failure shape
   where the user clicks "confirmed" without opening a single file). One
   AskUserQuestion per item with its specific check: Y) confirmed done — cite
   what you verified · N) not done — treat as NOT DONE, re-enter gate 1 ·
   D) intentionally dropped. All Y/D → continue, embedding a "Plan Completion —
   Manual Verifications" section in the PR body with each item's evidence.
   More than 5 UNVERIFIABLE items → offer (1) confirm individually (default),
   (2) stop and reduce scope, (3) explicit blanket-accept with a warning that
   this is the known failure shape.
3. **Only PARTIAL:** continue with a note in the PR body. Not blocking.
4. **All DONE or CHANGED:** "Plan completion: PASS — all items addressed."

## Scope drift detection (informational)

Did they build what was requested — nothing more, nothing less? Read the TODO
list, PR description (if a PR exists), and commit messages to identify the
**stated intent**; compare `git diff $(git merge-base <base> HEAD) --stat`
against it.

- **SCOPE CREEP:** files unrelated to the intent; features/refactors not in the
  plan; "while I was in there..." changes expanding blast radius.
- **MISSING REQUIREMENTS:** stated requirements not addressed in the diff;
  coverage gaps for them; partial implementations.

Output before review begins, then proceed (never blocks):

```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent:    <1-line summary of what was requested>
Delivered: <1-line summary of what the diff actually does>
[If drift: each out-of-scope change] [If missing: each unaddressed requirement]
```
