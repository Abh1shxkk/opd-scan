# OPD Scan QC — Issue Register

Every known problem in one place, with a fix order. Working document: update status as items land.

**Sources:** the five-dimension security/infra audit, a four-dimension deep scan (workflow
dead-ends, API contract re-verification, UI/dead-code, test coverage), live testing against the
deployed system, and the legacy-migration schema discovery.

**Legend** — 🔴 open · 🟡 in progress · ✅ fixed
**Baseline** — 267 backend tests passing · `tsc --noEmit` clean · production build clean

Last updated: 2026-09-14

---

## ✅ Already fixed since the first audit

The codebase moved on while the audit was being written. Re-verified as **fixed**, do not re-report:

- Saving quality thresholds — `api.ts` now sends `{values:…}`, matching `ThresholdsIn`.
- Retention panel field mapping — frontend and backend agree on `originals_days` / `limits`.
- Reviewer names in diagnosis review — `reviewer_name` is now sent and rendered.
- `duplicate` upload status — own wording, own count, no longer read as "Queued"/"accepted".
- The design-system refactor is **complete**: `StatTile.tsx` is gone, one `Panel` in `Sheet.tsx`,
  zero raw-palette classes left (one leak remains, item 12).
- No orphaned components, no unrouted pages, no dead exports.
- Accessibility verified genuinely solid: modal focus trap + restore, toasts in a permanent
  `aria-live` region, every input labelled via `useId`, every `<img>` has meaningful alt.
- Double-submit is guarded on both upload paths — the duplicate-patient-record risk is not present.

---

## P0 — Infrastructure. Nothing else matters if the data is lost or read in transit

| # | Issue | Status |
|---|---|---|
| 1 | **No TLS.** Passwords, JWTs and patient scans cross the internet in cleartext. `docs/SECURITY.md:105` says a TLS proxy is required; it was never set up. Verified live: only `:80` listens. | 🔴 |
| 2 | **No backups of OPD data.** `crontab` is empty. `~/backups/` contains only MariaDB dumps of `emulyankan_db` — a different application. OPD's Postgres has never been backed up. It is **65 MB**, so a nightly `pg_dump` is nearly free. | 🔴 |
| 3 | **Gemini API key is compromised** (pasted into a chat) and `.env` is still `-rw-rw-r--`, readable by any local account alongside the DB password and JWT signing key. | 🔴 |
| 4 | **Disk filling.** 7.4 GB free of 24 GB, down from 17 GB. Cause found: **5.4 GB Docker build cache (3.8 GB reclaimable)** plus 777 MB of stale images. One `docker builder prune` reclaims ~4.5 GB without touching anything running. | 🔴 |
| 5 | **Admin password is in this repo** (`docs/PROJECT_CONTEXT.md`) and pushed to a public GitHub remote. Acceptable for the current dummy data; must change before real data. | 🔴 |

---

## P1 — Features that exist but do nothing

| # | Issue | Status |
|---|---|---|
| 6 | **Completeness checklists are structurally inert.** Full backend CRUD exists; there is no admin UI, and `createCase` never passes `checklist_id`, so no case can ever be linked to a checklist. Every `CompletenessPanel` therefore shows "not verified" permanently — gap detection can never fire. | 🔴 |
| 7 | **Diagnosis corrections never reach the in-app views.** A reviewer's correction is persisted and appears in report exports and in that diagnosis's own review history — but `PageViewerPage` and the diagnosis queue keep rendering the uncorrected AI text (`d.cleaned_text \|\| d.raw_text`). Someone reading the case in-app cannot tell a correction exists. Clinically the wrong default. | 🔴 |
| 8 | **The rescan loop dead-ends.** `POST /pages/{id}/replace` is fully implemented — new active version, old one kept in history, pipeline re-run — and is wired to no button. There is also no screen listing pages awaiting rescan. request → rescan → replace → re-verify cannot be completed in the product. | 🔴 |
| 9 | **No jobs screen.** The dashboard shows "Jobs failed: N" with no link, no list, no retry, no cancel — while `GET /jobs` and `POST /jobs/{id}/cancel` both exist. | 🔴 |
| 10 | **No user-management UI.** An admin cannot create a user, change a role, or deactivate an account anywhere in the product, though `/auth/users` GET/POST/PATCH all exist and have client wrappers. | 🔴 |
| 11 | **Retention is read-only in the UI.** `PUT /retention` exists; there is no client wrapper and no editable control. | 🔴 |

---

## P2 — Visible defects

