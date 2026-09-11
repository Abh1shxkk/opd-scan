# OPD Scan QC — Project Context

A complete handoff document. Written to be self-contained: someone with no prior knowledge of this
codebase should be able to read this and understand what exists, what works, what does not, and
what is undecided.

Last updated: 2026-09-11

---

## 1. What this project is

A **scan quality-control and document-understanding system for a hospital's patient records**.

Paper patient records (case sheets, discharge summaries, handwritten prescriptions) are scanned or
photographed. This system:

1. takes the uploaded PDFs/images,
2. renders every page,
3. measures capture quality with computer vision (is this scan legible and archival-grade?),
4. reads the text with cloud OCR,
5. interprets handwritten prescriptions with an LLM,
6. and gives a reviewer a screen to accept, reject or correct each page.

The **core product value** is not CRUD. It is two things:
- a **calibrated CV quality engine** that decides whether a scan needs rescanning, tuned against
  real pilot pages from this hospital;
- a **two-stage AI pipeline** (read, then interpret) built with hard safety rules so it never
  invents medical data.

---

## 2. Tech stack

### Frontend
| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript 5.5 |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 |
| Server state | TanStack React Query v5 |
| Routing | React Router 6 |
| Icons | lucide-react |

No Redux/Zustand — React Query owns server state, `useState` owns local state.

### Backend
| Concern | Choice |
|---|---|
| Framework | FastAPI 0.115 + Uvicorn |
| Validation | Pydantic v2, pydantic-settings |
| ORM | SQLAlchemy 2.0 |
| Migrations | Alembic (3 revisions) |
| DB driver | psycopg 3 |
| Auth | PyJWT (HS256) + bcrypt (cost 12) |
| HTTP client | httpx |
| Logging / retries | structlog, tenacity |

### Data
| Concern | Choice |
|---|---|
| Production DB | **PostgreSQL 16** (22 tables) |
| Dev/test DB | SQLite (auto-switched in `app/db.py:15`, enables WAL + busy timeout) |
| Queue broker | Redis 7 |
| File storage | Local filesystem (Docker volume); S3 supported via boto3 |

Scanned files never go in the database — only their storage keys do.

### Image & document processing
| Library | Job |
|---|---|
| PyMuPDF | Rasterise PDF pages at 150 DPI |
| Pillow | Decode TIFF / PNG / JPEG / WebP |
| OpenCV (headless) + NumPy | All quality metrics |
| openpyxl, reportlab | Excel and PDF report exports |

### AI providers
| Stage | Provider | Purpose |
|---|---|---|
| **Read** | Google Document AI | OCR — handwriting and print to text |
| **Interpret** | Google Gemini 2.5 Flash | Prescription meaning (medicines, dose, frequency) |

Azure Document Intelligence and local Tesseract exist as alternative OCR providers behind the same
interface. Every provider can be set to `none`, and `ALLOW_CLOUD_PROCESSING=false` disables all
cloud calls — checked inside each provider, not just at the router, so nothing can leak past it.

---

## 3. Architecture

### Runtime (Docker Compose, 6 services + a one-shot migrator)

```
                      Internet :80
                           │
                    ┌──────▼──────┐
                    │  frontend   │  nginx: serves the SPA, proxies /api
                    └──────┬──────┘
                    ┌──────▼──────┐
                    │   backend   │  uvicorn (FastAPI)
                    └──┬───────┬──┘
            ┌──────────▼─┐   ┌─▼─────────┐
            │  postgres  │   │   redis   │
            └────────────┘   └─────┬─────┘
                             ┌─────▼─────┐  ┌────────┐
                             │  worker   │  │  beat  │   celery
                             └───────────┘  └────────┘
```

A one-shot `migrate` container runs `alembic upgrade head` before backend/worker/beat start. If a
migration fails it exits non-zero and those three never start — a failed migration is a refused
boot, not a half-migrated running system.

### How an upload flows

```
1. Browser uploads PDF            → React, XHR with progress
2. nginx → FastAPI                → validate type, size, page count, password-protection
3. Store original                 → filesystem/S3, keyed by SHA-256
4. Render page by page            → PyMuPDF generator (never all pages in memory at once)
5. Queue jobs                     → Redis → Celery worker
6. Per page, worker runs:
     OpenCV quality metrics       → thresholds → defect findings → page class
     Document AI OCR              → handwriting detection, diagnosis extraction
     Gemini (prescriptions only)  → medicine/dose interpretation
7. Results → Postgres             → frontend polls via React Query
```

