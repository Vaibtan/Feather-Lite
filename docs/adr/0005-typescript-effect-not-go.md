# ADR 0005 — TypeScript + Effect 3 for v2 (not Go, not Python, not Effect 4 RC)

- Status: accepted (2026-08-16)
- Related: review `docs/reviews/2026-08-16-plan-vs-implementation-review.md`, plan `docs/plans/2026-08-16-ts-effect-rebuild.md`

## Context

v1 was Python (kept as the reference implementation under `backend/`). The author prefers
TypeScript with the Effect ecosystem and Go. The target company runs LiveKit Agents; the demo
must include a real voice call.

## Decision

- **TypeScript** everywhere: `@livekit/agents` has first-class Node support (`llmNode` override,
  AMD, SIP helpers, testing harness) and there is **no LiveKit Agents SDK for Go** — a Go voice
  worker would mean re-implementing the agent runtime (VAD, turn detection, TTS streaming,
  interruption bookkeeping). Sharing `packages/domain` and `packages/contracts` between the
  worker, the API and the console is a further win.
- **Effect 3.22 (stable)**, not the 4.0 RC: `Effect.Service` classes with `dependencies` for the
  service graph, `Layer` for wiring, `Schema` for every boundary (tool args, events, SSE frames,
  HTTP contracts, JSON schema for the model's tools), typed errors (`Data.TaggedError`) mapped to
  HTTP statuses in one place, `@effect/sql-pg` for Postgres, `@effect/platform` HttpApi with
  generated OpenAPI, `Stream` for the two-mode turn, `Clock` swaps for deterministic replays.
- **Postgres stays** (relational workflow model, `SELECT … FOR UPDATE`, `SKIP LOCKED` claims,
  monotonic `sequence_no` under a row lock).

## Consequences

- One language, one type system, one dependency graph across three runtimes (Node API, Node
  worker, browser console); the domain package has zero IO and 92 unit tests.
- Effect's learning curve is real; the payoff shows in the places that matter for this product:
  every failure has a name and a rescue (`docs/plans/2026-08-16-ts-effect-rebuild.md` §5), test
  Layers replace real ones without mocks, and virtual clocks make replayed history consistent.
- Go remains a fine choice for a future high-throughput scheduler or SIP edge, but not for the
  agent runtime.
