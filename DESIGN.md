---
name: OPD Scan QC
description: A ward chart made into an instrument — every figure plotted against the band it is read against, and nothing measured drawn as if it were.
colors:
  paper: "#fbfaf6"
  paper-2: "#f3f1e9"
  paper-3: "#eae7dc"
  rule: "#cfc9b8"
  rule-2: "#a8a08c"
  ink: "#1a1d21"
  ink-2: "#5a6169"
  chart: "#1f4e79"
  band: "#2f6b3c"
  note: "#8a5512"
  plot: "#a32a1c"
typography:
  page-title:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  dialog-title:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "Archivo Narrow, Archivo, system-ui, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.08em"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontVariation: "lining-nums"
  annotation:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.375
    letterSpacing: "normal"
  field-label:
    fontFamily: "Archivo Narrow, Archivo, system-ui, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
  control-label:
    fontFamily: "Archivo Narrow, Archivo, system-ui, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  none: "0"
  sm: "1px"
  DEFAULT: "2px"
  md: "2px"
  lg: "2px"
  xl: "2px"
  full: "9999px"
spacing:
  hair: "1px"
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
components:
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
  sheet-head:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink}"
    typography: "{typography.section-title}"
    padding: "8px 12px"
  button-primary:
    backgroundColor: "{colors.chart}"
    textColor: "{colors.paper}"
    typography: "{typography.control-label}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "30px"
  button-secondary:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    typography: "{typography.control-label}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "30px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-3}"
  button-danger:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.plot}"
    typography: "{typography.control-label}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "30px"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.control-label}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
    height: "30px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "6px 8px"
    width: "100%"
  input-disabled:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-2}"
  status-stamp:
    textColor: "{colors.ink-2}"
    typography: "{typography.field-label}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  table-header-cell:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink-2}"
    typography: "{typography.field-label}"
    padding: "6px 10px"
  table-cell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "6px 10px"
  table-row-alt:
    backgroundColor: "{colors.paper-2}"
  nav-item:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "6px 8px"
  nav-item-active:
    backgroundColor: "{colors.chart}"
    textColor: "{colors.paper}"
    padding: "6px 8px"
---

# Design System: OPD Scan QC

## Overview

**Creative North Star: "The Case Sheet"**

This interface is the ward chart the hospital already runs on, made into an instrument. A figure
is never stated as a bare number when a scale exists to read it against: the count sits in lining
tabular numerals at the left of a ruled row, the band is plotted at its right, and the reference
marks that give the band meaning open in place when the row is touched. It refuses the
admin-console arrangement — a number floating in a soft rounded card with a coloured delta and
nothing said about what it was measured against — and it refuses it structurally, not by taste:
there are no cards in this system, the radius scale tops out at 2px, and every shadow utility
resolves to `none`.

The material is chart stock, hairline rules and two inks. Density is deliberate and unapologetic
— a records clerk works hundreds of rows a shift, so the body size is 13px, table rows are 6px
tall in padding, and a screen fits what a screen fits. That density is never paid for by a finger:
under `pointer: coarse` every control grows to a 40px minimum, because intake happens on tablets
at the ward and the front desk.

The one idea the whole system is arranged around is the difference between *nothing was found* and
*nothing was established*. A failed check, an unconfigured provider and a queued page all report an
absence of knowledge; `none_detected` and `not_found` report a finding. The first group is drawn
with a 45° graphite hatch — the chart convention for a region that was never measured — and the
hatch appears nowhere else in the system, on nothing decorative, ever.

**Key Characteristics:**

- Chart stock ground (`#fbfaf6`), hairline printed rules, two inks, no cards and no nesting
- Every radius clamped to 2px; every `box-shadow` utility resolves to `none`
- Colour only ever means status; `chart` blue is the single structural accent
- Hatching is the one meaning-bearing texture and it means "never measured"
- Archivo body, Archivo Narrow condensed caps for every pre-printed label; lining figures globally
- One authored moment of motion, 150ms on a damped curve, collapsed to instant under reduced motion
- Light and dark are the same eleven variables flipped by the OS; no `dark:` variant exists anywhere

## Colors

Eleven colours, declared once each as an `R G B` triple in `frontend/src/index.css` and consumed
only through Tailwind — chart stock and rules build every surface, two greys carry every word, and
four inks carry every verdict.

