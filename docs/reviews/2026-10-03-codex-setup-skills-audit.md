# Codex setup and skills audit

Date: 2026-10-03. Scope: recommendations for Feather-Lite with GPT-6.1 Sol, GPT-6 Luna, and occasional GPT-6 Astra. Existing instructions, skills, configuration, dependencies, and Git state were not modified. This report and its companion research note are the audit artifacts.

## Recommendation

Keep the concise global preferences. Curate the project around a small set of engineering workflows, repair their runtime assumptions and decision boundaries, and import only `effect-service-design` from dmmulroy as a separate workflow. Put a few relevant TypeScript principles in one reference. Evaluate anti-slop as a linter independently of the skill cleanup.

Use shared instructions for all three models. Keep explicit requirements, acceptance criteria, repository conventions, and useful examples; remove repeated encouragement, rigid ceremonies, and instructions for unavailable tools. These are proposed improvements, not measured model-performance gains.

## Evidence and research

- Inspected both complete Codex TOML files; both parse with Python `tomllib`. Installed CLI reports `codex-cli 0.160.0`.
- Read all 40 unique project `SKILL.md` bodies and examined metadata, relevant references/templates, and cross-skill dependencies. There are 37 skills under `.agents/skills`, with 15 permitting implicit invocation and 22 carrying `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- `.claude/skills` has 37 junctions to those same directories, three unique directories (`commit-work`, `resolving-merge-conflicts`, `thermo-nuclear-code-quality-review`), and a broken `pwc-cli` symbolic link. Traversing junctions gives 77 readable skill paths but only 40 unique skills. Unique root skill bodies total 182,573 bytes; this is disk content, not context loaded every turn.
- Read the global and project `AGENTS.md`, project `docs/agents/*`, global rule file, global custom skills, system-skill metadata/instructions relevant to this audit, plugin/MCP configuration, package manifests, strict compiler settings, relevant ADR and test configuration. No project `CLAUDE.md` or nested project `AGENTS.md` was found. Global `~/.claude/CLAUDE.md` is empty; its settings have no configured hook events. Authentication files and credential values were excluded.
- Read the complete [X article](https://x.com/pvncher/status/2095991462416490862) through a public mirror after X failed to load. Its title is *Rethinking skills and prompts for GPT-6 Astra*. Also read [the official OpenAI publication](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
- Read [the GPT-6 family guide](https://developers.openai.com/api/docs/guides/latest-model), [model selection](https://developers.openai.com/api/docs/guides/model-selection), and current Codex documentation. Downloaded the current official Codex manual using the installed OpenAI Docs helper; used its relevant sections rather than reading the whole manual.
- Upstream source findings, pinned revisions, and anti-slop compatibility evidence are in [the dmmulroy audit](2026-10-03-dmmulroy-skills-audit.md).
- Ran `pnpm lint`: exit 0, but no workspace package defines `lint`; the root `pnpm -r --if-present lint` therefore runs no lint checks. Application tests were not run for this recommendation-only audit. No paid model comparisons or provider calls were made.

The OpenAI article supports short, precise triggers, references loaded on demand, task-scoped reading, clear completion, and revisiting unnecessary pauses. It explicitly warns that guidance helpful to Sol or Luna may overconstrain Astra. Retain useful scaffolding for your primary models and tune from observed outcomes rather than deleting every procedure. [Source](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

## Priority fixes

| Priority | Finding | Proposed correction |
| --- | --- | --- |
| High | `implement` automatically commits; `setup-pre-commit`, `scaffold-exercises`, `prototype`, and `wizard` also contain commit instructions. Merge resolution says to stage everything. | Keep commits and external publication dependent on the user's requested workflow; stage only intended paths. Ordinary implementation should end with verified changes unless a commit was requested. |
| High | `code-review` advertises work-in-progress review but always uses `<base>...HEAD`, omitting staged and unstaged changes. | Resolve the review target first. For a branch plus working tree, use a pinned merge-base and `git diff <merge-base>`; include relevant untracked files separately. Committed-only review remains `<base>...HEAD`. Preserve one target throughout the review. |
| High | `tdd` requires confirmation before every new test seam; `to-spec` repeats a seam checkpoint, and `grilling` demands an exhaustive decision tree. | Reuse agreed seams and existing tests. Ask when a public interface or consequential design choice materially changes; infer routine test placement. Keep the deliberate interview available when explicitly requested. |
| High | Numerous retained/optional workflows call a nonexistent Claude `Skill` tool. `claude-handoff` launches `claude --bg`. | Read referenced skill files with Codex tools, use existing collaboration capabilities when the workflow needs delegation, and remove the Claude handoff workflow from this project. |
| Medium | `docs/agents/domain.md` points to `CONTEXT.md`/`CONTEXT-MAP.md`; the domain skill and its consumers create/read `GLOSSARY.md`/`GLOSSARY-MAP.md`. Neither convention currently has root files. | Align the consumer doc with the existing glossary workflow. Keep ADRs authoritative. Do not create an empty glossary or rename unrelated documents merely to satisfy a template. |
| Medium | `codebase-design` forbids saying service/API/boundary and insists on one interface. Its internal-seam allowance conflicts with TDD's absolute ban on internal tests. | Keep depth/locality guidance as heuristics. Use actual Effect terminology and permit meaningful tests of internal protocols, persistence, replay, and playout attribution. |
| Medium | Diagnosis forbids forming hypotheses before a runnable red loop, always demands 3–5 hypotheses, and insists on seconds-long execution. | Keep evidence, minimal reproduction, regression checks, and cleanup. Allow source/log analysis to build the reproduction; scale hypotheses and runtime expectations to the issue. |
| Medium | PR skill mandates a visual, before/after evidence, and merge-danger ceremony for every change. The harsh review makes speculative simplification and a 1,000-line threshold blockers. | Short PRs should state behavior and actual validation. Diagrams and risk discussion are conditional. Fold useful maintainability checks into `code-review` as evidence-based findings; archive the separate harsh review. |
| Medium | `writing-for-agents/SKILL-MECHANICS.md` describes Claude invocation mechanics and claims user-only skills cost zero context and cannot be reached by other skills. | Replace with the documented Codex invocation policy. Another workflow can read a reference directly; it does not need a Claude tool. Do not promise zero metadata cost across hosts. |
| Medium | `.agents/` is ignored, while `skills-lock.json` tracks 37 upstream entries. The three unique Claude skills are not represented there. | For a shared project setup, version only the curated project skills and their provenance. Preserve the current dirty lockfile until reconciliation is part of the approved cleanup. Record local adaptations separately from upstream hashes. |
| Medium | Bash heredocs, `grep`, `npm i`, OS-open commands, course tooling, and package-layout assumptions appear in skills. | Prefer PowerShell-compatible commands, `rg`, pnpm, and actual package exports. Archive course workflows; make occasional provisioning scripts conditional on a supported shell. |

## Every unique project skill

“Keep” means retain its purpose, with the fixes above. “Optional” means explicit invocation only or an archive outside skill discovery. “Archive” means remove from the active project set, retaining a recoverable copy if desired. None of these dispositions has been applied.

| Skill | Disposition | Reason / required adaptation |
| --- | --- | --- |
| `ask-matt` | Archive; replace with a short workflow index if needed | 12,449-character router duplicates the catalog and imposes a large process; its fixed 150k smart-zone claims and `/clear` assumptions are not established for this setup. |
| `claude-handoff` | Archive | Claude-specific process launch; portable `handoff` covers the useful artifact. |
| `code-review` | Keep | Useful standards/spec distinction. Fix dirty-tree coverage, shorten trigger, separate concrete defects from optional design suggestions. Delegate independent axes only when worthwhile. |
| `codebase-design` | Keep, trim | Useful design reference. Remove vocabulary bans and absolute abstraction/test rules. Disclose examples and competing-design guidance. |
| `diagnosing-bugs` | Keep, trim | Useful repro/measurement discipline. Narrow trigger to difficult bugs; avoid making every failure run six phases. |
| `domain-modeling` | Keep | Distinct domain/ADR purpose. Align file convention; record agreed terms rather than gratuitously creating documents. |
| `git-guardrails-claude-code` | Archive from Codex project | Claude PreToolUse hooks do not enforce Codex commands. Any desired enforcement needs actual Codex rules/hooks, not a renamed script. |
| `grill-me` | Merge into `grilling` | Thin alias with an unavailable tool call. |
| `grill-with-docs` | Merge into `grilling` | Thin alias. Let explicit design sessions record terms/ADRs when useful. |
| `grilling` | Keep, explicit only | Preserve focused design questions. Bound rounds; reuse prior answers and stop when the consequential choices are settled. |
| `handoff` | Keep, explicit only | Small portable artifact workflow; replace Tool references and avoid duplicating existing specs. |
| `implement` | Optional | Ordinary Codex implementation already covers this. If kept for the spec workflow, remove automatic commit and unconditional review/TDD ceremonies. |
| `implement-spec` | Optional | Only for an explicitly requested multi-ticket build. Repair tool calls; isolate writers; never reset a checkout with unrelated work. |
| `improve-codebase-architecture` | Optional | Distinct broad architecture survey; keep out of ordinary edits. Relax forced vocabulary and compulsory HTML/CDN presentation. |
| `loop-me` | Archive from project | Personal workflow-design workspace, not this voice-agent repo. Do not translate its conceptual loops into an automatic schedule. |
| `migrate-to-shoehorn` | Optional | Specific migration, not generic testing guidance. Use pnpm/dev dependency and current docs only when requested; do not mandate blanket cast replacement. |
| `pr` | Keep, heavily trim | Useful output workflow, currently 171 lines with a mandatory template. State problem/behavior and checks; visuals only when helpful. |
| `prototype` | Keep | Useful way to settle state/UI questions. Mark throwaway code; avoid automatic commits or issue publication. Load UI/logic references only as relevant. |
| `research` | Keep | Primary-source research with a cited artifact. Delegate independent substantial research, not every documentation lookup; reuse `find-docs`/OpenAI Docs. |
| `retro` | Optional | Useful after repeated friction. Avoid the claim that reviewers need no exploration or that standards apply only at review time. |
| `scaffold-exercises` | Archive from project | Assumes ai-hero course tooling absent from Feather-Lite and auto-commits. |
| `setup-matt-pocock-skills` | Archive after setup | Tracker/domain configuration already exists. Its preference for editing CLAUDE.md should not return during Codex maintenance. |
| `setup-pre-commit` | Optional | One-time tooling change. Use current docs; preserve chosen checks; avoid adding full-suite latency or committing automatically. |
| `setup-ts-deep-modules` | Optional; require a separate design task | Installs a specific folder-depth policy and example package. Existing pnpm packages expose `src/index.ts`; do not impose a different layout incidentally. |
| `tdd` | Keep | Preserve behavioral tests and one red/green slice at a time. Remove repeated approval and the ban on refactoring during the cycle; use Effect test layers/clock patterns. |
| `teach` | Archive from project | Teaching-workspace artifacts and pedagogy are unrelated to regular repo changes. Retain elsewhere if personally useful. |
| `to-questionnaire` | Archive from project | Generic personal collaboration workflow; install on demand if needed. |
| `to-spec` | Keep, explicit only | Fits design-first work. Synthesize agreed decisions and testable acceptance criteria; remove mandatory extensive user stories and repeated test lectures. |
| `to-tickets` | Keep, explicit only | Distinct multi-session slicing purpose. Small approved slices and actual dependencies; simplify template and use PowerShell body files. |
| `triage` | Optional | Tracker-specific workflow; keep if actively processing incoming issues. Do not invoke it for already approved tickets. |
| `wait-what` | Archive | A plain request to clarify communication works without a project skill. |
| `wayfinder` | Optional | Useful only for very large uncertain efforts. Repair runtime calls and remove fixed session/token limits; avoid spawning research that recursively spawns more research. |
| `wizard` | Optional | Human-only provisioning can be useful, but current implementation is Bash-specific and includes commit instructions. No need to migrate it before a concrete provisioning task. |
| `writing-beats` | Archive from project | Article-authoring workflow. |
| `writing-for-agents` | Optional reference / merge with built-in skill authoring | Useful disclosure concepts; lengthy meta-vocabulary and outdated invocation rules duplicate maintained `skill-creator`. Retain a concise local conventions reference if needed. |
| `writing-fragments` | Archive from project | Personal writing workflow. |
| `writing-shape` | Archive from project | Overlaps writing-beats and is unrelated to routine engineering. |
| `.claude/skills/commit-work` | Keep; move to `.agents/skills` | Trigger only on commit/stage requests. Preserve unrelated dirty files; drop mandatory Conventional Commits unless this repo chooses that convention; verification precedes commit. |
| `.claude/skills/resolving-merge-conflicts` | Optional; move only if retained | Drop “stage everything” and unconditional “never abort”; respect the authorized merge/rebase scope. |
| `.claude/skills/thermo-nuclear-code-quality-review` | Archive; fold a few checks into review | 192 lines of repeated ambition/structure directives; speculative design improvements should not automatically block correct scoped changes. |

Suggested curated set: 10 existing skills (`code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grilling`, `handoff`, `pr`, `prototype`, `research`, `tdd`), two planning skills (`to-spec`, `to-tickets`), migrated `commit-work`, and new `effect-service-design`: **14 project skills**, with planning/interview/handoff/commit workflows explicit. Keep additional optional workflows only when you actually use them. This default retains spec/ticket planning and treats triage/wayfinder as optional; adjust if your answer to the workflow question differs.

Archive outside `.agents/skills` and any plugin-discovered skill directory. Do not recursively remove `.claude` junctions while treating them as ordinary directories; distinguish and remove/archive links independently of their targets.

## Global instructions and configuration

`C:/Users/hp/.codex/AGENTS.md` is 827 bytes; project `AGENTS.md` is 347 bytes. Neither is a bloat problem. Keep global completion, reuse of approvals, task-scoped reading, PowerShell, and selective current documentation lookup. Avoid copying those paragraphs into every project.

Global custom `find-docs` is concise and version-aware; keep it. `find-skills` is deliberately opt-in; keep it available without adding an always-on discovery requirement. Global `web-perf` is disabled and depends on a Chrome DevTools MCP not configured here; leave disabled until a real need. Leave the maintained system skills and app/plugin cache instructions under their owner's control. A plugin originating from a Claude marketplace is not automatically Claude-only; judge its actual tools and instructions.

Global config currently defaults to `gpt-6.1-sol/high`, plan effort `high`, approval policy `never`, and `danger-full-access`. Project config repeats the model/effort and selects Luna/max workers, up to five additional threads. The documented agent keys are valid; do not replace them with historical feature flags. `codex features list` confirms multi-agent enabled, memories enabled, experimental context management disabled, and prevent-idle-sleep enabled. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Recommended model choices are starting points to evaluate, not guarantees:

| Work | Model / effort |
| --- | --- |
| Regular Feather-Lite development and integration | GPT-6.1 Sol / keep current `high`; compare `medium` on routine work |
| Bounded exploration, triage, small changes, well-specified worker tasks | GPT-6 Luna / `medium`; raise for a demonstrated gap |
| Difficult concurrency/persistence/attribution design, conflicting evidence, deep review | GPT-6 Astra / `high`, or `xhigh` when justified by the task |

OpenAI recommends comparing models and effort on representative tasks and retaining the lightest setting meeting the quality bar. API documentation and Codex model catalogs are different product surfaces: do not infer API parameters from a local cache. The local cache lists Sol/Astra `ultra`, but it was not exercised and is not needed here. [Model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection)

Proposed project config, with personal model defaults inherited from the global file:

```toml
[agents]
max_concurrent_threads_per_session = 5
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "medium"
```

`agents.enabled = true` is the default; retaining the existing explicit value is harmless. Remove the repeated project `model` and effort if you want global/profile model switching to apply consistently. Explicit spawn settings and inherited agent context can supersede worker defaults; these keys do not prove every worker runs Luna.

CLI flags outrank project configuration, and project configuration outranks profile files. Current profiles use separate `~/.codex/<name>.config.toml` files; legacy `[profiles.<name>]` tables are unsupported in current Codex. No profile files exist in this setup. Optional CLI presets are useful only if you actually use the CLI; desktop model selection can remain your normal workflow. [Config precedence](https://learn.chatgpt.com/docs/config-file/config-basic), [profiles](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles)

The global rules file contains 419 `allow` entries, zero `prompt`, and zero `forbidden`, including old full PowerShell commands and broad command prefixes. It is an accumulated approval-rule file, not an always-loaded prose prompt; do not claim pruning it will save model tokens. Review stale and broad entries separately if you intend to restore selective approvals. Leave permissions, app-managed `node_repl`, runtime paths, notification hooks, marketplaces, and desktop settings unchanged during skill cleanup. [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules)

No OpenAI documentation MCP is configured. The current OpenAI Docs skill successfully falls back to official web sources; adding the read-only Docs MCP is optional, not required to fix this setup. Do not add overlapping documentation plugins by default. [Docs MCP](https://developers.openai.com/learn/docs-mcp)

## Proposed project AGENTS.md

This is a reviewable draft, not an edit to the authoritative file. Link a TypeScript/Effect conventions reference only after that reference exists.

```markdown
# Feather-Lite

TypeScript/pnpm monorepo using Effect 3.22. Follow the pinned dependencies
and existing package conventions.

Use ADR 0005 for Effect service, schema, and error conventions. Read other
ADRs or plans when they govern the area being changed; use current code
and tests to distinguish implemented behavior from planned behavior.

## Verification

Use affected package tests while iterating. Run `pnpm check` for substantive
code changes; it runs typechecking and the ordinary test suites.
Build affected deployable apps when the change affects bundling or runtime entry points.
`pnpm test:db` is separate and truncates database test data; verify the intended
test database before running it. `pnpm lint` currently has no package checks.

Preserve unrelated work. Commit, push, deploy, or publish to the tracker only
when the requested workflow includes that action.

## Project references

For GitHub issue/PR operations: `docs/agents/issue-tracker.md`.
For triage: `docs/agents/triage-labels.md`.
For domain vocabulary and ADR conventions: `docs/agents/domain.md`.
```

After implementing a real linter, replace the last lint sentence with its command and add it to `check`/CI as appropriate. Avoid claiming that all local tests use disposable fixtures: the DB project explicitly truncates data, and provider/load harnesses have separate runtime assumptions.

## Selective dmmulroy and anti-slop integration

Add only `effect-service-design`, adapted to the pinned Effect 3 service graph and actual pnpm tests. Its trigger should be designing/changing a service contract, layer/dependency ownership, lifetime, or failure channel, rather than every file importing Effect. Keep generic depth principles in `codebase-design`; keep test practice in `tdd`; keep specifications in `to-spec`. The companion note supplies the upstream revisions and version-specific concerns. [Upstream skills](https://github.com/dmmulroy/skills)

Do not install all of `coding-standards` as another broad skill. Extract a short conventions reference: typed errors, boundary decoding, dependency ownership, resource lifetime, and explicit fallback/retry semantics. Cite existing ADR 0005 and actual source patterns. Do not add a second TDD/design/spec router.

Anti-slop is an opinionated vendored Oxlint plugin. Treat it as executable policy. Start with a pinned reviewed revision, non-blocking reports on production TypeScript, and measured existing findings. Add a functioning lint command first. Adopt selected high-value rules after checking Effect class/service/schema patterns and test fixtures; avoid all-rules-on, blanket fixes, whole-repo rewrites, or a prettier/migration bundle as a side effect. [Anti-slop](https://github.com/dmmulroy/anti-slop)

## Implementation and acceptance plan

1. Preserve the existing dirty `.gitignore`, `skills-lock.json`, `.codex/` and prior evidence report. Make recoverable copies of only the setup files being changed. Curate discovery first and repair references affected by removals.
2. Apply the concise project instructions, domain-doc correction, and retained workflow changes. Move `commit-work`, selectively add `effect-service-design`, and record source commits plus local adaptations.
3. Reconcile the skill lock and decide which curated project skills should be versioned. Keep personal/article/teaching workflows outside this project.
4. Check TOML, metadata, duplicate names, actual references, removed runtime calls, and discovery in a fresh Codex session. This is structural validation, not evidence of coding quality.
5. Compare the same three representative tasks before/after: a small edit, a reproducible orchestration bug, and an Effect service change. Record task correctness, activated skills, unnecessary questions, touched files, validation results, elapsed time, and available token/usage data. Include a difficult Astra task occasionally. Do not spend on model trials without authorization.
6. Keep anti-slop adoption as a separate change with an initial violation report and explicit rule decisions; once enabled, verify lint/check/CI actually execute it.

The audit is complete as a recommendation. The proposed configuration, instruction edits, skill removals, dependency installation, and model experiments remain unapplied.