**Exception:** the standalone prescription analyzer (`POST /prescriptions/analyze`) bypasses the
queue and runs everything synchronously in the request, so the user gets an answer immediately.

### Design principles actually enforced in the code

1. **Each stage has its own independent state.** Quality, handwriting, diagnosis and prescription
   each write their own row with their own status. A provider outage leaves the quality verdict
   intact and never becomes "no handwriting on this page".
2. **"Unconfigured" is never "nothing found".** A check that could not run says so.
3. **Nothing is invented.** Unreadable handwriting is reported as unreadable, never guessed.
4. **AI output is immutable.** Human corrections are appended as separate rows; the original
   reading is never overwritten.
5. **Providers are pluggable** behind interfaces, and cloud processing is opt-in and defaults off.

---

## 4. Data model (key tables)

```
Batch ──┬── Case ────── Document ── LogicalPage ── PageVersion ──┬── QualityResult ── QualityFinding
        │   (patient/     (a PDF)    ("page 7")   (a scan of it) ├── HandwritingResult ── Region
        │    admission)                                          ├── DiagnosisExtraction ── Review
        └── Document                                             ├── PrescriptionAnalysis ── Medicine
                                                                 └── PageReview
```

- **`Case`** = a patient/admission. `patient_ref` holds the **MR number**, `encounter_ref` the
  **IPD number**. Plus intake fields: patient name, department, mobile, disease, ICD code,
  consultant, discharge type, MLC type, admission/discharge dates.
- **`LogicalPage`** is the stable identity of "page 7 of this record". A rescan creates a new
  `PageVersion` on the same `LogicalPage`; only `is_active` versions count.
- **`PageVersion`** is what everything analytical hangs off.
- Supporting: `User`, `AuditEvent`, `Job`, `Setting`, `Checklist`/`ChecklistItem`/`CompletenessResult`.

Full enum list: `Role`, `IngestStatus`, `PageClass`, `Severity`, `HandwritingStatus`,
`HandwritingCategory`, `DiagnosisStatus`, `PrescriptionStatus`, `Qualifier`, `JobKind`, `JobState`,
`CaptureProfile`, `ColourMode`.

---

## 5. What works today

### ✅ Fully working

| Feature | Notes |
|---|---|
| **Auth + RBAC** | JWT, bcrypt, 3 roles (admin / reviewer / uploader). Role re-checked from DB every request. |
| **Bulk upload** | Batch → case → multi-file upload with progress. Rejects encrypted/corrupt/oversized files with a specific reason. |
| **Patient intake** *(new)* | One screen: patient details + PDFs in a single submit. MR-number lookup prefills from the last visit. |
| **Ingest pipeline** | PDF/TIFF/PNG/JPEG/WebP → per-page render, thumbnail, preview. Streams pages, does not load all at once. |
| **CV quality engine** | Blur, faint ink, darkness, low contrast, noise, skew, rotation, glare, shadow, cut-off, bitonal loss, low resolution, blank/near-blank. Produces a page class: acceptable / review / rescan / blank / failed. |
| **Handwriting detection** | Via Document AI. Reports regions, script hint, confidence. Never treated as a defect. |
| **Diagnosis extraction** | Reads the diagnosis label off the page; reviewer can correct it. |
| **Prescription understanding** | Two-stage OCR→Gemini. Medicines with dose/frequency/duration, per-medicine confidence, uncertainties, safety warnings, plain-language explanation, disclaimers. |
| **Standalone prescription analyzer** | Upload a prescription, get the reading back immediately (no batch/case needed). Own result page with page-thumbnail strip, image left, details right. |
| **Page viewer** | Zoom, rotate, overlays for defects/handwriting/diagnosis regions, server-rendered annotated view, version history. |
| **Review workflow** | Accept page, request rescan, add comment, correct a finding, correct a prescription reading. All appended as audit rows. |
| **Auto-tuning thresholds** *(new)* | After enough "this is not a defect" corrections, the CV threshold is automatically nudged — bounded step, hard floor/ceiling, minimum 5 samples, fully audited. |
| **Completeness checklists** | Per-case expected-document checklists with gap detection. |
| **Reports** | CSV, XLSX, PDF exports; rescan checklist PDF; flagged-pages ZIP. |
| **Dashboard** | Totals and breakdowns by quality class, handwriting, diagnosis status. |
| **Job system** | Idempotency keys, atomic claiming, bounded retries, stalled-job sweeper. |
| **Audit trail** | Every mutation recorded. Patient text structurally excluded from logs. |

