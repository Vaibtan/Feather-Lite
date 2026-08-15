# Test coverage audit

Audit the branch diff for untested code paths, generate tests for the gaps,
and gate on a minimum threshold.

## E2E test decision matrix

When checking each branch of new code, decide which tool fits:

**RECOMMEND E2E (mark [->E2E]):**
- Common user flow spanning 3+ components/services (signup → verify email → first login)
- Integration point where mocking hides real failures (API → queue → worker → DB)
- Auth/payment/data-destruction flows — too important to trust unit tests alone

**RECOMMEND EVAL (mark [->EVAL]):**
- Critical LLM call needing a quality eval (prompt change → output still meets bar)
- Changes to prompt templates, system instructions, or tool definitions

**STICK WITH UNIT TESTS:**
- Pure function with clear inputs/outputs
- Internal helper with no side effects
- Edge case of a single function (null input, empty array)
- Obscure/rare flow that isn't customer-facing

## REGRESSION RULE (mandatory)

**IRON RULE:** when the audit identifies a REGRESSION — code that previously
worked but the diff broke — a regression test is written immediately. No
asking. No skipping. Regressions are the highest-priority test because they
prove something broke.

A regression is when: the diff modifies existing behavior (not new code); the
existing suite doesn't cover the changed path; the change introduces a new
failure mode for existing callers. When uncertain, err on the side of writing
the test. Commit as `test: regression test for {what broke}`.

## Coverage diagram

Include BOTH code paths and user flows; mark E2E-worthy and eval-worthy paths:

```
CODE PATHS                                            USER FLOWS
[+] src/services/billing.ts                           [+] Payment checkout
  ├── processPayment()                                  ├── [TESTED***] Complete purchase — checkout.e2e.ts:15
  │   ├── [TESTED***] happy + declined + timeout        ├── [GAP] [->E2E] Double-click submit
  │   ├── [GAP]       Network timeout                   └── [GAP]        Navigate away mid-payment
  │   └── [GAP]       Invalid currency
  └── refundPayment()                                 [+] Error states
      ├── [TESTED** ] Full refund — :89                 ├── [TESTED** ] Card declined message
      └── [TESTED*  ] Partial (non-throw only) — :101   └── [GAP]       Network timeout UX

COVERAGE: 5/13 paths tested (38%)  |  Code paths: 3/5 (60%)  |  User flows: 2/8 (25%)
```

Legend: *** behavior + edge + error | ** happy path | * smoke check.

**Fast paths:** all paths covered → "All new code paths have test coverage."
Diff is test-only changes → "No new application code paths to audit." Skip the
rest.

## Generate tests for uncovered paths

If a test framework exists: prioritize error handlers and edge cases first
(happy paths are more likely already tested); read 2-3 existing test files and
match conventions exactly; mock all external dependencies; for [->E2E] paths
use the project's E2E framework (Playwright, Cypress, Capybara); for [->EVAL]
paths use the project's eval framework or flag for manual eval. Run each test:
passes → commit as `test: coverage for {feature}`; fails → fix once, then
revert and note the gap in the diagram.

Caps: 30 code paths max, 20 tests generated max, 2-minute per-test exploration
cap. No framework and user declined bootstrap → diagram only, note "Test
generation skipped — no test framework configured."

For the PR body: `Tests: {before} -> {after} (+{delta} new)` and
`Coverage audit: N new code paths, M covered (X%), K tests generated`.

## Coverage gate

Check CLAUDE.md for a `## Test Coverage` section with `Minimum:` and `Target:`
percentages; defaults Minimum = 60%, Target = 80%. Using the diagram's
COVERAGE percentage:

- **>= target:** "Coverage gate: PASS ({X}%)." Continue.
- **>= minimum, < target:** AskUserQuestion — A) generate more tests for the
  remaining gaps (recommended: untested paths are where production bugs hide)
  · B) ship anyway, accept the risk · C) mark paths intentionally uncovered.
  On A, loop back to generation (max 2 passes total). B/C get noted in the PR
  body verbatim.
- **< minimum:** AskUserQuestion — A) generate tests (recommended) ·
  B) override and ship with low coverage. Max 2 generation passes; note
  "Coverage gate: OVERRIDDEN at {X}%" on B.
- **Percentage undetermined** (ambiguous diagram): skip the gate with a note —
  do not default to 0% or block. 100% → "Coverage gate: PASS (100%)."
