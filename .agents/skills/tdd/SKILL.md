---
name: "tdd"
description: "Implement a feature or fix test-first when requested, using meaningful red-green-refactor cycles and behavior-focused tests."
---

# Test-driven development

Identify the requested behavior and acceptance criteria. Reuse agreed interfaces, existing test placement, and test helpers. Ask about a seam only when a consequential public contract or design choice is unresolved.

Add one meaningful failing test and confirm it fails for the expected reason. Implement the smallest coherent change to pass it, then refactor while keeping relevant tests green. Repeat by behavior rather than writing a large speculative test suite upfront.

Use real dependency seams and faithful test implementations. For Effect behavior, prefer existing @effect/vitest patterns, test Layers, controlled clocks, and scoped resources. Internal protocol/persistence tests are appropriate when they protect real contracts. Avoid module mocking and tests that merely restate the implementation.

Exercise cancellation, concurrency, restart, or replay when those mechanisms are part of the behavior. Follow the project's separate database/provider test constraints. Complete with the behavioral change and actual checks; do not rerun broad suites without a new reason after required checks pass.
