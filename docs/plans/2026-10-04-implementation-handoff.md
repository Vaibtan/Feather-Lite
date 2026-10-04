# Fresh-session implementation handoff

Prepared 2026-10-04. This file delegates implementation when the user gives the prompt below to a new agent. Preparing this handoff did not implement, commit, publish or deploy the product.

## Copy into the new session

```text
Implement the local-product milestone in:
docs/plans/2026-10-04-local-product-and-pilot-readiness-spec.md

Read AGENTS.md and this handoff first:
docs/plans/2026-10-04-implementation-handoff.md

Treat the specification as the scope and acceptance contract. Work through its phases, preserve unrelated changes, and maintain a requirement-by-requirement implementation/evidence report. Complete authorized local implementation and verification; continue independent work when an external prerequisite is unavailable. Do not introduce Clef. Do not commit, push, publish, contact real borrowers, or run paid/provider telephone tests without the required explicit authorization, controlled targets and budget. Report unverified gates honestly rather than replacing live evidence with simulation.
```

## Decisions already made

- Build a real locally running Docker product before the real-borrower pilot. The UI operates actual persistence, audio, callbacks, outcomes and staff cases; it is not a presentation-only demo.
- Hosted AI/speech services are acceptable. The app and full observability are local; self-hosted inference is unnecessary.
- Human handling is staffed follow-up through a durable internal queue, not live transfer. Ending the AI call does not resolve that case.
- Future pilot: US third-party debt collection for another lender. Local tests use synthetic records and controlled participants. Real lender policy and staffing remain separate gates.
- Use OTel with local operational backends and the existing Langfuse capability. Postgres remains authoritative; telemetry failure cannot block business correctness.
- Fix deterministic intent and state errors before any new classifier. Clef is out of this assignment, including shadow calls.

## Read in order

1. Current root `AGENTS.md` and [canonical specification](2026-10-04-local-product-and-pilot-readiness-spec.md).
2. [Pilot findings](../reviews/2026-10-04-pilot-readiness-and-remaining-work.md): P01–P10, R01–R04 and linked source evidence. Its original undecided human-path discussion is historical; staffed follow-up is selected.
3. [Local scope/Clef assessment](../reviews/2026-10-04-local-product-scope-and-clef-assessment.md): context for deferring Clef, not permission to integrate it.
4. [ADR 0005](../adr/0005-typescript-effect-not-go.md), [ADR 0010](../adr/0010-patch-the-worker-shed-load-at-the-worker-and-measure-before-cutting.md), [TypeScript/Effect conventions](../agents/typescript-effect.md), then other task-relevant ADRs.
5. [September specification](2026-09-05-attribution-contract-instruments-and-self-hosted-turn-taking-spec.md) only for retained mechanism/scenario detail; section 11 of the new spec determines remaining scope and priority.

## Baseline and preservation

Audit baseline HEAD was `4968c86430b1c6987a698a4352e356d47dd2f2b5`. Recheck HEAD, status and instructions; do not assume the checkout stayed unchanged. At specification time there were unrelated tracked changes to CI, `.gitignore`, `AGENTS.md`, package/lock files and agent docs, plus untracked skills, tools, setup/review artifacts and the new review/spec documents. Preserve these. Do not reset, stage or overwrite the tree wholesale. Use checkout-scoped `git -c safe.directory=D:/SWE_DEV_NEW/Feather-Lite` if ownership requires it.

The current architecture is TypeScript/Effect with Postgres, a control-plane turn orchestrator, a LiveKit voice worker, operator console and load harness. Preserve short T1/T2 transactions, inference outside transactions, fenced turn ownership, and exact-segment read-back guards. Check installed SDK types and current primary docs before library-specific changes. The pinned worker/media versions have local patches; do not blindly upgrade them.

Earlier audits passed ordinary tests and application builds. Those results are historical for the implementing session. Docker/DB/provider/PSTN acceptance was not freshly established by the specification work; Docker engine availability was previously a blocker. Inspect it again rather than assuming it still fails or now passes.

## Concrete starting points

| Work | Current source entrypoints |
| --- | --- |
| Auth, destructive routes and UI serving | `packages/control-plane/src/http/app.ts`, `http/handlers.ts`, `services/Seed.ts`, `apps/server`, `apps/console`, `docker-compose.yml` |
| Intent, tool legality, dates and loan identity | `packages/domain/src/overrides.ts`, `stateMachine.ts`, `context.ts`; control-plane `services/ToolExecutor.ts`, `Workflow.ts`, context/repository code |
| Contact policy and dispatch | `packages/domain/src/preCall.ts`; `services/VoiceSessions.ts`, `Scheduling.ts`, conversation/scheduling repositories |
| Follow-up and lender loop | Tool/finalization/outbox handlers, CRM and scheduling services, database migrations, console routes/views |
| Recovery and final media | `services/Orchestrator.ts`, `http/TurnRunner.ts`, worker heartbeat/sweeper paths, `apps/voice-worker/src/feather-agent.ts`, `segment-ledger.ts` |
| Observability/evaluation | `services/Tracing.ts`, `Scores.ts`, `Quality.ts`, `Metrics.ts`, `ProcessMetrics.ts`, `deploy/langfuse`, worker tracer and evaluator code |
| Silence and acceptance harness | `packages/domain/src/waitPolicy.ts`, worker turn/interruption logic, `apps/load-test/src`, existing scenario fixtures |

These are navigation aids, not an exhaustive edit list. Follow imports and current contracts. Keep service ownership coherent; avoid a new generic orchestration layer or a wide repository rewrite.

## Execution and completion

Follow phases 0–6 in spec section 10. First establish the baseline and safe isolated test database, then fix bounded regressions. Close auth/policy/staff/account workflows, recovery and evaluation; integrate Docker/telemetry; finish measured voice acceptance and release rehearsal. Write a dated `docs/reviews/` implementation report as work progresses, tracking each stable requirement ID and linking real evidence.

Use affected tests during iteration, `pnpm check` for substantive code changes and affected builds for entrypoint/bundle changes. Do not run anti-slop/lint unless separately requested. `pnpm test:db` truncates: validate a dedicated test DB/role/sentinel before running, and remove unsafe test defaults as specified. Do not delete persistent volumes to “fix” migration or startup issues.

The user has not supplied provider credentials, controlled destination allowlist, spending cap, lender policy or staffing SLA in this handoff. Check authorized local configuration without printing secrets; obtain missing authorization/inputs before dependent live calls. Continue deterministic and local integration work in the meantime. Configure synthetic policy and staffing defaults as the spec describes; do not pretend they are approved for real borrowers.

Completion requires the real console and both browser/PSTN paths, callback, exact-read-back promise, staffed case handling, persisted restart/restore evidence, trace/log/metric/Langfuse queries, alert delivery and failure recovery. Do not count container health, unit tests, old load reports or a simulated call as proof of these. Report blocked gates separately from implemented code. At the end, summarize requirement completion, changes, checks, measured limits and the remaining P decisions; do not claim pilot readiness from L completion.
