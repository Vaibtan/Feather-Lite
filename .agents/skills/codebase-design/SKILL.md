---
name: "codebase-design"
description: "Design or improve module interfaces, choose ownership seams, or assess opportunities to make complex code easier to change and test."
---

# Codebase design

Trace a caller-visible operation through the implementation. Identify what complexity the module hides, what callers must understand, and where a change would spread.

Prefer cohesive ownership and a small useful interface over forwarding wrappers or exposing implementation details. Depth, locality, and deleting unnecessary abstractions are heuristics, not folder or vocabulary rules. Use the project's actual service, API, and boundary terminology.

For a consequential redesign, compare the smallest viable change with alternatives: caller complexity, dependencies, resource ownership, testing, and migration cost. Reuse existing package exports and agreed seams. Keep domain calculations pure; put I/O and lifetime ownership in the appropriate adapter or service.

Tests should exercise meaningful behavior. Internal protocol, persistence, replay, and playout-attribution tests are valid when they protect actual contracts. Do not force every test through one outer interface.

Complete with a concrete interface/design or a bounded patch, its tradeoff, and the behavior that verifies it. Read [TypeScript/Effect conventions](../../../docs/agents/typescript-effect.md) when Effect ownership is involved; use the effect-service-design skill for the detailed service workflow.
