---
name: "improve-codebase-architecture"
description: "When explicitly requested, survey a codebase for architectural improvements, present ranked candidates in a visual HTML report, then explore the chosen candidate through a design interview."
---

# Improve codebase architecture

Surface architectural friction and propose improvements that concentrate complexity behind useful interfaces. Preserve this workflow: scope and explore, present ranked visual candidates, let the user choose, then develop that candidate's design. Invoking the survey does not authorize implementing a refactor.

Read [codebase-design](../codebase-design/SKILL.md) for shared design principles and [domain conventions](../../../docs/agents/domain.md) for vocabulary and ADRs. Reuse those instructions directly with Codex file tools. Use actual project terms, including service, API, boundary, module, and Layer, where accurate. For an Effect service graph, also read [effect-service-design](../effect-service-design/SKILL.md).

## 1. Scope and explore

If the user named a subsystem, module, or pain point, use that scope. Otherwise inspect recent Git history and changed paths to identify recurring hotspots; widen the scan when changes are dispersed. Read relevant ADRs and GLOSSARY.md if present. Distinguish implemented behavior from plans and historical reports.

Use a read-only exploration subagent when collaboration tools are available. Give it the bounded scope, governing decisions, and a request for concrete friction with file evidence; keep ranking and synthesis with the main agent. If delegation is unavailable, perform the same exploration directly and disclose that limit. Do not create another user-owned Codex chat for this work.

Explore organically rather than applying size or folder thresholds:
- Where does understanding one operation require bouncing across many small modules?
- Which interfaces expose nearly as much complexity as their implementations?
- Where do coupled responsibilities or concrete dependencies leak across ownership seams?
- Where are pure extractions easy to test but the orchestration that fails is hard to exercise?
- Which behavior is untested or difficult to verify through the current contracts?

Apply the deletion test: would removing or consolidating a suspected wrapper concentrate complexity in its owner, or merely move complexity into callers? Prioritize actual change friction and caller/test burden. Check the source and call sites behind each candidate; label uncertain benefits as speculative.

## 2. Present ranked candidates as a visual HTML report

Read [HTML-REPORT.md](HTML-REPORT.md) for the scaffold and diagram patterns. Save a uniquely named architecture-review HTML file in the OS temporary directory, preferably inside a dedicated report directory. Use PowerShell-compatible commands on Windows and the platform's actual temporary path.

Each candidate must include:
- Files and concrete evidence of the current friction.
- Problem and proposed responsibility change in plain language.
- Benefits in caller complexity, locality, dependency ownership, or behavioral testing.
- Before/after diagrams; mark the after diagram as a proposal.
- Recommendation strength: Strong, Worth exploring, or Speculative.
- Any meaningful conflict with an existing ADR, and why revisiting it could be justified.

Use Tailwind/Mermaid CDN resources for the original visual format and custom CSS/SVG when they better explain the structure. End with a top recommendation and its rationale. Describe conceptual solutions here; defer proposed TypeScript interfaces and implementation patches until a candidate is selected.

Show the rendered report in a Codex browser panel when available. Serve only the dedicated report directory on 127.0.0.1 with an available local static server, then open its actual URL using the Codex panel tool. Verify that diagrams rendered before presenting it. Also provide the absolute HTML file path. If rendering tools are unavailable, provide the file and explain the viewing limitation; do not silently replace the visual report with prose.

Ask which candidate the user wants to explore and wait for a choice. Use the available user-input tool when present. This selection is part of the requested workflow; do not choose a refactor or implement one on the user's behalf. If the invocation already includes a clear candidate choice, reuse it instead of asking again.

## 3. Develop the selected candidate through a design interview

Read and follow [grilling](../grilling/SKILL.md) directly as the next stage of this explicitly requested workflow. Settle constraints, dependencies, ownership, interface shape, implementation details hidden behind the interface, and the behavioral tests that must survive. Reuse existing answers and stop once consequential choices are settled.

For meaningful alternative interfaces, apply codebase-design and compare competing designs; independent design subagents may help when the comparison warrants them. Use the Effect workflow for Layer composition, scoped resources, typed failures, and cancellation where relevant. Respect pinned APIs and existing package exports.

As decisions crystallize, follow [domain-modeling](../domain-modeling/SKILL.md): record resolved project terms or sharpen definitions in a lazy glossary. For a consequential accepted choice or a durable reason for rejecting a candidate, record an ADR when its rationale is needed by future readers. Do not record ephemeral preferences or every declined suggestion.

Complete with the chosen design, tradeoffs, verification approach, updated domain records where warranted, and remaining decisions. If requested, use [to-spec](../to-spec/SKILL.md) to capture the result in the canonical specification. Implementation, commits, and tracker publication require their own requested scope.
