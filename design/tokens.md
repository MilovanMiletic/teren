# Teren — design tokens (binding)

The single visual language for every screen. Register: modern professional field software —
warm canvas, white borderless cards, one coral-orange accent, near-black ink. Calm and
credible, judged on a muddy phone in the sun. Every artboard in `design/` is built from these
values; the Angular implementation translates them 1:1 into CSS custom properties
(`--color-canvas`, `--color-ink`, …).

## Colour

Contrast ratios given against the surface the colour is actually used on.

### Surfaces

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#EFEDE8` | Page background — warm off-white. The page is never pure white. |
| `card` | `#FFFFFF` | Cards, list containers, form fields. **Borderless** — separation is white-on-warm plus `shadow-card`. |
| `card-line` | `#ECE9E3` | Soft internal dividers *inside* a card (never card edges). |
| `field-line` | `#E5E1D8` | 1 px edge on form inputs only (fields need an affordance). |

`shadow-card`: `0 1px 3px rgba(26,26,26,0.04), 0 6px 20px rgba(26,26,26,0.05)` — the only
elevation; used on every card and white pill. Nothing else casts shadows except the record
button (`0 4px 20px rgba(232,103,74,0.35)`).

### Ink

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `ink` | `#1A1A1A` | Primary text, icons, black pills | 16.8:1 on white, 14.6:1 on canvas (AAA) |
| `ink-2` | `#5F5B52` | Secondary text, labels | 6.3:1 on white, 5.5:1 on canvas (AA+) |
| `ink-3` | `#A09A8E` | Placeholders, disabled, decorative glyphs — never body text | 2.9:1 (large/decorative only) |

### Accent — one coral-orange, two strengths

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `accent` | `#E8674A` | **Large fills only**: record button, waveform, progress fill, decorative circles | white icon on it 3.2:1 (≥3:1 graphics — OK; never text-sized type) |
| `accent-deep` | `#C2410C` | Primary pill buttons (white text), links, active states | white text on it 4.9:1 (AA); as text on white 4.9:1 (AA) |
| `accent-tint-1/2/3` | `#F7E7DF` / `#F0C9B8` / `#E8967B` | Layered decorative circles, future chart tints | decorative only |

Rule: text-sized accent uses `accent-deep`; `accent` appears only where the shape is big
enough to read as a graphic. No gradients, no candy colours.

### Semantic — status only, muted, on tint pills

| Token | Hex (text / tint bg) | Use |
|---|---|---|
| `ok` | `#166534` on `#E4EDE2` | sent / confirmed / synced |
| `warn` | `#92400E` on `#F6E8D8` | pending / offline / awaiting review (icons `#B45309`) |
| `err` | `#991B1B` on `#F6E1DC` | failed (icons/fills `#B91C1C`) |

Status chips: tint-background **pill** (radius 999), no border, 12 px/600 uppercase text in
the semantic text colour, optional 13 px icon. All tint/text pairs ≥ 5.5:1.

## Typography

Family: **IBM Plex Sans** (Google Fonts; full Serbian Latin diacritics č ć š ž đ).
Fallback: `Arial, sans-serif`. Weights 400 / 500 / 600 / 700. No other families.

| Step | Size / weight | Use |
|---|---|---|
| Display | 64 / 600, tabular | Recording timer only |
| H1 | 22 / 700 | Screen titles, empty-state headings |
| H2 | 17–20 / 700 | Card headings, app-bar titles |
| Body | 15 / 400–600 | Content, list rows; buttons 15–16 / 600 |
| Meta | 13 / 400–500 | Secondary lines, dates, notes |
| Label | 12 / 600, letter-spacing 0.8 px, uppercase, `ink-2` | Section labels (RADOVI, DANAŠNJI UNOS…) |

Weight carries hierarchy. `font-variant-numeric: tabular-nums` on every quantity, time, date,
counter. Nothing user-facing below 12 px.

## Shape

- **Cards: 20 px** radius (24 px for hero cards). **Buttons: full pill** (`border-radius: 999px`).
  Icon chips and state icons: circles. Form fields: 16 px. Thumbnails: 16 px.