| # | Issue | Status |
|---|---|---|
| 12 | **Dark-mode contrast bug.** `SettingsPage.tsx:324` uses `bg-white/70` — the one raw-palette class left after the refactor. It stays literally white in dark mode while `text-ink` flips light, leaving near-invisible text on the "Setup required" note. | 🔴 |
| 13 | **Version history always shows "— · —".** `PageVersionRef` is missing `colour_mode`, `capture_profile`, `dpi_estimate` and `page_class` — the frontend renders all four, the backend sends none. Degrades silently instead of crashing, which is why it went unnoticed. | 🔴 |
| 14 | **The same diagnosis looks different on two screens.** `GET /diagnoses/{id}` returns `cleaning_applied` / `ambiguous_abbreviations` / `note`; the diagnoses embedded in `GET /pages/{id}` do not (`pages.py:260-280` never sets them). Safety warnings appear in the queue and vanish in the page viewer. | 🔴 |
| 15 | **"Accepted" and "Rescan required" shown together with no explanation.** Live test confirms accepting *works* — `review_state` flips, the page leaves the queue — and `page_class` correctly stays as the engine's permanent verdict. But the review queue shows both pills bare, so it reads as a contradiction. Raised three times by the user: a UI defect, not a misunderstanding. | 🔴 |
| 16 | **Object URL leak.** `PrescriptionAnalyzerPage` has no `useEffect` cleanup, so the preview blob for every analysed file leaks for the session. `hooks/useAuthedObjectUrl.ts` already implements the correct pattern. | 🔴 |
| 17 | **Medicine-confidence badge breaks the project's own accessibility rule.** `lib/status.ts` requires every status to pair colour with a label *and* a glyph; this badge has colour + label only, and is copy-pasted in two files instead of going through `StatusPill`. | 🔴 |
| 18 | File-picker list keys on filename alone (`PatientIntakePage.tsx:302`) — collides on `IMG_0001.jpg` style duplicates within one multi-select. | 🔴 |

---

## P3 — Latent contract bugs (no symptom yet, will bite the next person)

| # | Issue |
|---|---|
| 19 | `replacePage` is typed as returning `PageDetail`; it actually returns `{page_version_id, version_no}`. **Blocks item 8** — must be fixed before wiring the replace UI. |
| 20 | `PageDetail.reviews` still omits `payload` and `page_version_id`. Any future use (e.g. showing what a `correct_finding` actually changed) reads `undefined`. |
| 21 | `UserOut` has no `created_at`, which the frontend `User` type requires. Bites whoever builds item 10. |
| 22 | `getDocument`'s embedded `pages` are not `PageSummary` shaped. Currently unread — `ReviewDocumentPage` fetches pages separately — so it is a landmine, not a live bug. |
| 23 | `BatchOut` omits `created_by`, which the frontend type declares. No consumer. |

---

## P4 — Reliability and capacity

| # | Issue |
|---|---|
| 24 | **The box has already OOM-killed a Celery worker.** `WORKER_CONCURRENCY=4` needs ~2 GB by the project's own docs; the machine has 1.9 GB total and runs **two** application stacks. No per-container memory limits anywhere. |
| 25 | **`POST /prescriptions/analyze` blocks its uvicorn worker.** `async def` doing blocking CPU work and a blocking `ThreadPoolExecutor.map()` — that worker serves nothing else, not even `/health`, for potentially minutes. |
| 26 | **PDF decompression bomb.** No per-page pixel cap; a crafted page can allocate ~2.7 GB. |
| 27 | **Two applications compete for port 80.** `e-Mulyankan` shares the box; only one can serve :80. Currently "resolved" by leaving the other stopped. |
| 28 | No page cap on the synchronous prescription route (500 allowed inline); no de-duplication there (double-click = duplicate paid LLM call); N+1 on `GET /documents`; DB pool not sized for the ThreadPoolExecutor pattern; no Docker log rotation. |
| 29 | Unbounded polling: `PatientsPage`/`PatientDetailPage` poll every 4s with no cap or backoff. Bounded in the normal case (stops when work finishes), but a permanently stalled job polls forever in every open tab. |

---

## P5 — Security hardening

| # | Issue |
|---|---|
| 30 | `/api/docs` and `/api/openapi.json` are public and unauthenticated on a PHI system. |
| 31 | No login rate limiting or account lockout. |
| 32 | Logout is client-side only; JWTs stay valid 12 hours and cannot be revoked. |
| 33 | No startup assertion that `SECRET_KEY` is not the shipped default. |
| 34 | `patient_ref` / `encounter_ref` go into URL query strings → browser history, proxy logs. |
| 35 | **No location/tenancy scoping.** Any authenticated user reads any patient's record. The legacy system *does* scope by Center → College → Department, so migrating without this is a regression in access control. |
| 36 | **Retention deletes only originals.** Renders, previews, thumbnails and all extracted patient text are kept forever; `derivatives_days` is read by no code. The setting is a false assurance. |

