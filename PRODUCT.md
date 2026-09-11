# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Four groups inside one hospital's medical-records operation. All four were confirmed as real,
daily or near-daily audiences — this is not a single-persona tool.

- **Records-room scanning team.** Digitising paper case files in bulk: upload, watch the quality
  verdict come back, pull and rescan whatever is flagged. High volume, repetitive, long shifts.
  Their job is throughput, and the screen they live in is the upload → flagged-pages loop.
- **QC reviewers.** Work the review queue: judge whether a page is acceptable, correct a
  transcribed diagnosis, correct a prescription reading. Accuracy over speed. They compare a page
  image against a machine reading, so image and reading must be legible side by side.
- **Front-desk / ward intake staff.** Fill the patient intake form at admission or discharge,
  frequently with a patient waiting. Interruptible, time-pressured, low tolerance for a form that
  loses its state.
- **Admins / MRD heads.** Oversight rather than production: dashboard, reports, thresholds, user
  management. Occasional visits, not a daily shift.

Roles in the system are `admin`, `reviewer`, `uploader`; the four audiences above do not map one to
one onto those three (intake staff and the scanning team share `uploader`).

**Devices:** mostly fixed desktop workstations, with tablets also in use — reported for intake and
ward situations. Every screen must hold up at tablet width with touch-sized targets. Phone support
was not claimed as a requirement.

## Product Purpose

Paper patient records — case sheets, discharge summaries, handwritten prescriptions — are scanned
or photographed. This system decides whether each scan is actually good enough to be the permanent
archival copy, and reads what is on it so a human can check the reading.

It does two things that are the actual product:

1. **A calibrated CV quality engine** that measures every rendered page (sharpness, ink-to-paper
   separation, exposure, noise, skew, orientation, glare, shadow, bit depth, text height, edge
   cut-off) and classifies it `acceptable` / `review` / `rescan` / `blank` / `failed` / `unchecked`,
   with a plain-English reason and a region for each finding.
2. **A two-stage AI pipeline** — read (OCR), then interpret (LLM) — built so it never invents
   medical data.

Success is a records team that stops discovering unreadable scans months later, and a reviewer who
can trust that anything the machine reported as read was either confirmed or corrected by a person.

## Positioning

It is a **checking tool for a scanning workflow, not a clinical tool** — and the refusals are the
position, not a disclaimer:

- It transcribes a diagnosis a clinician has already written on the page. It never produces one.
- It never infers a diagnosis from symptoms, observations, medicines or investigations.
- It never adds, looks up, completes or validates an ICD code — a code is recorded only when it is
  written on the page, character for character.
- It has no outbound EMR/HIS integration and pushes nothing into a clinical record system.

What a neighbouring product could not truthfully copy: the quality thresholds are **calibrated
against real pilot pages from this hospital**, and they **retune themselves** from reviewer
corrections (bounded step, hard floor and ceiling, minimum sample count, fully audited). The
verdict gets more right about this hospital's scanners the more it is used.

## Operating Context

- **The work is a loop, not a transaction.** Upload → machine verdict → pull the flagged pages →
  rescan → the rescan attaches to the same logical page as a new version rather than creating a
  duplicate. Version 1 is never overwritten.
- **Each analysis stage carries its own independent state.** Quality, handwriting, diagnosis and
  prescription each write their own row with their own status. A provider outage leaves the quality
  verdict intact and must never render as "no handwriting on this page".
- **"Unconfigured" is never "nothing found."** A check that could not run says so, in the UI.
- **AI output is immutable.** Human corrections are appended as separate rows beside the original
  machine reading; the original is always still visible.
- **Every mutation is audited.** Patient text is structurally excluded from logs.
- **Cloud processing is opt-in and defaults off.** Every provider can be set to `none`, and a
  single flag disables all cloud calls — enforced inside each provider, not just at the router.
- **Colour scheme follows the operating system by default**, because clinical workstations are
  configured centrally. It is a default rather than a rule: a reader can choose light or dark
  explicitly, and that choice is remembered on that machine. Requested by the user after first
  use — the original "no override" reading was inferred from a code comment, not confirmed.
- One screen (the standalone prescription analyzer) deliberately bypasses the queue and answers
  synchronously, so the user waits in-request rather than polling.

## Capabilities and Constraints

**Confirmed, working today:** auth with three roles; bulk upload with per-file rejection reasons;
single-submit patient intake with MR-number lookup that prefills from the last visit; per-page
render/thumbnail/preview; the CV quality engine; handwriting region detection; diagnosis
transcription with qualifier preserved (final, provisional, suspected, differential, ruled out,
negated, past history); prescription interpretation with per-medicine confidence, uncertainties and
safety warnings; a page viewer with zoom, rotate and defect/handwriting/diagnosis overlays plus
version history; the review workflow (accept, request rescan, comment, correct a finding, correct a
reading); per-case completeness checklists; CSV/XLSX/PDF reports, a rescan checklist and a
flagged-pages ZIP; a dashboard of totals and breakdowns.

