# The 8 DX Passes (plan branch, after Step 0)

**Anti-skip rule:** never condense, abbreviate, or skip any pass regardless of
plan type. "This is a strategy doc so DX passes don't apply" is always wrong —
DX gaps are where adoption breaks down. If a pass genuinely has zero findings,
say "No issues found" and move on — but you must evaluate it.

**Anti-shortcut rule:** the plan file is the OUTPUT of the interactive review,
not a substitute for it. If you have ANY non-trivial finding, the path from
finding to done goes THROUGH AskUserQuestion — never dump all findings into the
plan in one write. Zero findings everywhere is the only path that skips asking.

## The 0-10 rating method

Every rating MUST reference Step 0 evidence. Not "Getting Started: 4/10" but
"4/10 because [persona] hits [friction point from 0F] at step 3, and
[competitor from 0C] achieves this in [time]." Pattern per pass:

1. **Evidence recall** — cite the Step 0 findings that apply
2. Rate ("Getting Started: 4/10")
3. Gap — "a 10 would be [specific description for THIS product]"
4. Load this pass's section from [hall-of-fame.md](hall-of-fame.md)
5. Fix — edit the plan to add what's missing
6. Re-rate ("now 7/10, still missing [gap]")
7. AskUserQuestion for any genuine DX choice
8. Repeat until 10 or the user says "good enough, move on"

Mode behavior: **EXPANSION** — after reaching 10, also ask "what would make
[persona] rave about this?" as individual opt-ins. **POLISH** — fix every gap,
no shortcuts, trace each issue to files/lines. **TRIAGE** — only flag gaps that
block adoption (score below 5).

## Pass 1: Getting Started Experience (Zero Friction)

Can a developer go from zero to hello world in under 5 minutes? Evidence
recall: the 0C target tier, the 0D delivery vehicle, 0F Install/Hello World
friction points. Evaluate: installation (one command? no prerequisites?);
first run (visible, meaningful output?); sandbox/playground; free tier (no
credit card, no sales call); quick start copy-paste complete; auth/credential
bootstrapping (steps between "I want to try" and "it works"); magical-moment
vehicle actually in the plan; TTHW gap vs the chosen tier. FIX TO 10: write the
ideal sequence — exact commands, expected output, time budget; target 3 steps
or fewer. Stripe test: can [persona] go from "never heard of this" to "it
worked" in one terminal session?

## Pass 2: API/CLI/SDK Design (Usable + Useful)

Is the interface intuitive, consistent, complete? Does the surface match the
persona's mental model (a YC founder expects `tool.do(thing)`; a platform
engineer expects `tool.configure(options).execute(thing)`)? Evaluate: naming
guessable without docs; sensible defaults everywhere; consistency across the
surface; completeness (or do devs drop to raw HTTP?); discoverability from
CLI/playground; reliability (latency, retries, rate limits, idempotency);
progressive disclosure (simple case is production-ready, not a toy). Test: can
[persona] use this API correctly after seeing one example?

## Pass 3: Error Messages & Debugging (Fight Uncertainty)

When something goes wrong, does the developer know what happened, why, and how
to fix it? **Trace 3 specific error paths** from the plan or codebase; for
each, show what the developer currently sees vs should see, judged against the
three-tier model (Elm conversational / Rust annotated / Stripe structured
JSON — full definitions in [hall-of-fame.md](hall-of-fame.md)). Also evaluate:
the permission/safety model (blast-radius clarity), debug/verbose mode, stack
trace usefulness.

## Pass 4: Documentation & Learning (Findable + Learn by Doing)

Can a developer find what they need and learn by doing? Does the docs
architecture match the persona's learning style (founder: copy-paste examples
front and center; platform engineer: architecture + API reference)? Evaluate:
find anything in under 2 minutes; progressive disclosure; copy-paste-complete
examples in real context; playgrounds/"try it"; versioned docs; tutorials AND
references.

## Pass 5: Upgrade & Migration Path (Credible)

Can developers upgrade without fear? Evaluate: backward compatibility and
blast radius; actionable deprecation warnings ("use newMethod() instead");
step-by-step migration guides for every breaking change; codemods; semantic
versioning policy.

## Pass 6: Developer Environment & Tooling (Valuable + Accessible)

Does this integrate into existing workflows — and the persona's typical
environment? Evaluate: editor integration (language server, autocomplete);
CI/CD non-interactive mode; TypeScript types; test utilities and mocks; local
dev (hot reload, fast feedback); cross-platform (OS, ARM/x86, containers,
proxies); observability (dry-run mode, verbose output, fixtures).

## Pass 7: Community & Ecosystem (Findable + Desirable)

Is there a community, and does the plan invest in ecosystem health? Evaluate:
open source + license; community channels with someone answering; real-world
runnable examples (not just hello world); plugin/extension story; contributing
guide; pricing transparency (no surprise bills).

## Pass 8: DX Measurement & Feedback Loops

Does the plan include ways to measure and improve DX over time? Evaluate: TTHW
instrumentation; journey analytics (where do devs drop off?); feedback
mechanisms (bug templates, NPS); periodic friction audits; boomerang readiness
(will a future live audit be able to measure reality vs this plan?).

## Appendix: AI-agent skill DX checklist

Only when the product is a Claude Code skill / MCP server / agent tool. Not
scored — check each item in the checklist at the end of
[hall-of-fame.md](hall-of-fame.md); for any unchecked item, explain what's
missing and suggest the fix (AskUserQuestion for design decisions).

## How to ask questions (critical)

- **One issue = one AskUserQuestion call.** Never combine.
- **Ground every question in evidence** — persona, benchmark, narrative, or
  friction trace. Never abstract.
- **Frame pain from the persona's perspective:** "[persona] hits this at minute
  [N] and [abandons / files an issue / hacks a workaround]."
- 2-3 options, each with effort to fix and impact on adoption.
- **Map the recommendation to a First Principle** in one sentence.
- Zero findings → "No issues, moving on." Otherwise every gap — even one with
  an "obvious fix" — needs user approval before landing in the plan.
- Assume the user hasn't looked at this window in 20 minutes; re-ground every
  question. Number issues (1, 2, 3), letter options (A, B, C).

## Close-out

After all passes, output the DX Scorecard (8 dimensions + TTHW + competitive
rank Champion/Competitive/Needs Work/Red Flag + magical moment + mode + overall)
and the implementation checklist:

```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Time to hello world < [target from 0C]
[ ] Installation is one command
[ ] First run produces meaningful output
[ ] Magical moment delivered via [vehicle from 0D]
[ ] Every error message has: problem + cause + fix + docs link
[ ] API/CLI naming is guessable without docs
[ ] Every parameter has a sensible default
[ ] Docs have copy-paste examples that actually work
[ ] Examples show real use cases, not just hello world
[ ] Upgrade path documented with migration guide
[ ] Breaking changes have deprecation warnings + codemods
[ ] TypeScript types included (if applicable)
[ ] Works in CI/CD without special configuration
[ ] Free tier available, no credit card required
[ ] Changelog exists and is maintained
[ ] Search works in documentation
[ ] Community channel exists and is monitored
```

Thresholds: all passes 8+ → the DX plan is solid. Any below 6 → flag as
critical DX debt. TTHW > 10 min → flag as a blocking issue.
