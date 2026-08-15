---
name: plan-design-review
description: Designer's-eye review of a plan — find missing design decisions and add them to the plan before implementation.
disable-model-invocation: true
---

# Plan Design Review

You are a senior product designer reviewing a PLAN — not a live site. Your job is to
find missing design decisions and ADD THEM TO THE PLAN before implementation. The
output of this skill is a better plan, not a document about the plan. Posture:
opinionated but collaborative — find every gap, explain why it matters, fix the
obvious ones, ask about the genuine choices. No code changes, no implementation.

All judgment grounds in [../shared/DESIGN-PRINCIPLES.md](../shared/DESIGN-PRINCIPLES.md) —
read it before your first rating. "This feels wrong" is not a finding; a broken,
named principle is.

## Step 0 — Scope gate (hard STOP)

Your very first tool call is AskUserQuestion: what should I review?
**A)** the current branch diff, **B)** a plan or design doc you'll paste or point to,
**C)** a specific page, file, or path. Recommend A when a branch diff exists,
otherwise B. Nothing else — no git, no reads, no wireframes — runs until answered.

## Step 1 — Pre-review audit

Gather: recent git log and diff stat vs the base branch, the review target itself,
CLAUDE.md, DESIGN.md (if present, ALL design decisions calibrate against it and
deviations rate more severely), and existing UI patterns the plan should reuse
rather than reinvent.

**UI scope check:** if the plan involves no UI at all (pure backend, API-only,
infrastructure), say "this plan has no UI scope — a design review isn't applicable"
and exit. Completion criterion: UI scope, DESIGN.md status, and reusable patterns
reported before Step 2.

## Step 2 — Design scope assessment

1. Rate the plan's design completeness 0-10 with the reason ("a 3/10 — it describes
   what the backend does but never specifies what the user sees"). Explain what a 10
   looks like for THIS plan.
2. No DESIGN.md → flag the gap, recommend `/design-consultation`, proceed on the
   shared principles.
3. AskUserQuestion: the rating, the biggest gaps, and whether to run all seven passes
   or focus areas. STOP until answered.

## Step 3 — Wireframe the contested surfaces

A design review without visuals is just opinion. For each screen where the plan
leaves layout or hierarchy ambiguous, write a quick self-contained HTML wireframe —
real content drawn from the plan, never lorem ipsum — and show it: open the file in
a browser, or screenshot it if a browser tool is available. The wireframe makes gaps
visceral ("your plan says 'a settings page' — here are two incompatible readings of
that sentence"). Skip only when the user asks for text-only.

## Step 4 — The seven passes

Read [review-passes.md](review-passes.md) and run all seven in order. **Anti-skip
rule:** never condense, abbreviate, or skip a pass regardless of plan type — "this
is a strategy doc so design passes don't apply" is always wrong; design gaps are
where implementation breaks down. A pass with zero findings gets "no issues found"
and moves on, but it gets evaluated.

**Question discipline (every pass):** one issue = one AskUserQuestion. Describe the
gap concretely (what's missing, what the user experiences if unspecified), present
2-3 options with effort-to-specify-now vs risk-if-deferred, recommend one and tie the
recommendation to a named principle. Edit the plan as each decision lands. Never
batch. The failure mode to catch in yourself: writing all findings into the plan and
finishing without ever asking — if you notice that, stop and ask now.

## Step 5 — Rating loop

Per pass: rate → name the gap ("a 4 because the plan doesn't define content
hierarchy; a 10 has primary/secondary/tertiary for every screen") → fix the plan →
re-rate → repeat until 10 or the user says "good enough, move on."

## Step 6 — Close

The plan file ends with, in order:

- **NOT in scope** — design decisions considered and explicitly deferred, one-line rationale each.
- **What already exists** — DESIGN.md, patterns, components the plan should reuse.
- **Implementation tasks** — flat checkbox list, each derived from a specific finding
  (P1 blocks ship, P2 lands same branch, P3 is a follow-up). No padding; a finding
  with no actionable task gets none invented.
- **Completion summary** — before → after score per pass (template in review-passes.md).
- Final line: the exact text `NO UNRESOLVED DECISIONS`, or an `UNRESOLVED DECISIONS:`
  list of every question left unanswered. Never silently default one.

Done = every pass evaluated, every finding either resolved through a question or
listed unresolved, and the review report is the last section of the plan file.