### Primary

- **Pre-Printed Chart Blue** (`chart`): the single structural accent. Links, the filled primary
  button, the inked active navigation item, the focus outline, the row hover and current-row
  washes (`chart` at 7% and 12%), the text selection background (22%), and the caret and
  `accent-color` on every native control. It is also the `info` status ink.
- **Chart Stock** (`paper`): the ground the application is printed on — body background, sheet
  interiors, input fields, the unfilled part of every band.

### Secondary

- **Ruled Band** (`paper-2`): the zebra row in tables, the index column ground, disabled controls,
  the identification cells in the chart head, the empty-state field.
- **Pre-Printed Header Fill** (`paper-3`): section heads and sticky table header cells — the tint a
  form uses for the row it printed before anyone wrote on it.

### Tertiary

Status inks. These four exist only to mean something. Nothing decorative in this application is
ever coloured, which is what lets a stamp read as a verdict rather than as styling.

- **In-Band Green** (`band`): `ok`. Acceptable, ingested, confirmed, accepted.
- **Wants-A-Look Ochre** (`note`): `warn`. Needs review, awaiting review, and the unreviewed-AI
  badge; also the tone of a margin note that is a warning rather than an explanation.
- **Out-Of-Band Red** (`plot`): `bad`. Rescan required, quality check failed, errors — and the
  destructive button variant, which is filled in the same ink that means "out of band" everywhere
  else rather than in a decorative danger palette of its own.

### Neutral

- **Writing Ink** (`ink`): every primary word, the masthead mark's border, the live detent on a
  band, the modal scrim at 60%.
- **Pencil Grey** (`ink-2`): secondary text, field labels, annotations, unmeasured figures, the
  hatch stroke at 20%, the ghost detent, the scrollbar thumb.
- **Hairline Grid** (`rule`): the lightest rule — row dividers, band borders, the chart grid.
- **Section Rule** (`rule-2`): the heavier rule — sheet borders, section heads, table heads, input
  boxes, and the double rule.

### Named Rules

**The Status-Only Colour Rule.** Colour never means anything but status. `band`, `note` and `plot`
appear only where a state is being reported; `chart` is the one structural accent and carries no
verdict except `info`. Audit test: point at any coloured pixel and name the status it reports. If
you cannot, it is a defect.

**The Enumerated Ink Rule.** The palette is eleven custom properties and adding a colour means
adding one there. Anything that looks like a twelfth tone is a printed texture (a hatch, a tint of
an existing ink at 7%/12%/22%), never a new hue.

**The Never-Alone Rule.** Colour is never the sole carrier of meaning. Every status ink ships with
a drawn mark and a text label from `lib/status.ts`, so a stamp survives greyscale, any
colour-vision profile, and a screen reader.

**The One Theme, Two Values Rule.** There are no `dark:` variants in this application — a grep
returns zero. The eleven variables flip under `prefers-color-scheme` and every utility follows.
Dark is the same chart read on a light box: stock goes to `#15181b`, ink to `#e8e6df`, and the four
status inks lighten to hold contrast. The system setting is the default, not a lock: a
`data-theme` attribute on the root element overrides it in either direction, set from the
Appearance control in the sidebar and remembered per machine.

**The Scrim Exception.** Exactly one surface does not flip: the wash behind a dialog. Drawn in
`ink` it would dim the page in light mode and wash it out with near-white in dark, so it is
declared once as `rgb(8 10 12 / 0.62)` and darkens in both schemes. A scrim is shadow, not ink.

## Typography

