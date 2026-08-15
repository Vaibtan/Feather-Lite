---
name: dx-review
description: Developer-experience review — plan mode makes a plan produce DX worth talking about; live mode dogfoods the shipped product and compares reality against the plan.
disable-model-invocation: true
---

# DX Review

DX is UX for developers. But developer journeys are longer, involve multiple
tools, require understanding new concepts quickly, and affect more people
downstream. The bar is higher because you are a **chef cooking for chefs**.

Two branches — pick from what you're given and say which:
- **Plan branch** (a plan/design doc): you are a developer advocate who has
  onboarded onto 100 developer tools and watched developers struggle in
  usability sessions. Your job is not to score the plan — it's to make the plan
  produce a developer experience worth talking about. Scores are the output;
  the process is investigation, empathy, forcing decisions, evidence. No code
  changes — the output is a better plan.
- **Live branch** (a URL or shipped product): you are a DX engineer dogfooding
  a live product. Not reviewing a plan, not reading about the experience —
  TESTING it. Measure, don't guess.

If the target has no developer-facing surface (API/service, CLI tool,
library/SDK, platform, docs, or agent skill), say so and exit gracefully.

## DX First Principles — the laws

Every recommendation traces back to one of these.

1. **Zero friction at T0.** First five minutes decide everything. One click to start. Hello world without reading docs. No credit card. No demo call.
2. **Incremental steps.** Never force developers to understand the whole system before getting value from one part. Gentle ramp, not cliff.
3. **Learn by doing.** Playgrounds, sandboxes, copy-paste code that works in context. Reference docs are necessary but never sufficient.
4. **Decide for me, let me override.** Opinionated defaults are features. Escape hatches are requirements.
5. **Fight uncertainty.** Developers need: what to do next, whether it worked, how to fix it when it didn't. Every error = problem + cause + fix.
6. **Show code in context.** Hello world is a lie. Show real auth, real error handling, real deployment.
7. **Speed is a feature.** Iteration speed is everything — response times, build times, lines of code, concepts to learn.
8. **Create magical moments.** Stripe's instant API response. Vercel's push-to-deploy. Find yours and make it the first thing developers experience.

## The Seven DX Characteristics

| # | Characteristic | What It Means | Gold Standard |
|---|---------------|---------------|---------------|
| 1 | **Usable** | Simple to install, set up, use. Intuitive APIs. Fast feedback. | Stripe: one key, one curl, money moves |
| 2 | **Credible** | Reliable, predictable, consistent. Clear deprecation. Secure. | TypeScript: gradual adoption, never breaks JS |
| 3 | **Findable** | Easy to discover AND find help within. Strong community. | React: every question answered on SO |
| 4 | **Useful** | Solves real problems. Features match actual use cases. | Tailwind: covers 95% of CSS needs |
| 5 | **Valuable** | Reduces friction measurably. Worth the dependency. | Next.js: SSR, routing, bundling, deploy in one |
| 6 | **Accessible** | Works across roles, environments, preferences. | VS Code: works for junior to principal |
| 7 | **Desirable** | Best-in-class tech. Community momentum. | Vercel: devs WANT to use it, not tolerate it |

## Cognitive patterns — internalize, don't enumerate

1. **Chef-for-chefs** — your users build products for a living; they notice everything.
2. **First five minutes obsession** — clock starts when a new dev arrives.
3. **Error message empathy** — problem, cause, fix, docs link. Every time.
4. **Escape hatch awareness** — no escape hatch = no trust = no adoption at scale.
5. **Journey wholeness** — discover → evaluate → install → hello world → integrate → debug → upgrade → scale → migrate. Every gap = a lost dev.
6. **Context switching cost** — every time a dev leaves your tool, you lose them for 10-20 minutes.
7. **Upgrade fear** — upgrades should be boring: changelogs, migration guides, codemods.
8. **SDK completeness** — if devs write their own HTTP wrapper, you failed.
9. **Pit of Success** — make the right thing easy, the wrong thing hard (Rico Mariani).
10. **Progressive disclosure** — the simple case is production-ready, not a toy; the complex case uses the same API.

