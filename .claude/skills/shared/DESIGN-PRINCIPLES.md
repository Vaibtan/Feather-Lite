# Design Principles — shared reference

The one copy of the design rubric every design skill in this collection judges against.
A rating that can't be traced to a principle here is an opinion, not a finding.

## The nine principles

1. **Empty states are features.** "No items found." is not a design. Every empty state needs warmth, a primary action, and context.
2. **Every screen has a hierarchy.** What does the user see first, second, third? If everything competes, nothing wins.
3. **Specificity over vibes.** "Clean, modern UI" is not a design decision. Name the font, the spacing scale, the interaction pattern.
4. **Edge cases are user experiences.** 47-char names, zero results, error states, first-time vs power user — features, not afterthoughts.
5. **AI slop is the enemy.** Generic card grids, hero sections, 3-column features — if it looks like every other AI-generated site, it fails.
6. **Responsive is not "stacked on mobile."** Each viewport gets intentional design.
7. **Accessibility is not optional.** Keyboard nav, screen readers, contrast, touch targets — specify them or they won't exist.
8. **Subtraction default.** If a UI element doesn't earn its pixels, cut it. "Subtract the obvious, add the meaningful" (Maeda).
9. **Trust is earned at the pixel level.** Every interface decision either builds or erodes user trust.

## How great designers see

Not a checklist — perceptual instincts. Let them run automatically:

- **See the system, not the screen** — what comes before, after, and when things break.
- **Empathy as simulation** — run the mental movie: bad signal, one hand free, boss watching, first time vs 1000th time.
- **Constraint worship** — "If I can only show 3 things, which 3 matter most?"
- **The question reflex** — first instinct is questions, not opinions. Who is this for? What did they try before?
- **Edge case paranoia** — 47-char name? Zero results? Network fails? Colorblind? RTL?
- **The "would I notice?" test** — invisible = perfect. The highest compliment is not noticing the design.
- **Principled taste** — "this feels wrong" must trace to a broken principle. Taste is *debuggable*, not subjective.
- **Time-horizon design** — first 5 seconds (visceral), 5 minutes (behavioral), 5-year relationship (reflective); design for all three (Norman).
- **Storyboard the journey** — every moment is a scene with a mood, not just a screen with a layout (Gebbia).

Key references: Rams' 10 Principles, Norman's 3 Levels, Nielsen's 10 Heuristics, Gestalt,
Krug (*Don't Make Me Think*), Redish (*Letting Go of the Words*), Jarrett (*Forms that Work*),
Ive ("People can sense care and can sense carelessness"), Gebbia (designing for trust).

## The three laws of usability

1. **Don't make me think.** Every page self-evident. If a user stops to think "what do I click?", the design has failed. Self-evident > self-explanatory > requires explanation.
2. **Clicks don't matter, thinking does.** Three mindless, unambiguous clicks beat one click that requires thought.
3. **Omit, then omit again.** Get rid of half the words, then half of what's left. Happy talk must die. Instructions must die.

## How users actually behave

- **Users scan, they don't read.** Design billboards going by at 60 mph, not brochures. Visual hierarchy, defined areas, headings, highlighted terms.
- **Users satisfice.** They pick the first reasonable option, not the best. Make the right choice the most visible choice.
- **Users muddle through.** Once something works, no matter how badly, they stick to it.
- **Users don't read instructions.** Guidance must be brief, timely, and unavoidable, or it won't be seen.

## Billboard design

- **Use conventions.** Logo top-left, nav top/left, search = magnifying glass. Innovate only when you KNOW you have a better idea.
- **Visual hierarchy is everything.** Related = grouped, nested = contained, important = prominent. Assume everything is visual noise, guilty until proven innocent.
- **Make clickable things obviously clickable.** No hover-dependent discoverability — mobile has no hover.
- **Eliminate noise** — shouting, disorganization, clutter. Fix by removal, not addition.
- **Clarity trumps consistency.** Significantly clearer beats slightly consistent, every time.

## Navigation as wayfinding

Users have no sense of scale, direction, or location. Navigation must always answer:
what site is this, what page am I on, what are the major sections, what are my options,
where am I, how can I search? Persistent nav on every page; breadcrumbs for depth;
current section indicated. **The trunk test:** cover everything except the navigation —
you should still know the site, the page, and the sections.

## The goodwill reservoir

Users start with a reservoir of goodwill; every friction point depletes it.
**Deplete faster:** hiding info users want (pricing, contact), punishing format
mistakes, asking for unnecessary information, sizzle in the way (splash screens,
forced tours), sloppy appearance.
**Replenish:** make the main thing obvious, tell them what they want to know upfront,
save steps, easy error recovery, and when in doubt, apologize.

## Mobile: same rules, higher stakes

Real estate is scarce but never sacrifice usability for space. Affordances must be
VISIBLE — no cursor means no hover-to-discover. Touch targets ≥ 44px. Prioritize
ruthlessly: hurry-path things close at hand, everything else a few obvious taps away.

## Design hard rules

**Classify first:** MARKETING/LANDING (hero-driven, conversion-focused) · APP UI
(workspace-driven, data-dense) · HYBRID (landing rules for hero/marketing sections,
app rules for functional sections).

**Hard rejections** — instant-fail patterns, flag if ANY apply:
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating the same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout

**Litmus checks** — answer YES/NO for each:
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would the design feel premium with all decorative shadows removed?

**Landing page rules:** first viewport reads as one composition, not a dashboard.
Brand-first hierarchy: brand > headline > body > CTA. Expressive, purposeful
typography — no default stacks. No flat single-color backgrounds. Hero: full-bleed,
edge-to-edge; budget = brand, one headline, one supporting sentence, one CTA group,
one image; no cards in hero. One job per section. 2-3 intentional motions (entrance,
scroll-linked, hover/reveal). CSS variables for color; one accent color default.
Copy is product language, not design commentary.

**App UI rules:** calm surface hierarchy, strong typography, few colors. Dense but
readable, minimal chrome. Organize: primary workspace, navigation, secondary context,
one accent. Avoid dashboard-card mosaics, thick borders, decorative gradients,
ornamental icons. Copy is utility language — orientation, status, action. Section
headings state what an area is or does ("Selected KPIs", "Plan status").

**Universal rules:** CSS variables for the color system. No default font stacks
(Inter, Roboto, Arial, system-ui as primary = "I gave up on typography"). One job per
section. "If deleting 30% of the copy improves it, keep deleting." Cards earn their
existence. Body text ≥ 16px at ≥ 4.5:1 contrast. Never placeholder-as-label on form
fields. Preserve visited-link distinction. Headings sit visually closer to the section
they introduce than to the one above.

## AI slop blacklist

The patterns that scream "AI-generated":

1. Purple/violet/indigo gradients or blue-to-purple schemes
2. **The 3-column feature grid** — icon-in-colored-circle + bold title + 2-line description ×3. THE most recognizable AI layout.
3. Icons in colored circles as section decoration
4. Centered everything
5. Uniform bubbly border-radius on every element
6. Decorative blobs, floating circles, wavy SVG dividers (an empty-feeling section needs better content, not decoration)
7. Emoji as design elements
8. Colored left-border on cards
9. Generic hero copy ("Welcome to [X]", "Unlock the power of…", "Your all-in-one solution for…")
10. Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, all same height)
11. system-ui / -apple-system as the primary display or body font

Interrogate vague plan language the same way: "cards with icons" → what differentiates
these from every SaaS template? "Hero section" → what makes this hero feel like THIS
product? "Clean, modern UI" → meaningless; replace with actual decisions.