**Body Font:** Archivo (with `system-ui`, `-apple-system`, `Segoe UI`, `Roboto`, `sans-serif`)
**Label Font:** Archivo Narrow (with `Archivo`, `system-ui`, `Segoe UI`, `sans-serif`)
**Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas` — declared in the scale and
essentially unused; numeric columns get `tabular-nums` on Archivo instead.

Both faces are **self-hosted variable woff2**, latin and latin-ext subsets, weight axis `400–700`
(Archivo) and `500–700` (Archivo Narrow), `font-display: swap`, served from
`frontend/src/fonts/`. There is no CDN link and there must not be one: this system deploys
on-premise inside hospital networks, and a font that only arrives from a CDN is a font that does
not arrive.

**Character:** A grotesque that is neutral enough to disappear behind the numbers, paired with its
own condensed cut doing the job a pre-printed form gives to letterspaced small caps. The pairing is
one family, two widths — the form and the handwriting on it, not two personalities.

### Hierarchy

- **Page title** (600, 20px, 1.25, `-0.02em`): the `ChartHead` `h1`, once per screen, above the
  double rule.
- **Dialog / secondary title** (600, 15px, 1.25, `-0.02em`): modal headings. 17px at the same
  weight is used for the login heading and the no-access notice.
- **Section title** (Archivo Narrow, 600, 13px, uppercase, `0.08em`): the `Panel` heading inside a
  sheet head.
- **Body** (400, 13px, 1.5): every row, cell, value and sentence. The document base is 14px/1.5 on
  `<body>`; 13px is what the application actually sets. Descriptions cap at `68–70ch`.
- **Annotation** (400, 11px, 1.375, `ink-2`): field hints, margin notes, expanded band readouts,
  the second line under a status count.
- **Field label** (Archivo Narrow, 600, 11px, uppercase, `0.08em`, `leading-none`, `ink-2`): the
  `.field-label` primitive — every form label, every table header cell, every identification field
  in the chart head, every definition term.
- **Control label** (Archivo Narrow, 600, 12px, uppercase, `0.08em`): button text.
- **Stamp** (Archivo Narrow, 600, 11px / 10px small, uppercase, `0.08em`): status pill text, with
  the qualifier set at 400 and 90% opacity beside it.

### Named Rules

**The Pre-Printed Label Rule.** Anything that *names a box* is set in Archivo Narrow, 11px,
semibold, uppercase, `0.08em`, in pencil grey. Anything *written in the box* is Archivo at 13px in
writing ink. A label never borrows body type and a value never borrows label type.

**The Lining Figure Rule.** `font-variant-numeric: lining-nums` is set on `html` because this
application is almost entirely numbers, and every figure that sits in a column also carries
`tabular-nums` so digits line up between rows.

## Layout

The shell is a full-height flex row: a fixed 13.5rem (216px) index column and a scrolling main
region padded 12px, rising to 20px at `lg`. Content is capped at `110rem` and centred; there is no
narrower reading measure, because the screens are tables and a table wants the width. The login
screen is the one exception — a single 23rem sheet centred on the ruled-band ground.

The spacing rhythm is a 4px base used tightly: `gap-2` (8px) is the default between controls,
`gap-3` (12px) between blocks, and `space-y-4` (16px) between sheets down a page. Sheet bodies are
padded 12px, or flush (zero) when the content is itself a grid — tables and ruled lists meet the
rule rather than floating inside it. Table cells are 10px × 6px. Multi-panel screens run
`sm:grid-cols-2` and `lg:grid-cols-3` / `lg:grid-cols-4`.

Responsive behaviour turns on `md` (768px). Below it the index column stops being a column: it
becomes a full-width horizontal strip that scrolls, its group headings dissolve (`max-md:contents`)
so the items join one continuous run, each item gets a right-hand rule, and the account controls
move up into the masthead because the tall footer block has nowhere to sit. Chart-head
identification fields stack to one column below `sm` and split to two above it. Band widths step
with the breakpoint (`w-16 sm:w-24`, `w-20 sm:w-32`).

Density is paid for at the pointer, not at the layout. Under `@media (pointer: coarse)` every
button, select, textarea and text input takes a 40px minimum height and checkboxes and radios grow
to 1.15rem, so the same dense screen is usable with a finger on a ward tablet.

### Named Rules

**The Device-Pixel Rule.** A printed rule is one device pixel, not one CSS pixel. `--hair` is
`1px`, and `0.5px` above `2dppx`; the chart grid and the hatch are drawn from it.

## Elevation & Depth

**There are no shadows.** Every `boxShadow` step in the Tailwind scale — `sm`, `DEFAULT`, `md`,
`lg`, `xl`, `2xl`, `inner` — is overridden to `none`, so a stray `shadow-lg` copied from anywhere
renders flat and the rule cannot be eroded one component at a time. A grep for shadow utilities in
the application returns nothing.

Depth is declared once, as a rule. Separation is a border in one of two weights: `rule` for a
hairline (row dividers, band edges) and `rule-2` for structure (sheet outline, section head, table
head, input box). Layering is tonal: `paper` for what is written on, `paper-2` for a ruled band or
a passive ground, `paper-3` for a pre-printed head. A sheet does not float above the page; it is
printed on it.

The one exception in the build is the modal scrim — writing ink at 60% with a 1px backdrop blur —
which separates the dialog from the page behind it. It is a scrim, not an elevation token, and it
exists at exactly one site.

### Named Rules

**The Rule-Not-Shadow Rule.** Ink on paper does not float. If two things need separating, draw a
rule or change the tone of the stock. Never reach for a shadow; the utility will not render one
anyway.

## Shapes

Corners are cut, not rounded. The radius scale is clamped end to end: `none` 0, `sm` 1px, and
`DEFAULT` through `3xl` all 2px, so every legacy `rounded-xl` in the codebase resolves to 2px and
the corner language holds even on screens that were never rewritten. `full` (9999px) remains
defined but no `rounded-full` appears anywhere in the application — nothing in the built system is
a pill.

The form language is the box: a hairline rectangle with a condensed caps label above it and nothing
else. The recurring silhouettes are a bordered block of chart stock (`.sheet`), a bordered block
with a tinted head (`.sheet-head`), a 3px double rule closing a section head (`.rule-double`), a
bordered square mark for identity and avatars, and a bordered track with a filled portion (the
band). Empty states are a dashed `rule-2` box; that dash is the only broken line besides the ghost
detent and the dotted leader in a reading row.

### Named Rules

**The 2px Ceiling.** No corner in this system exceeds 2px. There is no exception and no
pill-shaped element.

**The Hatch-Means-Unmeasured Rule.** `.hatch` — 45° repeating pencil-grey lines at 20% on a 6px
pitch — marks a region that was never measured, and nothing else. It is applied to a status stamp
whose `unmeasured` flag is set, to a band with no value behind it, to a band whose known value
describes something unmeasured, and to the stalled loading track. It is never decoration, and it is
always paired with a text label so it is reinforcement rather than the signal. An empty result set
is deliberately *not* hatched: the query ran and returned nothing, which is a finding.

**The Grid-Means-Scale Rule.** `.chart-grid` — an 8px printed measuring grid at `--hair` — appears
only on a region that actually plots a value against a scale. Two sites in the build use it, both
bands. It is never page decoration.

## Components

### Buttons

- **Shape:** square (0 radius), 30px minimum height, 12px × 4px padding, Archivo Narrow 12px
  semibold uppercase at `0.08em`, colour transition 150ms on `ease-chart`.
- **Primary:** filled chart blue with a chart-blue border and paper text; hover drops to 90%
  opacity; disabled goes pencil-grey fill with a `rule-2` border. The only filled action in the
  system alongside `danger`.
- **Secondary (default variant):** `rule-2` border on ruled-band fill, ink text, hover to
  pre-printed header fill.
- **Danger:** `plot` border and `plot` text on a 7% `plot` wash, hover to 14% — coloured by the
  status rule, not by a separate danger palette.
- **Ghost:** transparent border, ink text, hover to the 7% chart wash.
- **Focus:** the global `:focus-visible` outline — 2px `chart`, 2px offset — applies everywhere;
  `FOCUS_RING` survives only for elements that opt out of the default and need it restored.
- **Disabled:** `cursor-not-allowed`, 70% opacity.

### Cards / Containers

There are no cards. `.sheet` is the only container in the system and **it never nests inside
another one**: a `rule-2` border on chart stock, zero radius, no shadow. `Panel` adds a head —
pre-printed fill, a `rule-2` bottom border, 12px × 8px padding, an Archivo Narrow 13px uppercase
title, an optional 12px description capped at 68ch, and an optional action slot pinned right. The
body is padded 12px, or flush for content that should meet the rule.

### Inputs / Fields

- **Style:** full-width, `rule-2` hairline box on chart stock, zero radius, 8px × 6px padding, 13px
  ink text, placeholder at 70% pencil grey. The label sits above in `.field-label`, associated by
  a real `htmlFor`/`id` pair generated with `useId`.
- **Focus:** the global 2px chart outline at 2px offset.
- **Disabled:** ruled-band fill, pencil-grey text.
- **Checkbox groups:** always inside a `<fieldset>` with a `.field-label` legend so the group name
  is announced with each option; the box itself is `rounded-none`, 14px, `rule-2` border, checked in
  chart blue, with the whole row hovering to the 7% chart wash.
- **Hints:** 11px pencil grey under the control, never a tooltip.

### Navigation

The index column of the case sheet. Ruled-band ground, `rule-2` right border, a masthead block at
the top (a bordered square `ScanLine` mark plus "OPD SCAN QC" in Archivo Narrow bold caps — the
neutral placeholder for the hospital's own logo, which is binding identity but has not been
supplied) and a signature block at the foot with a bordered square initials mark, the display name,
and the role in `.field-label`.

Items are 13px, 8px × 6px, with a 15px lucide mark always paired with its text label. **The active
item is filled** — chart blue ground, paper text, semibold — because an inked field is how a
printed form says "this one"; inactive items hover to the 7% chart wash. All transitions are 150ms
`ease-chart`. Role-gated items are hidden from the list, but the server remains the authority.

### Status Stamp (signature)

A bordered, letterspaced caps stamp carrying four things that all come from `lib/status.ts` and
never from a screen: a `tone`, a drawn lucide `icon`, a fixed `label`, and where two states share a
label, a short visible `qualifier` rendered beside it after a faint middot — rendered, not hidden in
a `title`, because a tooltip does not exist on the tablets this is used on. Tones map to
border at 50% / wash at 7% / text in full ink: `ok` → `band`, `warn` → `note`, `bad` → `plot`,
`info` → `chart`, `neutral` → pencil grey on ruled band with a `rule-2` border. A stamp whose
status carries `unmeasured` is hatched over its wash. Two sizes: 10px/`px-1` and 11px/`px-1.5`.

### Band Plot (signature)

The instrument the rest of the interface is built around. A bordered track on chart stock carrying
the printed 8px chart grid, 10px tall by default, with a filled portion in the tone's ink. Two
absences are distinguished: a value the API never supplied hatches the whole track, and a known
value that describes something never measured plots at its true width and is hatched *there*, with
a pencil-grey right edge, so the size of the gap stays readable without ever reading as a measured
result. Detents are 1px vertical marks overhanging the track by a pixel — `reference` (a value the
system was given) solid in writing ink, `ghost` (a threshold it has since moved away from) as a
broken 2px-on-2px rule in pencil grey, so history cannot be mistaken for a second live threshold.
No invented target band is ever shaded; a detent is drawn only from a value the API actually
supplied.

### Reading Row (signature)

A four-column grid — label, dotted leader, figure, band — at 13px with 8px × 6px padding, stacked
inside a flush panel with `divide-rule` hairlines between rows. The figure is `tabular-nums`
semibold, in writing ink, or pencil grey when the row is unmeasured. The dotted leader ties the
name to its figure the way a printed schedule does, so a number never strands itself across a wide
screen. When the row links to the filtered list that produced it, the whole row is a `Link` that
hovers to the 7% chart wash.

**The band expand** is the signature interaction: on hover or focus-within, a collapsing grid row
(`grid-rows-[0fr]` → `[1fr]`) opens in place over 150ms on `ease-chart` to read out what the
detents mean. It is animated as a grid row rather than a `hidden` toggle precisely because
`hidden` cannot transition. Non-linking rows are deliberately not focusable — the expandable rows
already contain their own control, so `group-focus-within` opens them from the keyboard without
adding a dozen non-actioning tab stops in front of the filters.

### Tables

`.table-base` is dense by intent. Sticky heads in pre-printed fill with a `rule-2` bottom border,
bottom-aligned `.field-label` cells at 10px × 6px. Body cells are 13px, top-aligned, 10px × 6px,
divided by `rule` hairlines. Even rows take the ruled-band tint; hover is the 7% chart wash; the
row currently open elsewhere on screen (`aria-current="true"`) holds the 12% chart wash.

### Feedback states

- **Spinner:** work in progress drawn as a value being plotted — a 80px × 8px bordered track with a
  hatched third sliding across it on `.trace` (1.4s, `cubic-bezier(0.45, 0, 0.55, 1)`, infinite),
  with a 13px pencil-grey label and `role="status"`. Under reduced motion the animation stops and
  the hatch fills the whole track, which is the honest still picture of a value that has not
  arrived.
- **ErrorState:** a `plot`-bordered block on the 7% `plot` wash, an Archivo Narrow caps heading in
  `plot` with a triangle mark, the message at 13px, and an optional secondary retry button.
- **EmptyState:** a dashed `rule-2` box on ruled-band ground, centred, 16px × 28px padding — an
  unfilled field, never an illustration, and never hatched.
- **MarginNote:** a note in the margin of the sheet — a left `rule-2` border, 10px inset, 12px
  pencil-grey text; `tone="warn"` adds the 7% `note` wash, ink text and an ochre triangle mark.
- **Toast:** bottom-right, up to 26rem, bordered at 50% of the tone's ink on its 7% wash with a
  drawn mark and a screen-reader-only tone prefix. Errors persist 9s, everything else 5s.
- **Modal:** a `.sheet` over a 60% writing-ink scrim with a 1px backdrop blur; head and foot are
  separated by `rule` borders at 16px padding.

### Named Rules

**The Single Moment Rule.** There is one authored motion in this application: `.trace`, the
loading indicator. Everything else that moves is a 150ms `ease-chart`
(`cubic-bezier(0.22, 0.61, 0.36, 1)`) colour transition or the band-expand grid-row collapse —
damped, single-axis, no overshoot, nothing self-animating. `prefers-reduced-motion` collapses every
animation and transition to 0.001ms and stops the trace.

**The One Wording Rule.** A screen never hand-writes a label for a status that has a canonical one.
`lib/status.ts` owns every label, tone, icon, qualifier and `unmeasured` flag, so a distinction that
matters can only be got wrong in one place.

## Do's and Don'ts

### Do:

- **Do** plot a figure against the band it was measured against. If a scale exists, the number does
  not appear alone.
- **Do** hatch anything whose status carries `unmeasured`, and pair the hatch with a text label —
  it is reinforcement, never the signal.
- **Do** take every status label, tone, icon and qualifier from `lib/status.ts`, and render a
  qualifier visibly beside the label rather than in a `title`.
- **Do** separate things with a rule (`rule` hairline, `rule-2` structural) or a change of stock
  tone (`paper` / `paper-2` / `paper-3`).
- **Do** set anything that names a box in Archivo Narrow 11px semibold uppercase at `0.08em` in
  pencil grey, and anything written in a box in Archivo 13px in writing ink.
- **Do** give every figure in a column `tabular-nums`.
- **Do** add new colour by adding a variable in `index.css` — both the light block and the
  `prefers-color-scheme: dark` block — so the set stays enumerable.
- **Do** keep the dense layout and let `pointer: coarse` pay for touch (40px minimum control
  height, 1.15rem checkboxes).

### Don't:

- **Don't** colour anything that is not a status. `band`, `note` and `plot` are verdict inks;
  `chart` is the one structural accent.
- **Don't** write a `dark:` variant. There are none in the application; flip the custom properties
  instead and every utility follows.
- **Don't** use `.hatch` as texture or `.chart-grid` as page decoration. The first means "never
  measured"; the second means "this region plots a value against a scale".
- **Don't** reach for a shadow or an elevation. Every shadow utility resolves to `none`.
- **Don't** exceed a 2px corner, and don't build a pill — `rounded-full` appears nowhere in the
  built application.
- **Don't** nest a `.sheet` inside a `.sheet`, or introduce a card.
- **Don't** hatch an empty result set. The query ran and returned nothing; that is a finding, and
  it gets the dashed empty field instead.
- **Don't** shade an invented target band or draw a detent from a value the API did not supply.
- **Don't** add a second moving part. `.trace` is the loading indicator and the only animation;
  everything else is 150ms `ease-chart`.
- **Don't** put meaning behind a hover-only tooltip — intake and ward staff work on touch devices
  where no tooltip exists.
- **Don't** invent a hospital name or logo. Identity surfaces carry the bordered `ScanLine`
  placeholder until the assets are supplied.
