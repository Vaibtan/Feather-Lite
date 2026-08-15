---
name: ask-garry
description: Ask which skill or flow fits your situation. A router over the gstack-distilled skills.
disable-model-invocation: true
---

# Ask Garry

You don't remember every skill, so ask. This routes the product-and-ship half
of the system: planning reviews, design, QA, security, docs, and the deploy
pipeline. The engineering loop itself — grilling, specs, tickets, implement,
TDD — is the matt-pocock set; `/ask-matt` routes that half.

## The main flow: idea → shipped and verified

1. **`/office-hours`** — pressure-test the idea before any plan exists:
   startup diagnostic or builder brainstorm. Ends in a design doc, never code.
2. **Plan reviews** — run the ones the plan deserves, in this order:
   - **`/plan-ceo-review`** — strategy and scope: premise challenge, mandatory
     alternatives, the four scope modes (cathedral → surgeon).
   - **`/plan-design-review`** — if the plan has UI scope: seven passes that
     put missing design decisions INTO the plan.
   - **`/dx-review`** — if the product is developer-facing: the plan branch
     scores 8 DX dimensions and saves them so a later live audit can
     boomerang-compare reality against the plan.
3. **Build** — hand off to the engineering loop (`/ask-matt`'s main flow:
   grill → spec → tickets → implement).
4. **`/qa`** — browser-test what got built like a real user; fix loop, or
   `report-only` to find without fixing.
5. **`/ship`** — merge base, tests, coverage + plan-completion audits,
   CHANGELOG, bisectable commits, push, PR. Delegates review to
   `/code-review`.
6. **`/canary --baseline`** — capture the pre-deploy baseline NOW, before
   merging. The most-forgotten step: without it, later monitoring is just a
   health check.
7. **`/land-and-deploy`** — merge the PR, wait for CI/deploy, verify
   production once, offer revert. First run is a teacher-mode dry run; the
   `setup` argument (re)configures deploy settings.
8. **`/canary`** — watch production against the baseline; alerts on changes,
   not absolutes.

## The design flow

A separate loop for visual work; each step's output feeds the next.

- **`/design-consultation`** — no design system yet: taste interview →
  complete proposal with named risks → DESIGN.md. Everything downstream
  calibrates against DESIGN.md once it exists.
- **`/design-shotgun`** — divergent HTML variants side by side; approving one
  trains the taste profile that biases future design runs.
- **`/design-html`** — one production-quality page from a mockup, plan, or
  description, with computed text layout.
- **`/design-review`** — live audit + fix loop on the rendered site.
  Model-invoked: "this looks generic/AI-generated" reaches it without the
  slash. `/plan-design-review` is the plan-time counterpart; this one needs
  the running site.

## On a cadence

- **`/health`** — the project's own quality tools, scored 0-10 and trended.
- **`/cso`** — security audit, aggressively FP-filtered. Bare = zero-noise
  daily mode; `--comprehensive` surfaces everything; `--diff` scopes to the
  branch.
- **`/retro`** — engineering retrospective over a window (default 7d):
  metrics, per-person praise and growth, trends across runs.
- **`/document-generate`** — Diataxis docs after shipping; its audit branch
  maps a diff's doc-coverage gaps without writing anything.

## Standalone

- **`/diagram`** — English in, rendered + editable mermaid out. Model-invoked:
  "draw this" reaches it without the slash.

## Conventions

State lives in `.context/` at the repo root (gitignore it): qa / security /
deploy / canary reports, health history, DX scores, retro snapshots, learnings.
Taste memory: `~/.claude/design-taste/<project>.json`. `/qa`,
`/design-review`, `/canary`, and dx-review's live branch want a browser MCP
(canary degrades to curl).
