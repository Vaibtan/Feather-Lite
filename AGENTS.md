# Feather-Lite

TypeScript/pnpm monorepo using Effect 3.22. Follow the pinned dependencies and existing package conventions.

Use [ADR 0005](docs/adr/0005-typescript-effect-not-go.md) and [TypeScript/Effect conventions](docs/agents/typescript-effect.md) for service, schema, and error changes. Read other ADRs or plans when they govern the affected area; distinguish implemented behavior from planned behavior using current code and tests.

## Verification

Use affected package tests while iterating. Run `pnpm check` for substantive code changes; it validates agent setup, typechecks, and runs ordinary test suites. Build affected deployable apps when bundling or runtime entry points change.

Anti-slop is opt-in. Run its scans or cleanup only when the user explicitly requests `$anti-slop` or an equivalent anti-slop review/cleanup. It is not part of ordinary implementation verification, `pnpm check`, or CI. The manual `pnpm lint` and `pnpm lint:baseline` commands remain available for that requested workflow.

`pnpm test:db` is separate and truncates database test data; verify the intended test database before running it. Provider and load harnesses have separate runtime requirements.

Preserve unrelated work. Commit, push, deploy, or publish to the tracker only when the requested workflow includes that action.

## Project references

- GitHub issue/PR operations: [issue tracker](docs/agents/issue-tracker.md).
- Triage: [canonical labels](docs/agents/triage-labels.md).
- Domain vocabulary and ADRs: [domain conventions](docs/agents/domain.md).
- Skill maintenance and provenance: [project skills](docs/agents/skills.md).
