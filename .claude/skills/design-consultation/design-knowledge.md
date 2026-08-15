# Design knowledge banks

Inform proposals from these; never display them as menus.

## Aesthetic directions

Brutally Minimal · Maximalist Chaos · Retro-Futuristic · Luxury/Refined ·
Playful/Toy-like · Editorial/Magazine · Brutalist/Raw · Art Deco ·
Organic/Natural · Industrial/Utilitarian.

Decoration levels: minimal / intentional / expressive. Layout: grid-disciplined /
creative-editorial / hybrid. Color: restrained / balanced / expressive. Motion:
minimal-functional / intentional / expressive.

## Fonts by role

- **Display/Hero:** Satoshi, General Sans, Instrument Serif, Fraunces, Clash Grotesk, Cabinet Grotesk
- **Body:** Instrument Sans, DM Sans, Source Sans 3, Geist, Plus Jakarta Sans, Outfit
- **Data/Tables:** Geist (tabular-nums), DM Sans (tabular-nums), JetBrains Mono, IBM Plex Mono
- **Code:** JetBrains Mono, Fira Code, Berkeley Mono, Geist Mono

**Blacklist (never):** Papyrus, Comic Sans, Lobster, Impact, Jokerman, Brush
Script, Trajan, Raleway, Clash Display (distinct from the recommended Clash
Grotesk), Courier New for body.
**Overused (never as primary unless asked by name):** Inter, Roboto, Arial,
Helvetica, Open Sans, Lato, Montserrat, Poppins, **Space Grotesk** — on the list
precisely because every AI design tool converges on it as "the safe alternative
to Inter." That's the convergence trap; treat it like Inter.

Across multiple proposals in one project, VARY light/dark, fonts, and aesthetic
directions — convergence across generations is slop.

## DESIGN.md template

```markdown
# Design System — {product}

## Product Context        ← what it is, who it's for, the memorable thing
## Aesthetic Direction    ← named direction + decoration level, with rationale
## Typography             ← Display / Body / UI / Data / Code, weights, scale
## Color                  ← approach; primary, secondary, neutrals;
                            semantic success/warning/error/info; dark mode
## Spacing                ← base unit (4/8px), density,
                            scale: 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)
## Layout                 ← approach, grid, max width, border-radius scale
## Motion                 ← easing: enter ease-out / exit ease-in / move ease-in-out;
                            duration: micro 50-100ms / short 150-250 / medium 250-400 / long 400-700
## Decisions Log          ← date | decision | rationale
```

CLAUDE.md pointer block (append after writing DESIGN.md):

```markdown
## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
```

## Preview-page requirements

Single self-contained HTML file. Proposed fonts via Google/Bunny Fonts links,
each shown in its role side by side with domain-real content. Palette section:
swatches with hex, buttons (primary/secondary/ghost), cards, inputs, alerts,
contrast pairs. 2-3 realistic product mockup sections keyed to project type
(dashboard / marketing / settings / auth). Light-dark toggle via CSS custom
properties. Responsive. The page dogfoods the proposed system throughout.