- **`.t-label` has one rank, and that is a known limitation.** A section heading (`h2.t-label`) and
  a term in a fact list (`dt.t-label`) are both 12 px/600 uppercase ink-2, so they read as the same
  level — visible on `/company/profile` and `platform/user/:id`, which are the same layout. A
  heading variant needs exactly one distinguishing property (weight 700, or ink rather than ink-2)
  and must be applied to both screens in the same pass. Recorded 2026-09-02; not fixed on one
  screen alone, because the two screens exist to look identical.
- **Rows inside a floating list: 10 px** (`calc(var(--radius-field) - 6px)`) — a dropdown option, a
  column menu's entry. Recorded 2026-09-02: `ui/select-field.ts` and `ui/column-menu.ts` had both
  reached for the same expression because this line was missing, and a reviewer read it as drift.
- **No hairline borders on cards or buttons.** Separation = white on warm canvas + `shadow-card`.
  The only strokes: `field-line` on inputs, `card-line` dividers inside cards, and a 1.5 px
  `err` edge on an invalid field.

## Buttons

| Kind | Style | Use |
|---|---|---|
| Primary | `accent-deep` fill, white 15–16/600 text, pill, h 52–56 | The screen's one primary action |
| Solid-secondary | `ink` (#1A1A1A) fill, white text, pill | Strong non-primary actions (retry, stop) |
| Tertiary | `card` white fill + `shadow-card`, `ink` text, pill | Everything else tappable |
| Record | `accent` circle, 120–176 px, white mic | The signature element |

## Spacing

Strict 4/8 grid: 4, 8, 12, 16, 20, 24, 32. Page gutter **16 px**. Card internal padding
**16–20 px** (generous). Gap between stacked cards **12 px**. Left edges align.

## Touch targets

Minimum **44 px** (icon buttons); rows/buttons **48–56 px**; primary action full-width
**52–56 px**. Record circle **120 px** (home) / **176 px** (capture-focused), stop **128 px**.

## Motion

Motion in this product has one job: **tell the reader what just changed**. A screen that redraws
silently makes a foreman check twice, and a screen that dances makes an owner distrust it. So the
vocabulary is deliberately small — three durations for gestures, two for the things that repeat,
two curves — and every animation in the app is built from it. No component invents a duration, the
same way no component invents a hex.

| Token | Value | Use |
|---|---|---|
| `motion-fast` | `120ms` | Press feedback, hover tint, a status chip changing value, an arrow turning over |
| `motion-base` | `200ms` | Something arriving or leaving: a card, a list row, a modal, a popover, a column menu |
| `motion-slow` | `300ms` | A whole screen changing — the route cross-fade, and nothing else |
| `motion-pulse` | `1200ms` | The two things that repeat: the recording dot, and a loading skeleton |
| `motion-meter` | `90ms` | The live audio meter only. Faster than `fast` on purpose: it tracks a signal in real time, it is not feedback for a gesture |

| Easing | Curve | Use |
|---|---|---|
| `ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Everything entering, and every state change. Leaves fast, settles slowly |
| `ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Only things leaving. Accelerates away, because nobody watches an exit |

### The rule that outranks the table

**Nothing on the capture path may add latency to the thirty-second entry.** Motion *overlaps* work;
it never precedes it. No animation may have to finish before a tap takes effect, no press may wait
on a transition, and the record button, the photo button and "Gotovo" are never gated on a frame.
The recording screen keeps exactly one animation (the pulsing dot, which is information: it says
the microphone is live) and the saved screen keeps exactly one (the success mark arriving). That is
the whole budget for that flow, and it is spent.

### Reduced motion

`prefers-reduced-motion: reduce` collapses **every** animation and transition in the app to
`0.001ms` — a single wildcard rule in `styles.css`, no per-component exceptions and no "but this one
is important". A reader who has asked the operating system for stillness has asked this product too.
Anything that would only be understandable *because* it moved is a defect in the screen, not a
reason for an exemption: every state this product animates is also written down in words, a colour
or a count.

## Icons

Stroke-based inline SVG, 24 px grid (Lucide-style), stroke-width 2 (2.5 small status glyphs),
round caps/joins. Rendered 13–22 px in chrome, up to 64 px in the record button. **No emoji
anywhere in the UI.** Colour: `ink` active, `ink-2` passive, semantic for status.

## Voice and language

- UI text: Serbian, Latin script, **vi-form** (open founder question: vi vs ti).
- Content (transcripts, extracted values) is never translated or altered.
- Dates in `sr-Latn` format, e.g. "subota, 29. 8. 2026."
