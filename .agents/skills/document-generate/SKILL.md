---
name: document-generate
description: Diataxis documentation writer — research the whole codebase, partition into tutorial/how-to/reference/explanation, write complete docs. Also audits a diff for doc coverage gaps.
disable-model-invocation: true
---

# Document Generate

You follow the **Diataxis framework** — four quadrants of documentation, each
serving a different reader need:

- **Tutorial** — learning-oriented, walks a newcomer through a working example step-by-step
- **How-to** — task-oriented, shows how to accomplish a specific goal (assumes basic familiarity)
- **Reference** — information-oriented, complete and accurate technical description
- **Explanation** — understanding-oriented, explains why things work the way they do

**Philosophy: research the whole, then write the parts.** Like an architect who
surveys the entire site before drawing a single room, read the full codebase
surface before writing any documentation. This prevents the "documentation that
describes half the feature" failure mode.

Two branches — say which you're in:
- **Generate** (default): write docs for a feature, module, or the whole project.
- **Audit**: build a coverage map of a branch diff — flag gaps, write nothing.
  Jump to [Audit branch](#audit-branch).

## Step 1 — Codebase archaeology

**This is the most important step.** Do not skip or rush it. The quality of your
documentation is directly proportional to how well you understand the code.

1. **Map the project structure** (list files, excluding .git / node_modules /
   dist / build).
2. **Read the entry points:** README.md, ARCHITECTURE.md, CONTRIBUTING.md,
   CLAUDE.md / AGENTS.md; package.json / Cargo.toml / pyproject.toml / go.mod;
   main entry files; config files and examples; any docs-framework config
   (Docusaurus, MkDocs, Nextra, VitePress) — an existing framework's format and
   nav conventions govern the docs you write.
3. **Read the source for each target entity** — implementation files end-to-end
   (not just signatures), the tests (they reveal intended behavior, edge cases,
   and usage patterns), related modules up- and downstream, and inline comments,
   especially `// NOTE:`, `// DESIGN:`, `// WHY:`.
4. **Build a concept map** before writing:

```
Target: [feature/module name]
Purpose: [one sentence — what problem does it solve?]
Key concepts: [the 3-5 concepts a reader must understand]
Public surface: [commands, functions, config options, API endpoints]
Dependencies: [what it needs from other modules]
Dependents: [what relies on it]
Edge cases: [from reading tests and code]
Design decisions: [any non-obvious "why" choices]
```

Completion: "Researched N files, identified K public surface items, M concepts,
and J design decisions."

## Step 2 — Partition into quadrants

| Entity type | Tutorial? | How-to? | Reference? | Explanation? |
|---|---|---|---|---|
| New feature a user interacts with | Yes | Yes | Yes | Maybe |
| CLI command or flag | Maybe | Yes | Yes | No |
| Internal module/architecture | No | No | Yes | Yes |
| Config option | No | Yes | Yes | No |
| Design pattern / philosophy | No | No | No | Yes |
| API endpoint | Maybe | Yes | Yes | No |
| Workflow (multi-step process) | Yes | Yes | No | Maybe |

Output the partition plan as a table (entity × quadrant, marking new / inline /
skip). If it has more than 5 documents to create, confirm via AskUserQuestion;
for smaller scopes, proceed directly.

## Step 3 — Write, one quadrant at a time

Write in this order: reference → explanation → how-to → tutorial (later
quadrants link to earlier ones). Use the templates and per-quadrant rules in
[doc-templates.md](doc-templates.md) — read the relevant template before writing
each document.

## Step 4 — Cross-link and make discoverable

1. Every reference doc links to its how-to; every how-to to its reference;
   tutorials to both.
2. Update entry points: README.md (docs section/TOC), CLAUDE.md / AGENTS.md,
   any docs index or sidebar config.
3. Every new document must be reachable within 2 clicks from README.md.
4. Grep for `](` links pointing at files that don't exist.

## Step 5 — Quality self-review

**Accuracy gate:**
- Every code example compiles / runs / passes if copy-pasted
- Every API description matches the actual code signature
- Every command shown produces the output described
- No stale references to renamed/removed entities

**Completeness gate:**
- Reference docs cover 100% of public surface
- How-tos cover the top 3 tasks a user would attempt
- Tutorials get to a working result in <=3 steps
- Explanation docs name trade-offs, not just choices

**Voice gate:**
- Written for a smart person who hasn't seen the code
- No jargon without brief inline gloss on first use
- Active voice, concrete nouns, short sentences
- "You can now..." not "The system provides..."

Fix any failures before finishing.

## Audit branch

Build a **coverage map** of what shipped vs what's documented — Diataxis as an
audit lens, not a generation tool.

1. **Extract public surface changes from the diff** (`git diff <base>...HEAD`):
   new exported functions/classes/commands/CLI flags/config options/API
   endpoints; new user-facing capabilities; renamed or removed public surface;
   new environment variables or feature flags.
2. **Assess coverage per item:**

```
Coverage map:
  [entity]         [reference?] [how-to?] [tutorial?] [explanation?]
  /new-skill       README        no        no          no
  --new-flag       README        README    no          no
  FooProcessor     no            no        no          no
```

   Where quadrants typically live: Reference = README tables and API docs ·
   How-to = README examples, CONTRIBUTING workflows · Tutorial = getting-started
   guides · Explanation = ARCHITECTURE and design docs. Completion: every new,
   changed, or removed public-surface item from the diff appears in the map.

3. Items with zero coverage are **critical gaps**; reference-only coverage is a
   **common gap**. Flag gaps only — do NOT auto-generate missing pages; offer to
   re-run this skill in generate mode to fill them.
4. **Architecture diagram drift:** if any doc contains ASCII or Mermaid
   diagrams, extract their entity names and cross-reference against the diff —
   flag diagram entities renamed, split, removed, or moved in code.
5. **Per-file audit** of existing docs against the diff:
   - **README.md** — features/capabilities in the diff described? Install/setup
     and examples still valid?
   - **ARCHITECTURE.md** — diagrams and component descriptions match the code?
     Be conservative: only flag things clearly contradicted by the diff.
   - **CONTRIBUTING.md** — the new-contributor smoke test: walk the setup as a
     brand-new contributor; would each command succeed? Flag anything that would
     fail or confuse a first-timer.
   - **CLAUDE.md** — project structure matches the file tree? Listed commands
     accurate?

   Classify each needed update: **factual correction** (table row, file path,
   count — safe to apply) vs **ask user** (narrative changes, section removal,
   rewrites over ~10 lines, ambiguous relevance).

## Rules

- **Research before writing.** Insufficient research produces surface-level
  documentation.
- **Accuracy is non-negotiable.** If unsure about a detail, read the source
  again — do not guess.
- **Diataxis quadrants serve different readers.** Keep them unmixed.
- **Cross-link everything.** Isolated docs are undiscoverable docs.
- **Voice: friendly, concrete, user-forward.** Never corporate, never academic.
- **Completeness over minimalism.** AI makes comprehensive documentation cheap.
  Don't write "minimal viable docs" — write complete docs. Boil the ocean.
