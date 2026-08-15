# Pretext reference

## Tier routing

| Design type | Pretext APIs | Use case |
|-------------|-------------|----------|
| Simple layout (landing, marketing) | `prepare()` + `layout()` | Resize-aware heights |
| Card/grid (dashboard, listing) | `prepare()` + `layout()` | Self-sizing cards |
| Chat/messaging UI | `prepareWithSegments()` + `walkLineRanges()` | Tight-fit bubbles, min-width |
| Content-heavy (editorial, blog) | `prepareWithSegments()` + `layoutNextLine()` | Text around obstacles |
| Complex editorial | Full engine + `layoutWithLines()` | Manual line rendering |

## API cheatsheet

```
prepare(text, font) → handle
  One-time text measurement. Call after document.fonts.ready.
  Font: CSS shorthand like '16px Inter' or 'bold 24px Georgia'.
layout(prepared, maxWidth, lineHeight) → { height, lineCount }
  Fast layout computation. Call on every resize. Sub-millisecond.
prepareWithSegments(text, font) → handle
  Like prepare() but enables the line-level APIs below.
layoutWithLines(segs, maxWidth, lineHeight) → { lines: [{text, width, x, y}...], height }
  Full line-by-line breakdown. For Canvas/SVG rendering.
walkLineRanges(segs, maxWidth, onLine) → void
  Calls onLine(lineCount, startIdx, endIdx) per possible layout.
  Find minimum width for N lines. For tight-fit containers.
layoutNextLine(segs, state, maxWidth, lineHeight) → { text, width, state } | null
  Iterator. Different maxWidth per line = text around obstacles.
  Pass null as initial state; returns null when text is exhausted.
clearCache() → void      — clear measurement caches when cycling many fonts.
setLocale(locale?) → void — retarget the word segmenter.
```

## Wiring patterns — follow exactly

**Pattern 1: basic height computation (simple layout, card/grid)**

```js
const { prepare, layout } = await import('https://esm.sh/@chenglou/pretext')

await document.fonts.ready
const elements = document.querySelectorAll('[data-pretext]')
const prepared = new Map()
for (const el of elements) {
  prepared.set(el, prepare(el.textContent, getComputedStyle(el).font))
}

function relayout() {
  for (const [el, handle] of prepared) {
    const { height } = layout(handle, el.clientWidth,
      parseFloat(getComputedStyle(el).lineHeight))
    el.style.height = `${height}px`
  }
}
new ResizeObserver(() => relayout()).observe(document.body)
relayout()

// contenteditable: re-prepare when text changes
for (const el of elements) {
  if (el.contentEditable === 'true') {
    new MutationObserver(() => {
      prepared.set(el, prepare(el.textContent, getComputedStyle(el).font))
      relayout()
    }).observe(el, { characterData: true, subtree: true, childList: true })
  }
}
```

**Pattern 2: shrinkwrap / tight-fit (chat bubbles)** — binary-search the
narrowest width that keeps the same line count:

```js
function shrinkwrap(text, font, maxWidth, lineHeight) {
  const { lineCount: targetLines } = layout(prepare(text, font), maxWidth, lineHeight)
  let lo = 0, hi = maxWidth
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2
    const { lineCount } = layout(prepare(text, font), mid, lineHeight)
    if (lineCount === targetLines) hi = mid
    else lo = mid
  }
  return hi
}
```

**Pattern 3: text around obstacles (editorial)** — iterate `layoutNextLine`,
subtracting obstacle widths at each y:

```js
function layoutAroundObstacles(text, font, containerWidth, lineHeight, obstacles) {
  const segs = prepareWithSegments(text, font)
  let state = null, y = 0
  const lines = []
  while (true) {
    let availWidth = containerWidth
    for (const obs of obstacles) {
      if (y >= obs.top && y < obs.top + obs.height) availWidth -= obs.width
    }
    const result = layoutNextLine(segs, state, availWidth, lineHeight)
    if (!result) break
    lines.push({ text: result.text, width: result.width, x: 0, y })
    state = result.state
    y += lineHeight
  }
  return { lines, totalHeight: y }
}
```

**Pattern 4: full line-by-line rendering (complex editorial)** — absolutely
position a span per line (or draw to Canvas/SVG):

```js
const segs = prepareWithSegments(text, font)
const { lines } = layoutWithLines(segs, containerWidth, lineHeight)
for (const line of lines) {
  const span = document.createElement('span')
  span.textContent = line.text
  span.style.position = 'absolute'
  span.style.left = `${line.x}px`
  span.style.top = `${line.y}px`
  container.appendChild(span)
}
```