### ⚠️ Known broken / incomplete

| Issue | Impact |
|---|---|
| **Settings → save thresholds is 100% broken** | Frontend sends `{thresholds:…}`, backend wants `values` → every request 422s. Admin cannot manually tune or revert thresholds — which matters because auto-tuning changes them. |
| **Retention only deletes originals** | `derivatives_days` is stored and shown in Settings but never read by any code. Renders, previews, thumbs and all extracted patient text are kept forever. |
| **Retention panel always shows nothing** | Field-name and nesting mismatch between frontend and backend. |
| **Diagnosis safety blocks never render** | Frontend renders `cleaning_applied`, `ambiguous_abbreviations`, `note`; backend's `DiagnosisOut` has none of them. |
| **Reviewer names show as raw UUIDs** | Backend sends `reviewer_email`/`reviewer_id`; frontend expects `reviewer_name`. |
| **Page images have no audit logging** | `/image`, `/preview`, `/thumb` are unlogged; only `/annotated` is logged. |
| **No location/tenancy scoping** | Any authenticated user of any role can read any patient's records. |

---

## 6. API surface

```
POST   /auth/login                     GET    /auth/me
GET    /auth/users                     POST   /auth/users        PATCH /auth/users/{id}

POST   /intake                         ← patient details + files, one submit
GET    /intake/lookup?mr_number=       GET    /intake/options

GET    /batches                        POST   /batches           GET   /batches/{id}
GET    /cases                          POST   /cases             PATCH /cases/{id}/confirm
GET    /cases/{id}/completeness         POST  /cases/{id}/completeness/recompute
POST   /documents/upload               GET    /documents         GET/DELETE /documents/{id}

GET    /pages                          GET    /pages/{id}
GET    /pages/{id}/image | /preview | /thumb | /annotated
POST   /pages/{id}/review | /replace | /reprocess

GET    /diagnoses/{id}                 POST   /diagnoses/{id}/review
POST   /prescriptions/analyze          GET    /prescriptions/recent   GET /prescriptions/{doc_id}

GET    /dashboard                      GET    /jobs              POST /jobs/{id}/cancel
GET/PUT /settings/thresholds           GET    /settings/capabilities | /settings/retention
GET    /reports/pages.csv | .xlsx | .pdf | rescan-checklist.pdf | flagged.zip
```

All prefixed with `/api`.

---

## 7. Frontend screens

| Route | Page | Role |
|---|---|---|
| `/login` | LoginPage | — |
| `/dashboard` | DashboardPage | any |
| `/documents` | DocumentsPage | any |
| `/pages/:pageVersionId` | PageViewerPage | any |
| `/review` | ReviewQueuePage | reviewer |
| `/diagnoses`, `/diagnoses/:id` | DiagnosisQueuePage, DiagnosisReviewPage | reviewer |
| `/intake` | **PatientIntakePage** *(new)* | uploader |
| `/upload` | UploadPage (bulk) | uploader |
| `/prescriptions`, `/prescriptions/:documentId` | PrescriptionAnalyzerPage, PrescriptionResultPage | uploader |
| `/reports` | ReportsPage | any |
| `/settings` | SettingsPage | admin |

---

## 8. Deployment

**Live:** `http://54.173.64.109` — AWS EC2, Ubuntu, **t3.small (2 vCPU, 1.9 GB RAM)**
**Repo:** `https://github.com/Abh1shxkk/opd-scan` (branch `main`)

### Deploy process
```bash
ssh -i <key>.pem ubuntu@54.173.64.109
cd ~/opd-scan && git pull origin main
docker compose up -d --build backend frontend worker
```

### Important deployment facts
- **A second, unrelated application (`e-Mulyankan`, PHP + MySQL) runs on the same box** at
  `/home/ubuntu/emulyankan`. It competes for port 80 — only one of the two can serve port 80 at a
  time. `emulyankan-web-1` is currently stopped so OPD Scan can use port 80.