**Terminology that must stay exact in the UI:** *case* = a patient/admission (`patient_ref` is the
MR number, `encounter_ref` the IPD number); *logical page* = the stable identity of "page 7 of this
record"; *page version* = one scan of it. The six page classes and the qualifier list above are
fixed vocabulary, not labels to be reworded for style.

**Contract bugs, now fixed and verified against the running API** (recorded because the principle
survives the fix: a screen that looks finished while silently failing is worse than one that looks
unfinished). Saving thresholds 422'd on every request — the body key is `values`, the client sent
`thresholds`. The retention panel read field names the API never sent. Three diagnosis safety blocks
never rendered: the extractor produced `note`, `cleaning_applied` and `ambiguous_abbreviations` and
the pipeline persisted them inside `region_json`, but nothing lifted them back out. Reviewer names
displayed as raw UUIDs.

**Still open, and not a UI defect:** no endpoint persists `ThresholdAutotuneChange`, so the history
of an auto-tuned threshold cannot be shown on load. The interface draws the mark; it needs a backend
that stores the history. Left visibly unbuilt rather than given an invented one.

**Access-control constraint:** there is currently **no location or tenancy scoping** — any
authenticated user of any role can read any patient's records. The legacy .NET system it is intended
to succeed *does* have location-based scoping, so shipping intake parity without it is a known
regression. Not yet resolved.

**Undecided / deferred, must not be invented:** whether the legacy .NET application is retired or
runs alongside this one (a business decision that shapes everything downstream); how a legacy
uploaded file links to a patient; four further legacy-migration questions. Data migration is
deferred, not designed.

## Brand Commitments

- Product name in use: **OPD Scan QC**.
- **A specific hospital's name and logo are a binding part of the identity.** The name and the asset
  files have **not been supplied yet** — *open decision*. They must not be invented, guessed from
  the codebase, or filled with a plausible-sounding hospital name. Until the user provides them, the
  identity surfaces (login, header/sidebar mark) carry a neutral placeholder.
- No confirmed voice, colour, typography or visual-asset commitments were given. Voice in the
  existing copy is plain, precise and non-alarming ("Needs review", "Ask an administrator if you
  need it") — recorded as observed, not as a binding rule.

## Evidence on Hand

- **A real running deployment** with a working login, so screens can be observed rather than
  imagined.
- **The codebase as evidence:** every API call in `frontend/src/lib/api.ts`, every response shape in
  `frontend/src/lib/types.ts`, status wording and colour centralised in `frontend/src/lib/status.ts`.
- **Written documentation:** `README.md`, `docs/PROJECT_CONTEXT.md` (a self-contained handoff),
  `docs/{API,SECURITY,SETUP,DEPLOYMENT,EVALUATION,ONPREM}.md`, and `ops/discovery.sql`.
- **Test coverage:** 256 backend tests passing; the frontend typechecks clean.
- **Absent — do not fabricate:** the hospital's name, logo or brand assets; any customer,
  testimonial, benchmark, accuracy figure, pricing, licensing or certification claim. The `samples/`
  directory is empty, so there is no bundled example scan to show.

## Product Principles

1. **The verdict must be explainable, not just stated.** Every quality classification carries a
   reason and, where meaningful, the region on the page that caused it. A bare status badge is an
   incomplete answer.
2. **Never let absence look like a finding.** Unconfigured, not-yet-run, failed, and
   genuinely-nothing-found are four different states and must never collapse into one another
   visually.
3. **The machine reading and the human correction both stay visible.** Corrections append; they do
   not overwrite. Any screen that shows only the current value is hiding half the record.
4. **Refusals are features.** Where the system declines to diagnose, infer, or complete an ICD code,
   that boundary is stated in the interface rather than hidden.
5. **Throughput for the scanning team, precision for the reviewer.** The same screen rarely serves
   both; design for the specific job rather than an average user.

## Accessibility & Inclusion

No external standard was named by the user, but the codebase has already committed to a floor that
future work must hold:

- **Status colour is never the sole carrier of meaning** — every status colour is paired with a text
  label.
- **Icons are decorative and always paired with a text label**; nothing depends on recognising a
  glyph.
- Status shades are chosen for **≥4.5:1 contrast** against their own background, in both schemes.
- A **skip link** to main content, and a visible focus indicator on every interactive element.
- **`prefers-reduced-motion` is respected.**
- **Light and dark both ship**, driven by the OS setting.
- Handwriting script hints cover **Latin, Devanagari and mixed**, so the content itself is
  multi-script; UI text is English only, and no i18n requirement was established.
