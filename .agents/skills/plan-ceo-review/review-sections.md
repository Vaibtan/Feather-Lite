# The eleven review sections

Run in order, after Step 0 scope is agreed. Every section is evaluated; zero
findings = "no issues found," stated explicitly. One issue = one AskUserQuestion
(recommend + why, mapped to an engineering preference). Review only — no code.

## 1. Architecture

Component boundaries and dependency graph. Data flow on all four paths (happy /
nil / empty / error — each diagrammed). State machines including impossible
transitions and what prevents them. New coupling (before/after graph). Scaling:
what breaks first at 10x? 100x? Single points of failure. Security architecture
per endpoint: who can call it, what they get, what they change. One realistic
production failure per integration point. Rollback posture: revert, flag, or
migration — and how long. Required: full system ASCII diagram.
EXPANSION add-on: what would make this architecture beautiful?

## 2. Error & rescue map

The section that catches silent failures. It is not optional. Two tables:

```
METHOD/CODEPATH → WHAT CAN GO WRONG → EXCEPTION CLASS
EXCEPTION CLASS → RESCUED? → RESCUE ACTION → USER SEES → TESTED? → LOGGED?
```

Every rescued error must retry-with-backoff, degrade with a user-visible message,
or re-raise with context — "swallow and continue" is almost never acceptable. For
LLM/AI calls: malformed output, empty output, hallucinated JSON, and refusal are
distinct failure modes.

## 3. Security & threat model

Attack surface expansion. Input validation: nil, empty, wrong type, too long,
unicode, injection. Authorization and IDOR — can user A reach user B's data by
manipulating IDs? Secrets in env, rotatable. Dependency risk. Data classification
(PII/payment/credentials). Injection vectors: SQL, command, template, LLM-prompt.
Audit logging. Per finding: threat, likelihood H/M/L, impact H/M/L, mitigated?

## 4. Data flow & interaction edge cases

ASCII `INPUT → VALIDATION → TRANSFORM → PERSIST → OUTPUT` with a shadow-path
column under each node (nil, empty, wrong type, exception, timeout, conflict,
duplicate key, stale, partial, encoding) — each: handled? tested? Interaction
table: double-click, stale CSRF, submit-during-deploy, navigate-away, retry
in-flight, zero results, 10k results, results change mid-page, job fails 3-of-10,
job runs twice, queue backs up. Unhandled case = gap + proposed fix.

## 5. Code quality

Module fit and organization. Aggressive DRY (cite file+line). Naming says what,
not how. Over-engineering (abstraction for a problem that doesn't exist) and
under-engineering (happy-path-only). Flag any new method branching >5 times.

## 6. Tests

Diagram every new thing: UX flows, data flows, codepaths, async jobs,
integrations, error paths. Per item: test type (unit/integration/system/E2E),
does a test exist (if not, write the spec header), happy + failure + edge.
Test-ambition check: the test that makes you confident shipping at 2am on a
Friday; the test a hostile QA engineer would write; the chaos test. Flakiness
risk: time, randomness, external services, ordering. For LLM/prompt changes:
name the eval suite, cases, and baseline.

## 7. Performance

N+1 queries. Memory: max production size per structure. An index for every new
query. Caching opportunities. Background jobs sized for worst-case payload,
runtime, retry. Top-3 slowest new codepaths and their p99. Connection-pool
pressure.

## 8. Observability & debuggability

New systems break; this section ensures you can see why. Structured logs at
entry/exit/branches. Metrics that distinguish working from broken. Trace-ID
propagation. Alerts. Day-1 dashboard panels. The debuggability test: bug reported
3 weeks post-ship — can you reconstruct what happened from logs alone? Runbook
per failure mode.

## 9. Deployment & rollout

Migration safety: backward-compatible, zero-downtime, lock behavior. Feature
flags. Rollout order (migrate first). Explicit step-by-step rollback. The
deploy-time risk window where old and new code run simultaneously. Post-deploy
verification: first 5 minutes, first hour. Smoke tests.

## 10. Long-term trajectory

Tech debt created (code, ops, testing, docs). Path dependency — does this make
future changes harder? Knowledge concentration. Reversibility rated 1-5
(1 = one-way door, 5 = easily reversible). The 1-year question: obvious to a new
engineer in 12 months?

## 11. Design & UX (skip only if zero UI scope)

The CEO calling in the designer — intentionality, not pixels. Information
architecture (first/second/third). Interaction-state coverage
(loading/empty/error/success/partial per feature). Journey emotional arc. AI slop
risk (judge against `../shared/DESIGN-PRINCIPLES.md`). DESIGN.md alignment.
Responsive intention. Accessibility basics. Required: user-flow ASCII diagram.
Significant UI → recommend a full `/plan-design-review`.

## Cognitive patterns — how great CEOs think

Not checklist items; thinking instincts. Classification instinct (reversibility ×
magnitude — most things are two-way doors; move fast). Inversion reflex (for every
"how do we win?" ask "what would make us fail?"). Focus as subtraction (primary
value-add is what NOT to do). Speed calibration (70% information is enough).
Proxy skepticism (are the metrics still serving users?). Temporal depth (5-10
year arcs, regret minimization). Leverage obsession (one person with the right
tool outperforms a team of 100 without it). Willfulness as strategy (the world
yields to people who push in one direction long enough). Courage accumulation
(confidence comes FROM hard decisions, not before them — the struggle IS the job).

## Completion summary

Tally per section: issues found / resolved / deferred, the two registries, scope
proposals accepted/deferred/skipped, outside-voice tensions, diagrams produced,
and the final unresolved-decisions status. End the plan file with it.
