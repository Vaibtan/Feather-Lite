---
name: "to-tickets"
description: "When explicitly requested, break an agreed specification into small actionable implementation tickets with acceptance criteria and dependencies."
---

# To tickets

Read the canonical specification and current implementation. Split the work into cohesive, verifiable slices that can be completed independently where practical. Avoid separating tightly coupled changes solely by file or layer.

For each slice state the behavior, scope, acceptance/validation, and real blockers. Keep ordering and dependency links explicit. Reuse shared spec context through links rather than duplicating it in every ticket.

Draft the breakdown beside the spec or at the requested destination. Publish issues only when the user requested tracker publication; use [tracker conventions](../../../docs/agents/issue-tracker.md) and existing [triage labels](../../../docs/agents/triage-labels.md).

Complete with the breakdown or created issue links. Do not automatically claim, implement, or close tickets.
