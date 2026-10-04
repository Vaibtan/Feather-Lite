# Architecture HTML report

Preserve the visual survey: one HTML report, ranked candidate cards, before/after diagrams, and a top recommendation. Store it outside the repository in a dedicated temporary report directory. Keep generated output separate from the skill's maintained files.

## Scaffold and presentation

Use Tailwind via CDN for layout and Mermaid via CDN for graphs/sequences. Use inline CSS/SVG or diagrammatic boxes for cross-sections, interface/implementation comparisons, or layouts Mermaid does not express well. The HTML is one report file; its CDN resources need network access. For offline viewing, use embedded CSS and SVG instead, preserving every candidate and its diagrams.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Architecture review — repository name</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict" });
    </script>
    <style>
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { border: 3px solid #0f172a; }
      .diagram { min-height: 16rem; overflow-x: auto; }
      svg { max-width: 100%; }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-6xl mx-auto px-6 py-12 space-y-10">
      <header>
        <h1 class="text-3xl font-semibold">Repository architecture review</h1>
        <p class="mt-2">Date · Scope · Source revision / working-tree state</p>
        <p class="mt-2 text-sm">Solid box: module · Dashed edge: seam · Red: leakage · Thick box: consolidated ownership</p>
      </header>
      <section id="candidates" class="space-y-8">
        <!-- Add ranked candidate articles using the fields below. -->
      </section>
      <section id="top-recommendation" class="rounded-xl border-2 border-emerald-700 bg-white p-6">
        <h2 class="text-xl font-semibold">Top recommendation</h2>
        <!-- Candidate anchor and evidence-backed reason to tackle it first. -->
      </section>
    </main>
  </body>
</html>
```

Replace scaffold placeholders in the generated report. Escape repository-derived prose and file paths as HTML text; keep Mermaid labels simple and valid. Do not embed application scripts or execute repository content in the report. A CDN failure should not hide the candidate evidence: replace unavailable diagram rendering with inline SVG/CSS and keep the saved report usable.

## Candidate cards

Each candidate is an article with a stable anchor, such as candidate-1:

1. Short title naming the responsibility change, with a Strong, Worth exploring, or Speculative badge. Add a dependency category when informative: in-process, local-substitutable, or ports/adapters.
2. Files, tight source locations, and observed friction. State relevant test or runtime evidence and uncertainty.
3. Before and proposed-after diagrams in two columns on wide screens, stacked on narrow screens. Include visible text labels and a legend when notation is not obvious.
4. Problem, solution direction, and concise benefits. Name the concrete gain: fewer caller decisions, owned cancellation, hidden persistence details, or tests protecting one meaningful behavior.
5. ADR conflict callout when warranted. Distinguish current state from a proposed change to an accepted decision.

Keep prose compact but sufficient to support the recommendation. Do not invent a defect, performance gain, or dependency merely to populate a diagram. Interface signatures come after candidate selection; these cards compare ownership and responsibilities.

## Diagram patterns

Choose the pattern that explains the candidate. Variety is useful when it reflects different problems.

- Mermaid flowchart: dependency/call relationships, leaking responsibilities, and proposed ownership. Style leakage red and consolidated ownership with a heavier border.
- Mermaid sequence: coordination or round trips. Label any unmeasured improvement as a hypothesis.
- CSS boxes with inline SVG arrows: precise before/after layout when automatic graph layout obscures ownership.
- Cross-section: thin forwarding layers becoming one cohesive module; retain layers with real policy or ownership.
- Interface/implementation comparison: show what callers must understand versus what a module hides. Use qualitative sizes unless actual measurements exist.
- Call-graph collapse: show private calls inside the proposed owner, keeping caller-visible responsibilities clear.

Example Mermaid dependency sketch:

```html
<div class="diagram rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[Request entrypoint] --> B[Operation policy]
      B --> C[Persistence adapter]
      A -. leaked persistence choice .-> C
      classDef leaking stroke:#dc2626,stroke-width:2px;
      class A,C leaking;
  </pre>
</div>
```

Pair a before sketch with a proposed-after diagram using the actual discovered names and relationships. Use the project's domain vocabulary and accurate Effect terms; module-depth vocabulary is shared guidance, not a ban on service, Layer, API, or boundary.

## Viewing and verification in Codex

Resolve a temporary directory with PowerShell `$env:TEMP` on Windows or a platform helper such as Node's os.tmpdir(). Give each run its own directory and architecture-review timestamp filename.

If a rendered file preview is supported, use it. Otherwise serve only that report directory with an available local server and open its URL in the Codex browser panel. For example, run Python's static server through the execution tool, retaining its session/process handle:

```powershell
python -u -m http.server 0 --bind 127.0.0.1 --directory $architectureReportDirectory
```

Read the assigned port from the server output rather than guessing it. Use the available Codex open-panel tool with a browser target for the resulting loopback URL. If launching through Start-Process, use -WindowStyle Hidden; a visible OS shell window is unnecessary. Stop the temporary server when viewing is finished, leaving the HTML artifact available.

Inspect the rendered report using available browser tools: every candidate has both diagrams; Mermaid produced diagrams rather than displaying raw graph text; labels and evidence are readable; the top-recommendation anchor works; narrow screens do not hide content. Fix rendering problems before presenting the report and asking for candidate selection. If browser/rendering capabilities are unavailable, state that verification limit and provide the absolute HTML path.
