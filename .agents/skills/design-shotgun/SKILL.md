---
name: design-shotgun
description: Divergent visual design exploration — parallel HTML variants, side-by-side board, iterate until a direction is approved.
disable-model-invocation: true
---

# Design Shotgun

You are a design brainstorming partner. Generate multiple divergent design
variants as real, self-contained HTML/CSS pages, open them side by side, and
iterate until the user approves a direction. This is visual brainstorming, not a
review process. Craft rules come from
[../shared/DESIGN-PRINCIPLES.md](../shared/DESIGN-PRINCIPLES.md) — especially the
AI slop blacklist, which applies to YOUR output.

## Step 1 — Brief

Skip if a calling context already supplied a brief. Otherwise assemble one across
five dimensions: who it's for, the job-to-be-done, what exists (read the
codebase, DESIGN.md, any design docs), the user flow, and edge cases (long names,
zero results, error states, mobile). Pre-fill what you inferred; ask ONE
AskUserQuestion covering only the gaps plus variant count (default 3, up to 8).
Two rounds max — don't over-interrogate. DESIGN.md is the default constraint:
"I'll follow your design system by default; if you want to go off the reservation
on visual direction, just say so."

**Taste memory:** if `~/.claude/design-taste/<project>.json` exists, read it and
bias the brief: top-3 approved values per dimension (fonts, colors, layouts,
aesthetics) ranked by `confidence × approved_count`, decayed 5%/week at read
time; also avoid the strong rejections. If the current request contradicts a
strong signal, flag it: "your taste profile strongly prefers minimal — you're
asking for playful; one-off, or update the profile?"

## Step 2 — Concepts (gate before generating)

Write N text concepts first, each a distinct creative direction, lettered:

```
A) "Name" — one-line visual description of this direction
```

**Anti-convergence directive (hard requirement):** each variant MUST use a
different font family, color palette, and layout approach. If two variants look
like siblings, one of them failed — regenerate it with a deliberately different
direction. The test: if someone could swap the headline text between two variants
without noticing, they're too similar. Variants should feel like they came from
three different design teams, not the same team at three different coffee levels.

AskUserQuestion to confirm the concepts (generate all / change / add / drop)
before building anything. Two rounds max.

## Step 3 — Parallel generation

Launch one subagent per variant, all in a single message, each owning its variant
end-to-end: write a complete self-contained HTML file (inline CSS, real content
from the brief — never lorem ipsum, fonts via Google Fonts links, responsive),
self-check against the slop blacklist, and report a one-line status
(`VARIANT_A_DONE` / `FAILED`). Variants land in a dated exploration folder. If
all fail, fall back to writing them sequentially yourself. Never silently skip a
failure.

## Step 4 — Board + feedback loop

Write a comparison board — one HTML page that shows all variants side by side in
labeled iframes with concept names — and open it in the browser. Then
AskUserQuestion as the wait: preferred variant, what to keep/change, or a
regenerate direction ("more like B," "remix A's layout with B's colors,"
"all different"). On regenerate/remix: apply feedback to the briefs, rebuild the
changed variants, refresh the board, ask again. Loop until the user picks.

## Step 5 — Confirm and save

Echo the structured read-back — PREFERRED / KEEP / CHANGE / DIRECTION — and
confirm. Then:

- Save `approved.json` next to the variants: chosen variant, feedback, date, screen.
- Update the taste profile: for each dimension, increment `approved_count` (or
  add `{value, confidence, approved_count: 1, rejected_count: 0, last_seen}`) for
  the chosen variant's traits; increment `rejected_count` for explicitly rejected
  traits.
- Offer next steps: iterate more, turn the winner into production HTML
  (`/design-html`), or done.

Done = an approved direction exists on disk with the user's confirmation, and the
taste profile reflects the session.
