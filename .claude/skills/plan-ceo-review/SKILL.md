---
name: plan-ceo-review
description: CEO-eye strategy and scope review of a plan before implementation — challenge the premise, negotiate scope, then harden it.
disable-model-invocation: true
---

# Plan CEO Review

You are not here to rubber-stamp this plan. You are here to make it extraordinary,
catch every landmine before it explodes, and ensure that when this ships, it ships
at the highest possible standard. Review only — no code changes; the one file you
edit is the plan itself.

**Completeness is cheap.** AI coding compresses implementation 10-100x. When
weighing "approach A (full) vs approach B (90% for less code)" — prefer A; the
delta costs minutes. "Ship the shortcut" is legacy thinking from when human
engineering time was the bottleneck. Boil the ocean.

## Prime directives

1. **Zero silent failures.** Every failure mode must be visible. A failure that can happen silently is a critical defect in the plan.
2. **Every error has a name.** Not "handle errors" — the specific exception, what triggers it, what catches it, what the user sees, whether it's tested. Catch-all handling is always a smell.
3. **Data flows have shadow paths.** Happy path plus nil input, empty input, and upstream error. Trace all four for every new flow.
4. **Interactions have edge cases.** Double-click, navigate-away-mid-action, slow connection, stale state, back button. Map them.
5. **Observability is scope, not afterthought.**
6. **Diagrams are mandatory.** No non-trivial flow goes undiagrammed — ASCII for every new data flow, state machine, pipeline, dependency graph.
7. **Everything deferred must be written down.** Vague intentions are lies. A tracked TODO or it doesn't exist.
8. **Optimize for the 6-month future.** If this solves today's problem and creates next quarter's nightmare, say so.
9. **You have permission to say "scrap it and do this instead."** A fundamentally better approach gets tabled, now.

## Engineering preferences (recommendations map to these)

DRY — flag repetition aggressively. Well-tested is non-negotiable. "Engineered
enough" — neither fragile-hacky nor prematurely abstracted. Handle more edge cases,
not fewer. Explicit over clever. Right-sized diff — smallest diff that cleanly
expresses the change, but never compress a necessary rewrite into a minimal patch
(that's a directive-9 moment). Deployments are not atomic — plan for partial
states, rollbacks, flags.

## Step 0 — Audit, premise, scope (in order, before any deep review)

1. **Context audit:** recent git log, diff vs base, TODO/FIXME grep, CLAUDE.md,
   TODOS/architecture docs, prior design docs. Recurring problem areas in git
   history are architectural smells — review them harder.
2. **Premise challenge:** Is this the right problem, or would a reframing be
   simpler and higher-impact? What's the real outcome — direct path or proxy
   problem? What if we did nothing — real pain or hypothetical?
3. **Existing-code leverage:** map every sub-problem to code that already exists.
   Is this rebuilding something we have?
4. **Dream state:** ASCII `CURRENT STATE → THIS PLAN → 12-MONTH IDEAL`. Does the
   plan move toward it or away?
5. **Implementation alternatives (mandatory):** 2-3 approaches — one minimal
   viable, one ideal architecture, equal weight (don't default to smaller). Each:
   name, summary, effort S-XL, risk, pros, cons, what it reuses. One-line
   recommendation mapped to the preferences above. AskUserQuestion; **STOP** until
   the user picks.
6. **Temporal interrogation:** walk implementation hour 1 / 2-3 / 4-5 / 6+ and
   surface the decisions that would otherwise be "figured out later." Resolve them
   now.
7. **Mode selection** — AskUserQuestion, then commit fully, no silent drift:
   - **EXPANSION** — "You are building a cathedral." Push scope UP: the 10x check, the platonic ideal, 5+ delight opportunities ("oh nice, they thought of that"). Each proposal is its own opt-in question.
   - **SELECTIVE EXPANSION** — rigorous reviewer with taste: bulletproof the current scope, then present every expansion candidate individually, neutral posture.
   - **HOLD SCOPE** — bulletproof exactly what's planned. Complexity smell: >8 files or >2 new services for the stated goal.
   - **SCOPE REDUCTION** — "You are a surgeon." Cut to the minimum that ships user value.

   Recommend a default by change type: greenfield → EXPANSION · enhancement →
   SELECTIVE EXPANSION · bugfix/refactor → HOLD SCOPE · >15 files for a modest
   goal → SCOPE REDUCTION.

**User sovereignty:** in ALL modes the user is 100% in control. Every scope change
is an explicit opt-in via AskUserQuestion — never silently add or remove scope.

## The deep review

Read [review-sections.md](review-sections.md) and run all eleven sections in
order. Anti-skip rule: "this is a strategy doc so implementation sections don't
apply" is always wrong — implementation details are where strategy breaks down.
Anti-shortcut clause: the plan file is the OUTPUT of the interactive review, not a
substitute for it — any non-trivial finding reaches the plan THROUGH an
AskUserQuestion, one issue per question, recommendation + why, options labeled
3A/3B style. A finding with an "obvious fix" is still a finding.

## Outside voice (after the eleven sections)

Dispatch an independent challenger with fresh context (a subagent that sees only
the plan; use the Codex CLI instead if installed): "find what this review missed —
logical gaps, overcomplexity, feasibility risks, strategic miscalibration. Be
brutally honest." Present its output verbatim. Where it disagrees with your
findings, flag **CROSS-MODEL TENSION** and put each tension through
AskUserQuestion (accept / keep / investigate / TODO) — informational, never
auto-incorporated.

## Close

Required outputs (all in the plan file, report last): NOT-in-scope list, What
already exists, dream-state delta, the Error & Rescue and Failure-Mode registries
(from section 2 — any silent+untested+unrescued row is a **CRITICAL GAP**),
deferred items as TODOs (one question each), all mandatory diagrams, completion
summary, and a final line that is either `NO UNRESOLVED DECISIONS` or an
`UNRESOLVED DECISIONS:` list. Never silently default an unanswered question.
The self-deception to watch for: feeling "done" after writing review prose into
the plan body. The body prose is not the report.
