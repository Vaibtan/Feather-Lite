---
name: "effect-service-design"
description: "Design or change an Effect service contract, dependency Layer, resource lifetime, or typed failure channel; audit a bounded service graph when requested."
---

# Effect service design

Read [TypeScript/Effect conventions](../../../docs/agents/typescript-effect.md), ADR 0005, and the affected service and composition root. This repository uses Effect 3.22; upstream Effect 4 examples are not its API.

Trace a caller-visible operation and decide what owns I/O, credentials, persistence, state, configuration, and resource lifetime. A service should own a cohesive capability or meaningful production variability. Keep deterministic calculations and per-call inputs as values or pure functions; use an existing Effect capability before inventing a forwarding service.

Use the local Context.Tag/Layer.effect or Effect.Service pattern. Define operation results and recoverable failures explicitly. Yield stable dependencies during construction and close over them; obtain request/fiber-scoped context inside the operation. Let requirements propagate to the composition root that truthfully selects implementations.

Keep domain modules pure. Application contracts belong beside their consumers; technology-specific construction belongs in adapters. Prefer existing package exports and naming over a new mandatory file layout.

Make acquisition, scope, release, interruption, and child-fiber ownership explicit. Supply faithful test Layers for actual seams and verify lifetime/failure behavior with existing tests. Do not erase typed failures or add silent fallback/retry to satisfy a signature.

For a bounded audit, trace the in-scope operations and report concrete ownership, dependency, or lifetime defects; do not reorganize the whole repository automatically. Complete with the contract/composition change and evidence for its behavior. See [Effect 3 example](references/effect3.md) only when a construction example helps.
