# Step 0 — DX Investigation (plan branch, before scoring)

The core principle: **gather evidence and force decisions BEFORE scoring, not
during scoring.** Steps 0A-0G build the evidence base; the 8 passes use that
evidence to score with precision instead of vibes.

## 0A. Developer Persona Interrogation

Before anything else, identify WHO the target developer is. Different
developers have completely different expectations, tolerance levels, and mental
models.

**Gather evidence first:** README "who is this for" language, package.json
description/keywords, design-doc user mentions, docs/ audience signals. Then
present concrete archetypes via AskUserQuestion — the inferred persona first,
2 alternatives, plus "let me describe my target developer".

Persona archetypes (pick the 3 most relevant):
- **YC founder building MVP** — 30-minute integration tolerance, won't read docs, copies from README
- **Platform engineer at Series C** — thorough evaluator, cares about security/SLAs/CI integration
- **Frontend dev adding a feature** — TypeScript types, bundle size, React/Vue/Svelte examples
- **Backend dev integrating an API** — cURL examples, auth flow clarity, rate limit docs
- **OSS contributor from GitHub** — git clone && make test, CONTRIBUTING.md, issue templates
- **Student learning to code** — needs hand-holding, clear error messages, lots of examples
- **DevOps engineer setting up infra** — Terraform/Docker, non-interactive mode, env vars

After the user responds, produce a persona card:

```
TARGET DEVELOPER PERSONA
========================
Who:       [description]
Context:   [when/why they encounter this tool]
Tolerance: [how many minutes/steps before they abandon]
Expects:   [what they assume exists before trying]
```

**STOP.** Do NOT proceed until the user responds. This persona shapes the
entire review.

## 0B. Empathy Narrative

Write a 150-250 word first-person narrative from the persona's perspective
walking the ACTUAL getting-started path from the README/docs. Not
hypothetical — trace the real path: "I open the README. The first heading is
[actual heading]. I run [actual install command] and see..." Be specific about
what they see, try, feel, and where they get confused.

Show it via AskUserQuestion: "Does this match reality? Where am I wrong?"
(accurate / some corrections / way off). **STOP**, incorporate corrections. The
narrative becomes a "Developer Perspective" section in the plan — the
implementer should read it and feel what the developer feels.

## 0C. Competitive DX Benchmarking

Run three WebSearches: "[category] getting started developer experience
{year}", "[closest competitor] developer onboarding time", "[category] SDK CLI
developer experience best practices {year}". If search is unavailable, use
reference benchmarks: Stripe 30s TTHW, Vercel 2min, Firebase 3min, Docker 5min.

Produce the table (Tool | TTHW | Notable DX Choice | Source, with YOUR PRODUCT
last), then AskUserQuestion: where do you want to land? A) Champion tier
(<2 min — requires [specific changes]) · B) Competitive (2-5 min — [gap to
close]) · C) Current trajectory · D) tell me what's realistic. **STOP.** The
chosen tier becomes the benchmark for Pass 1.

## 0D. Magical Moment Design

Every great developer tool has a magical moment: the instant a developer goes
from "is this worth my time?" to "oh wow, this is real." Load Pass 1 of
[hall-of-fame.md](hall-of-fame.md) for examples, identify this product's
moment, then ask how the persona should experience it:

- A) **Interactive playground/sandbox** — zero install, try in browser. Highest conversion; requires a hosted environment. (Stripe API explorer, Supabase SQL editor)
- B) **Copy-paste demo command** — one terminal command producing the magical output. Low effort, high impact for CLI tools. (`npx create-next-app`, `docker run hello-world`)
- C) **Video/GIF walkthrough** — shows the magic with zero setup, but passive. (Vercel's deploy animation)
- D) **Guided tutorial with the developer's own data** — deepest engagement, longest time-to-magic. (Stripe interactive onboarding)
- E) Something else.

Give a RECOMMENDATION with the persona-based reason and what the competitor
does. **STOP.** The chosen vehicle is tracked through the scoring passes.

## 0E. Mode Selection

AskUserQuestion — how deep should this review go?

- A) **DX EXPANSION** — DX as competitive advantage; propose ambitious improvements beyond the plan, each opt-in individually. Push hard.
- B) **DX POLISH** — scope is right; make every touchpoint bulletproof. No scope additions, maximum rigor. (recommended for most reviews)
- C) **DX TRIAGE** — only the critical gaps that would block adoption. Fast, surgical, for plans shipping soon.

Defaults: new developer-facing product → EXPANSION; enhancement → POLISH; bug
fix/urgent → TRIAGE. Once selected, commit fully — do not silently drift.
**STOP.**

```
             | DX EXPANSION     | DX POLISH          | DX TRIAGE
Scope        | Push UP (opt-in) | Maintain           | Critical only
Posture      | Enthusiastic     | Rigorous           | Surgical
Competitive  | Full benchmark   | Full benchmark     | Skip
Magical      | Full design      | Verify exists      | Skip
Journey      | All stages +     | All stages         | Install + Hello
             | best-in-class    |                    | World only
Passes       | All 8, expanded  | All 8, standard    | Pass 1 + 3 only
```

## 0F. Developer Journey Trace

For each stage — Discover, Install, Hello World, Real Usage, Debug, Upgrade
(TRIAGE mode: Install + Hello World only):

1. **Trace the actual path.** Read what the developer would encounter at this
   stage; reference specific files and lines.
2. **Identify friction points with evidence.** Not "installation might be hard"
   but "Step 3 of the README requires Docker running, nothing checks for it,
   and a [persona] without Docker sees [specific error]."
3. **One AskUserQuestion per friction point** (never batch): A) fix in plan
   [specific fix] · B) alternative · C) document prominently · D) acceptable
   friction. In EXPANSION mode, also ask per stage: "what would make this stage
   best-in-class?"

Then output the journey map table (STAGE | DEVELOPER DOES | FRICTION POINTS |
STATUS fixed/ok/deferred).

## 0G. First-Time Developer Roleplay

Using the persona and journey trace, write a timestamped confusion log grounded
in the ACTUAL docs (real README headings, real error messages, real file
paths):

```
FIRST-TIME DEVELOPER REPORT
============================
Persona: [from 0A]
Attempting: [product] getting started

CONFUSION LOG:
T+0:00  [What they do first. What they see.]
T+0:30  [Next action. What surprised or confused them.]
T+1:00  [What they tried. What happened.]
T+2:00  [Where they got stuck or succeeded.]
T+3:00  [Final state: gave up / succeeded / asked for help]
```

AskUserQuestion: which confusion points should the plan address? A) all ·
B) let me pick · C) the critical ones · D) unrealistic, our developers already
know [context]. **STOP.**