- An **Adminer** container runs on `127.0.0.1:8081` (localhost only) for DB browsing via SSH tunnel.
- The live `docker-compose.yml` has **uncommitted local changes** (a bind mount for the Google
  Document AI credentials JSON), so a clean checkout will not reproduce this box.

### Tests
```bash
cd backend && ./.venv/Scripts/python.exe -m pytest tests/ -q   # 256 tests, all passing
cd frontend && npx tsc --noEmit                                # clean
```

---

## 9. Known issues from the security/infra audit

A five-dimension audit was run (auth, PHI/privacy, backend correctness, frontend contract,
deployment). Findings, most severe first:

### 🔴 Blockers before any real patient data
1. **No TLS.** Everything — login passwords, JWTs, patient scans — crosses the internet in
   cleartext. `docs/SECURITY.md` says a TLS proxy is required; it was never set up.
2. **No backups at all.** No cron, no snapshots, no `pg_dump`. Postgres data and all scans sit on
   one EBS volume. A disk failure or a stray `docker compose down -v` destroys everything.
3. **Secrets exposure.** `.env` was world-readable on the box; the Gemini API key was pasted into a
   chat during development and should be treated as compromised — **rotate it**.

### 🟠 Reliability
4. **The box already OOM-killed a Celery worker.** `WORKER_CONCURRENCY=4` needs ~2 GB by the
   project's own docs; the machine has 1.9 GB total and now runs two application stacks. No
   per-container memory limits are set anywhere.
5. **`POST /prescriptions/analyze` blocks its uvicorn worker.** It is `async def` but does blocking
   CPU work and a blocking `ThreadPoolExecutor.map()`, so that worker serves nothing else —
   including `/health` — for the duration (potentially minutes).
6. **PDF decompression bomb.** No per-page pixel-dimension cap; a crafted page can allocate ~2.7 GB.
7. Other: no page cap on the synchronous prescription route (500 pages allowed inline); no
   de-duplication on that route (double-click = duplicate paid LLM call); N+1 on `GET /documents`;
   DB pool not sized for the ThreadPoolExecutor pattern; no Docker log rotation.

### 🔵 Security hardening
8. `/api/docs` and `/api/openapi.json` are public and unauthenticated.
9. No login rate limiting or account lockout.
10. Logout is client-side only; JWTs stay valid for 12 hours and cannot be revoked.
11. No startup assertion that `SECRET_KEY` is not the shipped default.
12. `patient_ref` / `encounter_ref` are put in URL query strings (browser history, proxy logs).

### ⚠️ In recently added code specifically
13. **Prescription feedback loop leaks across patients.** Reviewer free-text correction notes are
    injected into future Gemini prompts for *other* patients. The only safeguard is a sentence in
    the UI asking reviewers not to type identifying details — there is **no server-side scrubbing**.
14. **Gemini uses the consumer API, not Vertex AI.** Document AI correctly uses an enterprise
    service account; Gemini is called via `generativelanguage.googleapis.com` with a bare API key —
    a different data-handling posture, and a real compliance gap for PHI.

---

## 10. Open work: integrating the legacy .NET system

There is an **existing in-house .NET application** (SQL Server) that does patient-record intake —
a form with patient details plus a PDF upload field. The intent is to move that functionality into
this Python system and eventually migrate the old data across.

**Done so far:** the intake form has been rebuilt in this app (`/intake`), matching the .NET form's
sections: Basic Information (date, uploader, MR number with lookup, IPD number), Patient Details
(name, department, mobile), Medical Information (disease, ICD code, consultant, discharge type, MLC
type), Admission Details (admission/discharge dates), Document Upload (multiple files).

**Data migration is deferred.** Five questions block it, and answers to the first four fall out of
running `ops/discovery.sql` against the legacy SQL Server:

1. **How is an uploaded file linked to a patient?** `FileDetails` has no `STID` while every other
   legacy table joins on it. Is `MatterID` the link, is it encoded in `FullPath`, or are files not
   linked to patients at all? **Most critical.**
2. **Password format in `Login.pass`** — plaintext / MD5 / SHA1 / bcrypt? Determines whether every
   user must reset their password.
