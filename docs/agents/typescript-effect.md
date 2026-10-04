# TypeScript and Effect conventions

Follow [ADR 0005](../adr/0005-typescript-effect-not-go.md), the pinned Effect 3.22 dependencies, strict compiler settings, and nearby source. Existing services use `Effect.Service` or `Context.Tag` with Layers. Do not introduce Effect 4 `Context.Service` examples or change package layout incidentally; packages expose their intended public API through existing exports, commonly `src/index.ts`.

- Decode untrusted inputs with existing Effect Schema patterns at external boundaries. Keep parsed domain data separate from raw transport/framework types. `unknown` is appropriate at an untrusted boundary; avoid assertions that pretend validation occurred.
- Represent expected failures in typed error channels using established tagged errors. Handle the tags the operation can recover from. Preserve defects and interruption semantics; do not catch everything into success or silently discard a cause.
- Domain calculations stay pure. Services own cohesive I/O, state, policy, or lifecycle capabilities. Adapters own concrete technology construction; composition roots select implementations. Reuse stable dependencies during construction and acquire operation-scoped context at use.
- Express resource acquisition/release with Scope and existing acquire/release patterns. Own child fibers and cancellation explicitly. Exercise failure, interruption, replay, or restart when those mechanisms affect correctness.
- Make fallback and retry semantics explicit: triggering failures, limits, timing, idempotency, and observable outcomes. A retry or default value must not conceal an incomplete transaction or uncertain playout attribution.
- Use behavioral tests through real seams and faithful test Layers, with existing `@effect/vitest` clock/resource helpers. Keep persistence/protocol tests when they protect actual contracts. Read the TDD skill only for a requested test-first workflow.

The effect-service-design skill supplies the service workflow; codebase-design owns general interface tradeoffs. These conventions do not mandate a second router, every-file service review, or blanket cast replacement.
