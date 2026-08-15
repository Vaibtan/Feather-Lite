---
name: diagram
description: Turn a description into a rendered diagram. Use when the user asks for a diagram, flowchart, architecture sketch, sequence diagram, or says "draw this".
---

# Diagram — English in, editable diagram out

Every run delivers a rendered image plus its editable source — never a dead pixel
dump, never source-only.

| Artifact | What it's for |
|---|---|
| `<slug>.mmd` | mermaid source — the single source of truth |
| `<slug>.svg` + `<slug>.png` | crisp vector for docs + raster for chat/issues/READMEs |

## Step 1 — Author

Write mermaid for the user's request:

- **Flowcharts are the sweet spot.** `graph LR` for pipelines/flows, `graph TD` for hierarchies.
- Keep node labels short; put detail in edge labels. 5-15 nodes is the readable
  range — if the ask needs more, split into multiple diagrams and say why.
- Output directory: `./diagrams/` when the cwd is a git repo (artifacts the user can
  commit), else a temp directory. Derive `<slug>` from the subject (kebab-case, ≤40 chars).

## Step 2 — Render

Write the source to `<outdir>/<slug>.mmd` first (Write tool), then render both formats:

```bash
npx -y @mermaid-js/mermaid-cli -i <outdir>/<slug>.mmd -o <outdir>/<slug>.svg
npx -y @mermaid-js/mermaid-cli -i <outdir>/<slug>.mmd -o <outdir>/<slug>.png --scale 3
```

If mermaid reports a parse error: fix the source and re-render — never hand the user
a broken source file. If mermaid-cli cannot run at all (no node, no network), deliver
the source in a ` ```mermaid ` fence with a note that it's unrendered — many surfaces
(GitHub, Claude artifacts) render the fence natively.

## Step 3 — Show and deliver

1. Read the PNG with the Read tool so the user sees the diagram inline.
2. List the artifact paths.
3. One-line editability note: paste the `.mmd` into excalidraw.com
   (More tools → Mermaid to Excalidraw) for a fully editable scene — flowcharts
   convert to editable elements; sequence/state/gantt import as a static image.
4. Changes → edit the `.mmd`, re-run Step 2. The source is the single source of truth.

## Rules

- **Never ship without rendering.** A `.mmd` file alone is not a diagram. If rendering
  is impossible, say so and deliver the fenced fallback with the limitation named.
- Done = rendered pair delivered and shown inline. Blocked = rendering impossible and
  the fenced fallback delivered with a note.