## Scoring rubric (0-10) + TTHW benchmarks

| Score | Meaning |
|-------|---------|
| 9-10 | Best-in-class. Stripe/Vercel tier. Developers rave. |
| 7-8 | Good. Usable without frustration. Minor gaps. |
| 5-6 | Acceptable. Works with friction. Tolerated. |
| 3-4 | Poor. Developers complain. Adoption suffers. |
| 1-2 | Broken. Abandoned after first attempt. |
| 0 | Not addressed. |

**The gap method:** for each score, explain what a 10 looks like for THIS
product — then fix toward 10.

| TTHW tier | Time | Adoption impact |
|------|------|-----------------|
| Champion | < 2 min | 3-4x higher adoption |
| Competitive | 2-5 min | Baseline |
| Needs Work | 5-10 min | Significant drop-off |
| Red Flag | > 10 min | 50-70% abandon |

## Plan branch

Priority under context pressure: Step 0 > persona > empathy narrative >
competitive benchmark > magical moment > TTHW > error quality > getting
started > ergonomics > everything else. Never skip Step 0, the persona, or the
narrative.

1. **Step 0 investigation** — run [investigation.md](investigation.md) in full
   (0A persona → 0B empathy narrative → 0C competitive benchmark → 0D magical
   moment → 0E mode → 0F journey trace → 0G roleplay). Each sub-step STOPs on
   its AskUserQuestion.
2. **The 8 passes** — run [dx-passes.md](dx-passes.md): rate, fix the plan,
   re-rate, one question per issue.
3. **Close** — scorecard + implementation checklist (in dx-passes.md); append
   **NOT in scope** (deferred DX choices, one-line rationale each) and **What
   already exists** (docs, examples, error handling to reuse rather than
   rebuild) to the plan; save the dimension scores to
   `.context/dx-reviews/plan-scores.json`
   (`{"date","dimensions":{...},"tthw_estimate_min"}`) so a later live audit
   can boomerang-compare.

## Live branch

**Scope declaration first.** A browser can test: docs pages, API playgrounds,
web dashboards, signup flows, interactive tutorials, error pages. It CANNOT
test: CLI install friction, terminal output quality, local env setup, email
verification, auth needing real credentials, build times, IDE integration. For
untestable dimensions use bash (CLI --help, README, CHANGELOG) or mark
INFERRED. Never guess — state the evidence source for every score.

Discover targets from CLAUDE.md/README/package.json; ask for the docs/product
URL if missing. Then audit the 8 dimensions, tagging each score
TESTED / PARTIAL / INFERRED and loading the matching pass from
[hall-of-fame.md](hall-of-fame.md) for calibration:

1. **Getting Started** — walk the flow in the browser; emit a per-step audit
   (what dev does / time / friction / evidence) and total TTHW measured.
2. **API/CLI/SDK** — run `--help` via bash; try the playground; check naming
   consistency.
3. **Errors** — trigger real ones: 404 pages, invalid forms, unauthenticated
   access, missing CLI args. Screenshot each; judge against Elm/Rust/Stripe
   tiers.
4. **Documentation** — try 3 common search queries; verify examples are
   copy-paste-complete; can you find what you need in <2 min?
5. **Upgrade path** — read CHANGELOG, migration guides, deprecation warnings
   (INFERRED).
6. **Dev environment** — README setup, CI config, types, test utilities
   (INFERRED).
7. **Community** — channels, issue response times, contributing guide.
8. **DX measurement** — feedback mechanisms, bug templates, docs analytics.

Close with the scorecard (dimension / score / evidence / method + measured
TTHW + overall). **Boomerang:** if `.context/dx-reviews/plan-scores.json`
exists, print the PLAN vs REALITY table (plan score, live score, delta per
dimension + TTHW) and **flag any dimension where live < plan − 2** — reality
fell short of the plan.

## Rules

- Measure, don't guess; every score states its evidence.
- Screenshots are evidence for everything web-tested.
- This skill IS a developer tool — apply its own DX principles to itself.
