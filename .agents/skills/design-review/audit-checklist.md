# The audit checklist — 10 categories

Every page in scope, every category. Findings carry impact (high / medium /
polish) + category + evidence screenshot.

## 1. Visual hierarchy & composition

One primary CTA per view. Squint test: is the hierarchy still visible when
blurred? White space intentional, not leftover. Related grouped, nested
contained, important prominent.

## 2. Typography

≤3 font families. Scale ratio 1.25 (major third) or 1.333 (perfect fourth).
Line-height ~1.5 body, 1.15-1.25 headings. Measure 45-75 chars (66 ideal). No
skipped heading levels. No blacklisted fonts (Papyrus, Comic Sans, Lobster,
Impact, Jokerman); Inter/Roboto/Open Sans/Poppins as primary → flag potentially generic.
`text-wrap: balance` on headings. Curly quotes, real ellipsis `…`.
`font-variant-numeric: tabular-nums` on number columns. Body ≥16px, captions
≥12px. No letterspacing on lowercase.

## 3. Color & contrast

≤12 non-gray colors. WCAG AA: body 4.5:1, large text 3:1, UI elements 3:1. Dark
mode uses elevation, not lightness inversion; text off-white (~#E0E0E0), accent
desaturated 10-20%; `color-scheme: dark` set. No red/green-only signals (8% of
men have red-green deficiency). Neutrals consistently warm or cool.

## 4. Spacing & layout

4px/8px base scale — flag off-scale values. Border-radius hierarchy; inner radius
= outer radius − gap on nested elements. Max content width set. Safe-area insets
respected. URL reflects state. Breakpoints exercised: 375 / 768 / 1024 / 1440.

## 5. Interaction states

Hover on everything interactive. `focus-visible` ring — never `outline: none`
without a replacement. Disabled = reduced opacity + `cursor: not-allowed`. Touch
targets ≥44px. Mindless-choice audit: every decision point should be a mindless
click — a click that requires thought about whether it's right is a HIGH finding.

## 6. Responsive

Mobile layout makes *design* sense — a stacked desktop layout on mobile is not
responsive design, it's lazy. No `user-scalable=no` / `maximum-scale=1`.

## 7. Motion & animation

Ease-out entering, ease-in exiting, ease-in-out moving. Durations 50-700ms.
`prefers-reduced-motion` respected. No `transition: all`. Animate only
`transform` and `opacity`, never layout properties.

## 8. Content & microcopy

Button labels specific ("Save API Key," not "Continue"). Loading states end with
`…`. **Happy-talk detection:** if you can hear "blah blah blah," it's happy talk —
flag for removal; report "this page has X words, Y (Z%) are happy talk."
**Instructions detection:** if users need to read instructions, the design has
failed.

## 9. AI slop

Run the full blacklist and hard rules from `../shared/DESIGN-PRINCIPLES.md`
(classify marketing/app/hybrid first). The one-line test: would a human designer
at a respected studio ever ship this?

## 10. Performance as design

LCP <2.0s (apps) / <1.5s (informational). CLS <0.1. Images lazy-loaded with
dimensions, WebP/AVIF. Fonts `font-display: swap` + preconnect.
