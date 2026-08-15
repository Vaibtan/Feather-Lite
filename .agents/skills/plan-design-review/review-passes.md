# The seven passes

Run in order. Rate each 0-10; the fix target is always 10. One issue = one
AskUserQuestion (see the question discipline in SKILL.md).

## Pass 1 — Information Architecture

Does the plan define what the user sees first, second, third?
Fix to 10: add information hierarchy to the plan — an ASCII diagram of screen
structure and navigation flow. Apply constraint worship: if you can only show 3
things, which 3?

## Pass 2 — Interaction State Coverage

Does the plan specify loading, empty, error, success, and partial states?
Fix to 10: add an interaction state table:

```
FEATURE           | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
------------------|---------|-------|-------|---------|--------
[each UI feature] | [spec]  | [spec]| [spec]| [spec]  | [spec]
```

For each state describe what the user SEES, not backend behavior. Empty states are
features — specify warmth, primary action, context.

## Pass 3 — User Journey & Emotional Arc

Does the plan consider the user's emotional experience?
Fix to 10: add a journey storyboard:

```
STEP | USER DOES     | USER FEELS      | PLAN SPECIFIES?
-----|---------------|-----------------|----------------
1    | Lands on page | [what emotion?] | [what supports it?]
```

Apply time-horizon design: 5-second visceral, 5-minute behavioral, 5-year reflective.

## Pass 4 — AI Slop Risk

Does the plan describe specific, intentional UI — or generic patterns?
Judge against the **Design hard rules** and **AI slop blacklist** in
`../shared/DESIGN-PRINCIPLES.md`: classify the surface (marketing / app UI / hybrid),
check the seven hard rejections, run the seven litmus checks, and interrogate vague
language ("clean, modern UI" is meaningless — replace with actual decisions).
If wireframes were made in Step 3, evaluate them against the blacklist too.
Fix to 10: rewrite vague UI descriptions with specific alternatives.

## Pass 5 — Design System Alignment

Does the plan align with DESIGN.md?
Fix to 10: annotate the plan with specific tokens/components from DESIGN.md. No
DESIGN.md → flag the gap and recommend `/design-consultation`. Flag every new
component: does it fit the existing vocabulary or invent a parallel one?

## Pass 6 — Responsive & Accessibility

Does the plan specify mobile/tablet behavior, keyboard nav, screen readers?
Fix to 10: responsive specs per viewport — not "stacked on mobile" but intentional
layout changes — plus a11y: keyboard patterns, ARIA landmarks, touch targets
(44px minimum), contrast requirements.

## Pass 7 — Unresolved Design Decisions

Surface the ambiguities that will haunt implementation:

```
DECISION NEEDED                  | IF DEFERRED, WHAT HAPPENS
---------------------------------|---------------------------
What does empty state look like? | Engineer ships "No items found."
Mobile nav pattern?              | Desktop nav hides behind hamburger
```

Wireframes make these concrete ("the wireframe shows a sidebar — what happens to it
at 375px?"). Each decision = one AskUserQuestion with recommendation + why +
alternatives; edit the plan as each is made.

## Completion summary template

```
+=============================================================+
|        DESIGN PLAN REVIEW — COMPLETION SUMMARY              |
+=============================================================+
| Pass 1  (Info Arch)  | __/10 → __/10 after fixes            |
| Pass 2  (States)     | __/10 → __/10 after fixes            |
| Pass 3  (Journey)    | __/10 → __/10 after fixes            |
| Pass 4  (AI Slop)    | __/10 → __/10 after fixes            |
| Pass 5  (Design Sys) | __/10 → __/10 after fixes            |
| Pass 6  (Responsive) | __/10 → __/10 after fixes            |
| Pass 7  (Decisions)  | __ resolved, __ deferred             |
+-------------------------------------------------------------+
| NOT in scope         | written (__ items)                   |
| What already exists  | written                              |
| Implementation tasks | __ tasks (P1: __, P2: __, P3: __)    |
| Overall design score | __/10 → __/10                        |
+=============================================================+
```

All passes 8+ → "Plan is design-complete. Run /design-review after implementation
for visual QA." Any below 8 → note what's unresolved and why the user deferred it.
