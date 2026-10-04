---
name: "to-spec"
description: "When explicitly requested, turn agreed requirements and design decisions into an actionable specification with testable acceptance criteria."
---

# To specification

Use the existing conversation, code, ADRs, and any canonical plan. Resolve only uncertainties that materially change the result; reuse previous answers and approved seams.

Write the problem, intended behavior, scope, relevant contracts/state transitions, acceptance criteria, and verification. Add migration, failure, concurrency, or rollout details when the change needs them. Keep planned behavior distinct from current implementation. Avoid mandatory extensive user stories or repeating testing tutorials.

Update the authoritative spec if one exists; otherwise draft in docs/plans unless the user chose a tracker destination. Use [tracker conventions](../../../docs/agents/issue-tracker.md) for authorized publication.

Complete with a concrete, reviewable spec and any decisions still needed. Writing the spec does not authorize implementation or publishing beyond the requested workflow.