3. **`StudyDateTime` is `nvarchar(255)`** — what formats, and how many rows are unparseable?
4. **Is `GeminiKey` per-user or effectively system-wide?** Affects schema design.
5. **Will the .NET app be retired or run alongside?** A business decision. If both stay live, the
   two databases will diverge unless one is declared the source of truth. **Shapes everything.**

Legacy schema summary (19 tables): `FileDetails`, `PatientDetails`, `Login`, `LoginRadiologix`,
`LoginDetails`, `LoginSession`, `UserProfileDetails`, `PLocations`, `LocationPermission`,
`menuStructure`, `menuPermission`, `OtpDetails`, `StudiesReport`, `StudyLog`, `TatDetails`,
`PrintReceiverDetails`, `ReportTemplates`, `RevertLogs`, `SAMPLE`.

Radiology reporting (`StudiesReport`, `ReportTemplates`, `TatDetails`, sign-off, print receivers) is
**explicitly out of scope** — that stays in .NET.

Note: the legacy `PLocations` + `LocationPermission` give the .NET app **location-based access
scoping that this Python app does not have**. Porting intake without porting that is a regression in
access control.

---

## 11. Key files

### Backend
```
app/main.py                          FastAPI app, router registration
app/config.py                        All settings (env-driven)
app/db.py                            Engine/session; SQLite-vs-Postgres switch
app/models/core.py                   Every ORM model and enum
app/schemas/api.py                   Every request/response shape
app/core/{security,rbac,audit,storage}.py
app/api/routes/{auth,records,intake,pages,diagnoses,prescriptions,dashboard,reports,admin}.py
app/services/pipeline.py             run_quality / run_handwriting / run_diagnosis / run_prescription
app/services/{ingest_service,jobs,completeness,reports,settings_store,threshold_autotune}.py
app/processing/ingest.py             Validation, rendering, thumbnails
app/processing/quality/metrics.py    All CV measurement  ← the calibrated core
app/processing/quality/rules.py      Thresholds → findings → page class
app/processing/providers/            base, router, google_docai, azure_di, gemini, local_tesseract
app/workers/{celery_app,tasks}.py
```

### Frontend
```
src/App.tsx                          Routes + role gating
src/lib/api.ts                       Every API call
src/lib/types.ts                     Every API type
src/lib/status.ts                    Single source of truth for status wording/colour
src/pages/*.tsx                      One file per screen
src/components/                      StatusPill, PageThumb, OverlayCanvas, Panel, ui.tsx, …
src/hooks/useAuthedObjectUrl.ts      Authenticated image loading
```

### Ops
```
docker-compose.yml                   The stack
frontend/nginx.conf                  SPA serving + /api proxy + timeouts
.env.example                         Every setting documented
ops/discovery.sql                    Read-only queries for the legacy SQL Server
docs/{SECURITY,DEPLOYMENT,API,EVALUATION,ONPREM}.md
```

---

## 12. Access

**Live:** http://54.173.64.109
**Test login:** `admin@local.test` / `OpdTest@2026` (test-only — change before real data)

**Database (via SSH tunnel + Adminer):**
```bash
ssh -i <key>.pem -L 8081:localhost:8081 ubuntu@54.173.64.109
# then open http://localhost:8081
# System: PostgreSQL · Server: postgres · User: opd · Database: opd
# password: grep POSTGRES_PASSWORD ~/opd-scan/.env  (on the server)
```

---

## 13. Suggested next steps

**Before real patient data (non-negotiable):**
1. Enable EBS snapshots — right now a single disk failure loses everything.
2. Put TLS in front (Caddy is ~10 minutes).
3. Rotate the Gemini key; `chmod 600 ~/opd-scan/.env`.

**Then, in rough priority:**
4. Fix the broken threshold-save endpoint (auto-tuning currently has no manual override).
5. Add server-side scrubbing to the prescription feedback loop, or drop the cross-patient prompt
   injection entirely.
6. Set container memory limits; drop `WORKER_CONCURRENCY` to 1-2; resolve the two-apps-one-box
   situation.
7. Make `/prescriptions/analyze` non-blocking and cap its page count.
8. Fix the remaining frontend/backend contract mismatches (retention panel, diagnosis safety
   fields, reviewer names).
9. Implement retention for derivatives and extracted text.
10. Answer the five legacy-migration questions and plan the data migration.
