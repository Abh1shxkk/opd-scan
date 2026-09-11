---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: ["frontend/src/index.css","frontend/tailwind.config.js","frontend/src/components","frontend/src/pages"]
---

# Surface brief — OPD Scan QC application shell and all thirteen screens

## Scope

The whole authenticated application: shell, navigation, and every route — dashboard, documents,
page viewer, review queue, diagnosis queue and review, patient intake, bulk upload, prescription
analyzer and result, reports, settings, login. A replacement visual world, not a refinement.

**Visitor mode:** Operate. Expression may never obscure the task, state, or a familiar affordance.

## Audience and job

Four audiences, one system: the records-room scanning team (throughput, the upload → flagged-pages
loop), QC reviewers (precision, image beside machine reading), front-desk/ward intake staff
(interruptible, patient waiting, tablet in play), admins/MRD heads (oversight). Desktop
workstations primarily; must hold at tablet width with touch-sized targets.

**Confirmed in the ask round:** dense everywhere — today's information-per-screen is kept and the
craft is what changes. The careful distinctions ("blank and failed are never folded into
acceptable", the overlap panel, "not checked does not mean no handwriting") keep their meaning but
stop being paragraphs: they become structure, marks, and on-demand detail. Ambition lands on every
screen, not a hero subset.

## Direction contract

**THESIS:** The interface is the ward chart this hospital already runs on, made into an instrument:
every value is plotted against its shaded acceptable band and never stated as a bare number. It
refuses the admin-console arrangement the reference screenshots show — a figure floating in a soft
rounded card with a coloured delta and nothing said about what it was measured against.

**OWN-WORLD:** Chart stock ground, printed chart grid at one device pixel, two inks — chart blue
for structure, plotting red for out-of-band — plus a graphite hatch that is the only way "not
measured" is ever drawn. Boxed fields, 2px maximum radius, small-caps letterspaced field labels,
tabular lining numerals throughout, double rule under section heads, stamped verdict marks. No
shadows, no gradients, no pill cards, no sparklines, no percentage deltas.

**STORY:** The user understands every figure is a reading against a stated band, believes the
machine reports what it does not know, and acts — accept, correct, or send for rescan — from the
row they are already reading.

**FIRST VIEWPORT:** A chart head spanning full width: hospital placeholder mark left, identification
block right (view, active filters, generated-at, active page-version count) set as chart header
fields in two ruled rows, closed by a double rule. Beneath it no stat-tile row — one continuous
ruled readings table, each quality class a row plotted against its shaded acceptable band, value in
tabular numerals at the left, plot to the right, out-of-band struck in plotting red, and the "never
measured" row always present and hatched even at zero. The primary action sits at each row's right
as a stamped verdict control.

**SIGNATURE INTERACTION:** Band expand — focusing a reading opens its shaded band in place to show
the current threshold as a detent and, where auto-tuning has moved it, the previous threshold as a
ghost detent carrying its sample count. Motion grammar: damped single axis, 120–180ms, no
overshoot, nothing self-animating; reduced-motion collapses every transition to instant.

**FORM:** The Case Sheet — candidate 1 of the ordered grounded list, taken by the user as
IMPECCABLE'S PICK over assigned index 7 (Certificate of Calibration); seed key b1a941a6.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance.

### Raises carried onto this direction

Four rolled directions lost on both axes; each donated one system discipline, and all four bind
here:

- **from the four-shade field** — the ink set is strictly enumerated; any tone beyond it is a
  printed texture, never a new hue, so status colour cannot drift.
- **from the depth-ranked queue** — one declared severity number per item drives every visual
  property of its state, from a single token rather than per-component tones.
- **from the cyclorama cue states** — every state is named, labelled, pattern-bearing and
  deep-linkable; no in-between or implied states exist in the system.
- **from the orizuru fold sequence** — earlier readings stay legible as accumulated marks on the
  current record rather than exiled to a separate history log.

## The direction's own risk, to be beaten in the build

The Case Sheet is the literal reading of the subject and therefore the most familiar answer
available. It fails if it lands as the existing form with better type. It succeeds only if the
chart grammar is genuinely systematic — the band-and-plot row, the hatch, the stamp, and the
enumerated ink set applied to every screen including settings, reports and intake.

## Constraints that outrank the world

- Fixed vocabulary, not rewordable for style: *case*, *logical page*, *page version*, the six page
  classes, the qualifier list.
- Colour never the sole carrier of meaning; icons always paired with a text label; ≥4.5:1 on status
  text; skip link; visible focus on every interactive element; `prefers-reduced-motion` respected.
- Light and dark both ship, driven by the OS setting. No in-app theme toggle — clinical
  workstations are centrally configured.
- Unconfigured, not-yet-run, failed, and nothing-found are four distinct states and must never
  collapse visually.
- Nothing may be made to look finished that is actually broken: threshold save, retention panel,
  diagnosis safety fields, and reviewer names are known contract bugs.

## Unresolved

- The hospital's name and logo are binding but not yet supplied; identity surfaces carry a neutral
  placeholder until they arrive.
- Whether the legacy .NET app is retired or runs alongside.
