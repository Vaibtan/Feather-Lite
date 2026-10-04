# Codex setup implementation

2026-10-04. Implements the approved [setup audit](2026-10-03-codex-setup-skills-audit.md) and [upstream audit](2026-10-03-dmmulroy-skills-audit.md).

## Applied changes

- Curated 40 unique existing skills into 13 retained/adapted workflows plus one Effect service-design workflow: 14 active skills, five explicit and nine with narrow implicit triggers. Retired personal/course/Claude workflows and grill aliases are outside discovery; commit-work is now a project Codex skill. No Claude junctions or broken pwc-cli link remain in the project.
- Rewrote retained roots around actual task boundaries, meaningful verification, and existing decisions. Removed unavailable Claude runtime calls, automatic commit/publication, repeated seam approval, absolute vocabulary/testing rules, and mandatory PR ceremonies. Root bodies total 16,508 bytes versus the audit's 182,573 bytes. This is a disk-content comparison, not an always-loaded context or performance claim.
- Updated AGENTS.md, domain/tracker conventions, and one TypeScript/Effect reference. Domain docs now consistently use a lazy GLOSSARY.md and existing ADRs. No empty glossary or package restructuring was added.
- Added the narrowly adapted dmmulroy Effect workflow at revision 8603380821fee6a77c82639f364ce8fe4f5a92be. Its example uses the installed Effect 3 APIs. Shared depth/test/spec workflows remain separate. Coding-standards, tech-spec, and the anti-slop installer skill were not imported.
- Inherited the global GPT-6.1 Sol/high default; removed redundant project model settings and selected Luna/medium as the project worker default. Global permissions, rule files, plugins, runtime paths, and instructions were inspected previously and remain unchanged.
- Made curated skills versionable, retained only 12 applicable installer-origin lock entries, and recorded actual adaptation hashes separately in the provenance manifest. Original installer hashes were preserved; unknown upstream revisions are explicitly unknown. LF attributes keep skill hashes stable across checkouts.
- Added pinned Oxlint/plugin dependencies and five enforceable rules, a non-blocking full-rule baseline command, setup validation, and CI steps. See the [baseline and rule decisions](2026-10-04-anti-slop-baseline.md). Node minimum is 22.18.0 for TypeScript plugin loading; no application source or unrelated dependency ranges were changed.

## Validation

- `pnpm check`: setup integrity, lint, all seven workspace typechecks, and **723 ordinary tests passed** (52 test files).
- `pnpm install --frozen-lockfile`: passed after package/config changes.
- Official skill-creator validator: 14/14 passed; YAML metadata and CI parsed; global/project TOML parsed.
- Relative Markdown references, active inventory, explicit policies, adaptation hashes, installer entries, and matching exact lint versions: passed.
- 38 vendored upstream runtime/license/attribution artifacts: byte-identical to pinned assets.
- Temporary lint fixtures: all five adopted rules reject violations; valid positive examples pass.
- Temporary Git fixture: branch-only, branch plus staged/unstaged/untracked, staged-only, and working-tree review scopes match the revised instructions.
- Effect 3 skill example: strict typecheck against local pinned dependencies passed.

Database truncation tests, Docker/provider harnesses, deployable builds, and paid model comparisons were not run; no runtime application code changed. Fresh-session catalog discovery and model-quality comparisons remain unmeasured. Start a new Codex chat to load the revised skill catalog; this existing chat retains its original catalog metadata.

## Recovery and preserved work

Recoverable pristine snapshot (all 40 original skill bodies and original setup files): `C:/Users/hp/.codex/backups/Feather-Lite/2026-10-04-codex-setup/setup-before.zip`. The same directory holds original junction/link inventory, check logs, lint snapshots, and fixture diagnostics. Retired physical originals also remain in the temporary audit directory; the ZIP is the durable recovery copy.

The preexisting `.commandcode/` ignore, dirty skills lock, project config, and historical evidence/audit artifacts were preserved before reconciliation. No staging, repository commits, push, tracker publication, deployment, provider calls, or global-setting changes were performed. Temporary lint/Effect fixtures were removed; commits used to test diff behavior exist only in an isolated temporary fixture repository.

## Follow-up: architecture workflow restored

At the user's explicit request, `improve-codebase-architecture` was restored on 2026-10-04. The active set now has **15 skills: six explicit-only and nine with narrow implicit triggers**. Its original workflow is retained: scope from named concerns or Git hotspots, delegate exploration, rank candidates in an HTML report with before/after diagrams, wait for candidate selection, then conduct a design interview and record resolved domain decisions.

Claude invocation mechanics were replaced with direct reads of shared skill files and Codex collaboration/panel tools. The visual report guide retains Tailwind/Mermaid and custom diagrams, with temporary loopback serving and offline fallbacks. Current project terminology and Effect APIs govern design; there is no compulsory refactor or vocabulary ban. The original installer record was recovered from the pristine ZIP and local adaptation hashes were recorded separately. Every other provenance/lock record was preserved.

Validation: setup integrity and lint passed, as did the official skill validator and YAML metadata checks. An independent synthetic-repository evaluation produced a ranked report, rendered all four Mermaid diagrams in a hidden browser, verified the recommendation link, stopped for selection, and continued with focused questions after a simulated choice. Its implementation and domain records remained unchanged. Responsive CSS exists but narrow-viewport rendering was not checked. The documented isolated report-server command was also exercised successfully. These checks validate this workflow on a fixture, not the architecture of Feather-Lite.

Recovery snapshot of the previous curated setup: `C:/Users/hp/.codex/backups/Feather-Lite/2026-10-04-codex-setup/before-architecture-skill-restore.zip`. No application code changed, so the application test suite was not rerun for this instruction-only restoration.

## Follow-up: anti-slop made opt-in

At the user's request, Oxlint was removed from `pnpm check` and CI. AGENTS.md now excludes anti-slop scans and cleanup from ordinary implementation/verification unless explicitly requested. A project-local `$anti-slop` skill provides scoped review or requested cleanup using the vendored plugins; it is explicit-only. Manual lint commands and pinned tooling remain available. This wrapper is not an upstream installer skill. The active catalog now has **16 skills: seven explicit-only and nine with narrow implicit triggers**. Prior baseline/enforcement results above describe the initial integration, not the current automatic check policy.
