# Feather-Lite v2 — progress log

Plan: `docs/plans/2026-08-16-ts-effect-rebuild.md`. One line per phase milestone; newest last.

| Date | Phase | Status | Notes |
|---|---|---|---|
| 2026-08-16 | 0 Monorepo & toolchain | done | pnpm 11 workspaces, TS 5.9 strict, vitest 3 + @effect/vitest, Effect 3.22 pinned; `pnpm check` green on empty packages; docker-compose Postgres |
| 2026-08-16 | plan rev.2 | done | adversarial review (25 findings) folded in: two-mode turns, 3-phase turn tx, SSE frame protocol, forced transitions, proposal/read-back tools, tracer bullet before Phase 2 |
| 2026-08-16 | 1 Domain | done | `packages/domain`: enums, branded ids, values (money/date/tz), state machine (adjacency + override + forced), overrides (normalised, name-aware), tools + arg schemas + matrix, event union (19 types), replay reducer, transcript, pre-call policy, time helpers, context gate, scripts, turn contract; 92 tests |
| 2026-08-16 | 1.5 Voice tracer bullet | done | D2 proven on @livekit/agents 1.6.4 + LiveKit Cloud: text-mode harness (session.run) and a 51.8 s fully automated voice call (STT, streamed llmNode reply, barge-in truncation, interruptible read-back, durable-then-speak confirmation, hangup via deleteRoom). 14 findings in `2026-08-16-phase-1.5-tracer-findings.md`; read-backs now interruptible + fully-heard guard |
