---
name: "pr"
description: "Write or update a pull request title and description grounded in the actual change and validation."
---

# Pull request description

Read the actual diff and originating request. Lead with the problem and resulting behavior; use a concrete before/after example when it helps. Include the checks actually performed and material limits.

Scale the description to the change and any repository template. Small changes usually need one or two sentences plus validation. Add a diagram, migration detail, or risk discussion only when it helps a reviewer assess the result. Omit abandoned approaches and conversational history.

Drafting a body does not imply publishing. If the requested workflow includes creating/updating a PR, use [tracker conventions](../../../docs/agents/issue-tracker.md), preserve multiline text with a body file, and attach any created PR using the available Codex attachment tool.
