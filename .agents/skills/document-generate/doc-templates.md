# Diataxis quadrant templates

One template per quadrant. Each quadrant serves a different reader in a different
mode — never mix tutorial content into reference, or reference into how-tos.

## Reference — information-oriented

```markdown
# [Entity Name]

[One paragraph: what it is, what it does, when you'd use it.]

## API / Interface

[Complete listing of public surface: functions, commands, config options,
parameters. Include types, defaults, and constraints. Pull directly from code —
do not paraphrase loosely.]

## Options / Configuration

[If applicable: every option with its type, default, and effect.]

## Examples

[2-3 concrete examples showing actual usage. Prefer real command output or code
that would actually compile/run.]

## Related

[Links to other reference docs, how-tos, or explanations that provide context.]
```

Rules:
- Accuracy over elegance. Every claim must be traceable to code.
- Include types, defaults, and constraints. "Accepts a string" is insufficient —
  "Accepts a string (max 256 chars, must match `^[a-z-]+$`)" is reference-grade.
- Show real examples that would actually work if copy-pasted.
- Do not explain *why* — that belongs in explanation docs.

## Explanation — understanding-oriented

```markdown
# [Concept / Design Decision]

[Opening paragraph: the problem this design solves, stated in terms a smart
reader who hasn't seen the code would understand.]

## The problem

[Concrete description of what goes wrong without this design. Real failure
modes, not abstract risks.]

## The approach

[How the design solves the problem. Include diagrams (ASCII or Mermaid) for
architectural concepts.]

## Trade-offs

[What was given up. Every design decision trades something — name it explicitly.]

## Alternatives considered

[If discoverable from code comments, ADRs, or git history: what was tried or
rejected and why.]
```

Rules:
- Lead with the problem, not the solution.
- Use ASCII diagrams for architecture. They're grep-able, diff-friendly, and
  render everywhere.
- Name trade-offs explicitly. "We chose X over Y because Z" is the gold standard.
- Do not repeat reference material — link to it.

## How-to — task-oriented

```markdown
# How to [accomplish specific task]

[One sentence: what you'll accomplish and the end result.]

## Prerequisites

[What the reader needs before starting. Be specific — versions, installed
tools, config state.]

## Steps

1. [Action verb] [specific instruction]

   ```bash
   [exact command]
   ```

   [Expected output or result, if non-obvious.]

2. [Next step...]

## Verification

[How to confirm it worked. A command, a URL to visit, a test to run.]

## Troubleshooting

[Common failure modes and their fixes. Pull from tests and error handling code.]
```

Rules:
- Title starts with "How to" — no exceptions. This is the reader's entry point.
- Every step must be actionable. No "consider whether..." — instead "Run X" or
  "Add Y to Z".
- Include verification. The reader should never wonder "did it work?"
- Troubleshooting section is mandatory if the task can fail.

## Tutorial — learning-oriented

```markdown
# [Tutorial title — describes what you'll build/learn]

[Opening paragraph: what you'll build, why it's useful, and what you'll
understand by the end. Keep it concrete — "You'll build a working X that does Y"
not "This tutorial covers X".]

## What you'll need

[Prerequisites: tools, versions, prior knowledge. Link to installation guides.]

## Step 1: [Set up the foundation]

[Start from a clean state. Show every command. Explain what each does on first
encounter — but briefly, not a lecture.]

## Step 2: [Build the first working piece]

[Get to a working, visible result as fast as possible. The reader should see
something happen within the first 3 steps.]

...

## What you built

[Recap: what the reader now has and what it can do. Link to reference docs for
deeper exploration. Suggest next steps.]
```

Rules:
- **Time to first result < 3 steps.** If the reader hasn't seen something work
  by step 3, the tutorial is too slow.
- Every step must produce a visible change or output. No "now configure X"
  without showing what changes.
- Use the exact commands the reader will type. No "run the appropriate command"
  abstractions.
- Error paths: if a step commonly fails, show the error and the fix inline.
- End with "What you built" — connect the tutorial back to the real use case.
