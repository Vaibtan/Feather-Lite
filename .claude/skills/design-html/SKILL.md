---
name: design-html
description: Production-quality, self-contained HTML with computed text layout via Pretext — from a mockup, a plan, or a live description.
disable-model-invocation: true
---

# Design HTML

Generate production-quality HTML where text actually works correctly. Not CSS
approximations — computed layout via [Pretext](https://www.npmjs.com/package/@chenglou/pretext):
text reflows on resize, heights adjust to content, chat bubbles shrinkwrap,
editorial spreads flow around obstacles. One page per invocation. API and wiring
patterns live in [pretext.md](pretext.md); craft rules in
[../shared/DESIGN-PRINCIPLES.md](../shared/DESIGN-PRINCIPLES.md).

## Step 0 — Mode

Pick from what exists, and say which you're in:

- **approved-mockup** — the user has a mockup image (from `/design-shotgun` or
  elsewhere): pixel-match it.
- **evolve** — a prior finalized HTML exists: offer evolve vs start fresh.
- **plan-driven** — a plan/design doc but no approved visual: the plan is the
  source of truth.
- **freeform** — nothing exists: design live from the user's description
  (ask purpose/audience, visual feel, content structure, reference sites — one
  question).

## Step 1 — Implementation spec

Produce the spec before writing code: exact hex colors, fonts + weights, spacing
scale, component list, layout type. In approved-mockup mode, Read the image and
extract these yourself. DESIGN.md tokens, if present, OVERRIDE extracted values
for system-level properties. Completion: the spec summary is shown before
generation.

## Step 2 — Route the Pretext tier

Classify the design and state the tier and why — the tier→API routing table is
in [pretext.md](pretext.md).

If the project uses a framework (check package.json for react/svelte/vue/…), ask:
vanilla HTML or a framework component. Default vanilla when none detected.

## Step 3 — Generate

Write ONE file. Pretext via CDN import (`https://esm.sh/@chenglou/pretext`) for
vanilla HTML, or the project's package manager for framework output. Always
include: CSS custom properties for the tokens; fonts via `<link>` +
`document.fonts.ready` gate before the first `prepare()`; semantic HTML5; the
tier's wiring pattern from [pretext.md](pretext.md) (ResizeObserver relayout,
MutationObserver re-prepare on `contenteditable`); breakpoints 375/768/1024/1440;
ARIA + focus-visible; `prefers-color-scheme` and `prefers-reduced-motion`; real
content, never lorem ipsum. Never include anything on the shared AI-slop
blacklist, plus: stock-photo placeholder divs, generic "Get Started"/"Learn More"
CTAs not in the source, decorative patterns not in the mockup.

## Step 4 — Preview + refinement loop

Serve the folder (`python3 -m http.server` or just open the file) and, if a
browser tool is available, screenshot at 375/768/1440 and fix text overflow or
layout collapse BEFORE presenting. Then loop: show the URL (+ the mockup for
comparison) → AskUserQuestion "what needs to change? say 'done' when it's right"
→ apply **surgical edits** with the Edit tool — never regenerate the file; the
user may have made contenteditable edits worth preserving → re-screenshot →
repeat. Exit on "done"/"ship it"/"looks good". Max 10 iterations, then ask
continue-or-done.

## Step 5 — Close

If no DESIGN.md exists, offer to extract the tokens (colors/spacing/fonts/radius/
shadows) into one. Offer: copy into the project / iterate more / done.

## Rules

- **Source-of-truth fidelity over code elegance.** When a mockup exists,
  pixel-match it — if that means `width: 312px` instead of a grid class, that's
  correct. Cleanup happens later during component extraction.
- **Always use Pretext for text layout.** Even for simple designs — the overhead
  is 30KB; every page benefits.
- Real content only. One page per invocation.