---

## P6 — Problems in recently added code

| # | Issue |
|---|---|
| 37 | **Prescription feedback loop leaks across patients.** Reviewer free-text notes are injected into future Gemini prompts for other patients, guarded only by a sentence in the UI. No server-side scrubbing, no length cap, no redaction — **and no test pins the invariant**, so a future edit passing corrected medicine data instead of the comment would fail silently. |
| 38 | **Gemini uses the consumer API, not Vertex AI.** Document AI correctly uses an enterprise service account; Gemini goes to `generativelanguage.googleapis.com` with a bare key — a different data-handling posture and a real compliance gap for PHI. |
| 39 | **`Case.encounter_ref` would merge ~830 legacy records.** It falls back to MR when IPD is blank, and 64% of legacy files have no IPD; 166,225 entries share only 165,395 distinct MRs. Repeat visits would collapse into one case and lose their admission data. Must key on the legacy entry id. |
| 40 | **IPD is modelled on the wrong entity** — source has `Files.IPDNo` (per file); it was put on the Case. |
| 41 | Intake hardcodes the department list and treats ICD code as free text; the legacy DB has `Department` (128 rows) and `ICD_Code` (65,883 rows) as master tables. |

---

## P7 — Test coverage: where the 267 passing tests give false confidence

| # | Gap |
|---|---|
| 42 | **The cross-patient prescription leak has zero tests.** The docstring asserts a privacy invariant nothing verifies. |
| 43 | **`apply_retention` has zero tests** — an irreversible-deletion path with no coverage of cutoff maths, which key is deleted, or that DB rows survive. |
| 44 | **Auto-tuning is barely tested.** Only `SKEWED`/`higher_bad` within bounds; 7 of 8 tunable codes and the entire `lower_bad` direction are unexercised, and **nothing re-runs classification at a tuned bound** to prove a genuinely bad scan is still caught. |
| 45 | **XLSX / PDF / rescan-checklist / ZIP exports are entirely untested** (~700 of 922 lines in `reports.py`). Only CSV has coverage. The module's stated "never a silent truncation" guarantee is unverified. |
| 46 | `set_thresholds` validation untested; the existing test asserts status codes only and would pass if the function were a no-op. |
| 47 | **The whole suite runs on SQLite** while production is Postgres — native ENUM behaviour, autoflush and real concurrent locking are untestable as configured. No Postgres CI run exists. |
| 48 | **The frontend has no test framework at all** — no vitest/jest/testing-library, no test script. Every contract bug in P2/P3 would have been caught by one component test. |

---

## Fix order

Each phase is independently shippable. Ordered by risk retired per hour spent.

**Phase A — infrastructure, no code.** Items 1-5. Backups first: until they exist, every other fix
is one disk failure from irrelevant. `docker builder prune` is a one-command 4.5 GB win. Then TLS,
then rotate the key and `chmod 600 .env`.

**Phase B — quick correctness wins.** Items 12, 16, 17, 18, 19 — small, self-contained, and item 19
unblocks Phase C.

**Phase C — close the rescan loop.** Items 8, 15, 13 — a Replace action, a screen for pages
awaiting rescan, and wording that stops "Accepted + Rescan required" reading as a contradiction.
This is the workflow the user actually hit.

**Phase D — make recorded work visible.** Items 7 and 14: a correction that nobody can see is
worse than no correction, because it looks like nothing was done.

**Phase E — the missing admin surfaces.** Items 9, 10, 11, 6. Jobs, Users, Retention, Checklists —
all backend-complete, all needing only UI.

**Phase F — the feedback loop and the LLM posture.** Items 37, 38, plus test 42. Both concern
patient data leaving the building in ways that were never properly bounded.

**Phase G — capacity.** Items 24-29. Memory limits and `WORKER_CONCURRENCY` first (cheap, stops
the OOM), then the blocking prescription route, then the two-apps-one-box decision.

**Phase H — hardening, retention and tests.** Items 30-36 and 43-48. Item 35 (tenancy scoping) is
the largest here and is a prerequisite for the migration.

**Phase I — migration.** Items 39-41 plus the four unanswered blockers (file location, login field,
retire-vs-coexist, cutover plan). Items 39 and 40 are schema changes that must land *before* any
data moves, or records are lost in the move.
