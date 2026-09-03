# Setup

Getting OPD Scan QC running, from a laptop to a configured deployment.

Read the [status table in the README](../README.md#status) first. Parts of the
backend are not yet written — the HTTP layer, the Celery application and the
Alembic migration in particular — so a fresh clone will not start end to end
today. Everything below is still the correct procedure, and the calibration
route works now.

---

## 1. Prerequisites

### With Docker (recommended)

| Requirement | Version | Notes |
|---|---|---|
| Docker Engine | 24+ | Compose v2 is required for `condition: service_healthy` |
| Docker Compose | v2.20+ | `docker compose version` |
| Disk | 20 GB free to begin | See the sizing note below |
| RAM | 8 GB minimum, 16 GB comfortable | The quality engine holds whole page images in memory |

### Without Docker

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.12 | 3.11 works; the images are built on 3.12 |
| Node.js | 20 or 22 | `npm ci` needs the committed `package-lock.json` |
| PostgreSQL | 16 | 15 is fine |
| Redis | 7 | Celery broker and result backend |
| Tesseract | 5.x with `eng` and `hin` | Only for the local OCR provider |
| Poppler / system image libraries | — | Supplied through `pymupdf` and `opencv-python-headless` wheels; no separate install needed on Linux or macOS |

Installing Tesseract and its language data:

```bash
# Debian / Ubuntu
sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin

# macOS
brew install tesseract tesseract-lang

# check
tesseract --list-langs        # must include eng and hin
```

The OpenCV quality engine needs none of this. It runs from the Python wheels
alone, with no binary dependency, no credentials and no network.

### Storage sizing

At 150 DPI a rendered A4 page is roughly 1–3 MB, plus a preview and a
thumbnail. The originals dominate: the customer's sample case files are 10–25 MB
for 27–35 pages. As a working figure, budget **8–15 MB per page** for originals
plus derivatives, and confirm against your own first batch. At 1,000 pages a day
that is roughly 250–450 GB a year before retention deletion. See
[DEPLOYMENT.md](DEPLOYMENT.md).

---

## 2. The quickest possible trial — no Docker, no Postgres, no Redis

Enough to upload a real file and watch every page be analysed. It uses SQLite and runs the
background jobs on a thread inside the API process (`JOB_EXECUTION=inline`), so there is nothing
else to install or start. It is for pilots and demonstrations, not for a ward.

```bash
cd opd
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

cat > backend/.env <<'EOF'
ENVIRONMENT=dev
SECRET_KEY=change-me-any-long-random-string
DATABASE_URL=sqlite:///./var/trial.db
STORAGE_BACKEND=local
STORAGE_ROOT=./var/trial-storage
JOB_EXECUTION=inline
ALLOW_CLOUD_PROCESSING=false
CORS_ORIGINS=http://localhost:5173
EOF

cd backend
mkdir -p var
.venv/bin/alembic upgrade head
.venv/bin/python -m tools.seed --email you@hospital.example
.venv/bin/uvicorn app.main:app --port 8000     # leave running
```

In a second terminal:

```bash
cd opd/frontend
npm install
npm run dev            # http://localhost:5173
```

Sign in with the account you just created, make a batch, and upload a file. Pages appear as the
inline worker gets to them — roughly a second each on a laptop; a 30-page file finishes in under a
minute. Nothing is sent to any cloud service: the OpenCV quality engine runs locally, and
handwriting and diagnosis report **"unconfigured"** until you add provider credentials (§5).

To do the same without the browser, straight over the pipeline:

```bash
.venv/bin/python -m tools.run_local /path/to/your/scans --batch "Trial" --csv out.csv
```

---

## 2b. Local development against Postgres and Redis

```bash
git clone <this repository>
cd opd

cp .env.example .env
```

Edit `.env`:

```ini
ENVIRONMENT=dev
SECRET_KEY=<paste the output of the command below>
DATABASE_URL=postgresql+psycopg://opd:opd@localhost:5432/opd
REDIS_URL=redis://localhost:6379/0
STORAGE_BACKEND=local
STORAGE_ROOT=./var/storage
CORS_ORIGINS=http://localhost:5173
```

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Create the database and start Redis:

```bash
createdb opd
psql -c "CREATE USER opd WITH PASSWORD 'opd'; GRANT ALL ON DATABASE opd TO opd;"
redis-server &
```

Install and run:

```bash
make install          # backend/.venv + npm ci
make migrate          # apply the schema
make seed             # create the first admin user

make dev-backend      # terminal 1 — http://localhost:8000
make dev-frontend     # terminal 2 — http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:8000`, so use
<http://localhost:5173> and not the backend port directly. Sign in with the
account `make seed` created.

Sanity checks:

```bash
curl -s localhost:8000/api/health
curl -s localhost:8000/api/settings/capabilities | python -m json.tool
```

---

## 3. With Docker

```bash
cp .env.example .env
```

Set at least these two:

```ini
SECRET_KEY=<48+ random characters>
POSTGRES_PASSWORD=<a real password>
```

`DATABASE_URL` and `REDIS_URL` are overridden inside compose to point at the
service names, so the same `.env` works for both a laptop run and a compose run.
Keep `POSTGRES_PASSWORD` and the password inside `DATABASE_URL` in step.

```bash
make up              # build and start everything
make logs            # follow until each service is healthy
```

| Service | Image | Purpose | Published |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | Record of truth | no |
| `redis` | `redis:7-alpine` | Celery broker and results | no |
| `backend` | built from `backend/Dockerfile` | FastAPI under uvicorn | `127.0.0.1:8000` |
| `worker` | same image | Celery worker | no |
| `beat` | same image | Celery beat — stalled-job sweeper, retention sweeps | no |
| `frontend` | built from `frontend/Dockerfile` | nginx: SPA + `/api` proxy | `:8080` |

Application: <http://localhost:8080>. The backend is also bound to loopback so
you can query `/api/settings/capabilities` directly.

Then run the migration and create the admin user inside the container:

```bash
docker compose exec backend alembic upgrade head
docker compose exec -it backend python -m tools.seed
```

### Stopping and removing

```bash
make down                      # stops containers, KEEPS the volumes
docker compose down -v         # also DELETES the database and every stored scan
```

`docker compose down -v` is irreversible and destroys patient data. It is
deliberately not a Make target.

---

## 4. Creating the first admin user

The database starts empty, so nobody can sign in until you create the first
account. There is no default password anywhere in this codebase.

**With Docker**, `make bootstrap` does the whole thing — build, start, migrate,
then prompt for the admin password:

```bash
make bootstrap                                   # admin@hospital.local
make bootstrap ADMIN_EMAIL=you@hospital.example  # or choose the address
```

To add or reset an admin later, against an already-running stack:

```bash
make admin ADMIN_EMAIL=you@hospital.example
```

**Without Docker**, once `make migrate` has created the schema:

```bash
cd backend && .venv/bin/python -m tools.seed --email you@hospital.example
```

The tool prompts for the password (minimum eight characters) and hashes it with
bcrypt. Passing `--password` on the command line works too, but it puts the
password in your shell history. `--demo-users` additionally creates an uploader
and a reviewer account for walking through the workflow; it refuses to run when
`ENVIRONMENT=prod`.

Afterwards:

1. Sign in as that account.
2. Create the real working accounts through **Settings → Users**, giving each
   person the narrowest role that lets them do their job — `uploader` for the
   scanning clerks, `reviewer` for the records officers who confirm findings and
   diagnoses. See [SECURITY.md](SECURITY.md#roles).
3. Do not share the admin account. Every action is attributed to the account
   that performed it, and a shared login makes the audit trail useless.

---

## 5. Obtaining provider credentials

**Neither provider is required.** With none configured, upload, the entire
OpenCV quality engine, the review workflow and every report work exactly as
designed. Handwriting and diagnosis are then reported as `unconfigured` — which
means *not checked*, not *nothing there*.

Configuring a cloud provider means page images leave your network. Do not do it
without the data-protection assessment described in
[SECURITY.md](SECURITY.md#cloud-processing-is-a-deployment-decision).

### 5a. Google Document AI — Enterprise Document OCR

Gives image-quality scores (`qualityScore` plus eight defect types), printed
English and printed Hindi, and handwritten English. It does **not** list
handwriting support for Hindi.

1. **Create or choose a project** in the [Google Cloud console](https://console.cloud.google.com/).
   Note the **project ID** (not the display name) → `GOOGLE_PROJECT_ID`.
2. **Enable billing** on the project. The free allowance is 1,000 pages a month;
   without billing enabled, the API refuses even inside it.
3. **Enable the API**: *APIs & Services → Enable APIs → Cloud Document AI API*.
4. **Choose a location before creating anything.** Document AI processors live
   in a multi-region — `us`, `eu` or `asia1` — and **the location cannot be
   changed after the processor is created**. Pick the one that satisfies your
   data-residency obligation. → `GOOGLE_LOCATION`
5. **Create the processor**: *Document AI → Processor Gallery →
   **Enterprise Document OCR** → Create*. Pick the region from step 4. Copy the
   processor **ID** from the processor's detail page (a hex string, not the
   display name) → `GOOGLE_PROCESSOR_ID`.
6. **Create a service account**: *IAM & Admin → Service Accounts → Create*.
   Grant it exactly one role: **Document AI API User**
   (`roles/documentai.apiUser`). Do not grant Editor or Owner.
7. **Create a JSON key** for that service account and download it. This file is
   a credential equivalent to a password.
8. **Mount the key read-only** and point the setting at the path *inside the
   container*:

   ```yaml
   # docker-compose.override.yml
   services:
     backend: &google-key
       volumes:
         - /etc/opd/google-docai.json:/run/secrets/google-docai.json:ro
     worker: *google-key
     beat: *google-key
   ```

   ```ini
   GOOGLE_CREDENTIALS_JSON=/run/secrets/google-docai.json
   ```

   Never bake the key into an image and never commit it. `.gitignore` and
   `.dockerignore` both exclude `*credentials*.json` and `*service-account*.json`,
   but that is a safety net, not a policy.
9. Enable the capability:

   ```ini
   ALLOW_CLOUD_PROCESSING=true
   OCR_PROVIDER=google_docai
   GOOGLE_ENABLE_QUALITY_SCORES=true
   HANDWRITING_PROVIDER=google_docai     # Latin-script handwriting only
   DIAGNOSIS_PROVIDER=google_docai
   ```

**Pricing, from Google's published list prices (September 2026):** first 1,000
pages per month free; **$1.50 per 1,000 pages** up to 5 million pages per month;
**$0.60 per 1,000 pages** beyond 5 million; add-on processors **$6.00 per use**;
failed requests are not billed. At roughly 1,000 pages a day (≈30,000 a month)
that is approximately **$45 a month** for OCR — an estimate from list prices,
excluding storage, egress and support, and not a quote. Confirm the current
figures before budgeting.

### 5b. Azure AI Document Intelligence — prebuilt-read

The reason to configure Azure is **handwritten Hindi**, which its Read model
lists as supported and Google's language table does not. It has no equivalent of
Google's image-quality scores, which does not matter: quality analysis is done
locally for every page regardless of provider.

1. **Create the resource** in the [Azure portal](https://portal.azure.com/):
   *Create a resource → AI + Machine Learning → **Document Intelligence***.
   Choose the region deliberately — it determines where pages are processed.
2. Pick a pricing tier. F0 (free) is rate-limited and page-limited; S0 is the
   standard paid tier.
3. Once deployed, open **Keys and Endpoint**:
   - *Endpoint* → `AZURE_DI_ENDPOINT`
     (e.g. `https://<resource-name>.cognitiveservices.azure.com`)
   - *KEY 1* → `AZURE_DI_KEY`
4. Enable the capability:

   ```ini
   ALLOW_CLOUD_PROCESSING=true
   HANDWRITING_DEVANAGARI_PROVIDER=azure_di
   # optionally, to route all handwriting and/or all OCR to Azure:
   # HANDWRITING_PROVIDER=azure_di
   # OCR_PROVIDER=azure_di
   ```
5. Rotate the key on a schedule. Azure issues two keys precisely so you can
   swap one while the other is live.

**Pricing:** Azure bills per 1,000 pages in tiers, with a small free monthly
allowance. **No per-page figure is given here — confirm the exact rate in the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) for
your chosen region**, because it varies by region and tier and changes.

For an air-gapped site, Azure also offers Document Intelligence as a
**disconnected container** under annual commitment tiers. That is the only
supported route to handwritten Hindi with no internet connection — see
[ONPREM.md](ONPREM.md#the-one-offline-route-to-handwritten-hindi).

### 5c. Local Tesseract

Already installed in the backend image with `eng` and `hin` traineddata.

```ini
OCR_PROVIDER=local_tesseract
```

**Printed text only.** Tesseract is not a handwriting engine, and the provider
declares no handwriting languages at all, so the router will not send handwriting
work to it under any configuration. A deployment with Tesseract as its only
provider reports handwriting as `unconfigured`.

### 5d. A recommended combination

For a hospital that accepts cloud processing and needs handwritten Hindi:

```ini
ALLOW_CLOUD_PROCESSING=true
OCR_PROVIDER=google_docai               # quality scores + printed multilingual
HANDWRITING_PROVIDER=google_docai       # Latin-script handwriting
HANDWRITING_DEVANAGARI_PROVIDER=azure_di   # the Hindi progress notes
DIAGNOSIS_PROVIDER=google_docai
```

The router sends a page whose hints carry `hi:handwritten` to Azure and
everything else to Google. If Azure is left at `none`, those pages are recorded
as *unsupported* rather than as having no handwriting.

---

## 6. Verifying provider health

`GET /api/settings/capabilities` is the single source of truth for what is
actually working. It is also the Settings screen in the UI.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
     localhost:8000/api/settings/capabilities | python -m json.tool
```

```jsonc
{
  "local_quality_engine":      { "status": "ready",        "provider": "opencv" },
  "ocr":                       { "status": "unconfigured", "provider": null,
                                 "setup_required": "No provider selected for 'ocr'." },
  "quality_provider_signals":  { "status": "unconfigured", "provider": null },
  "handwriting":               { "status": "unconfigured", "provider": null },
  "handwriting_devanagari":    { "status": "unconfigured", "provider": null },
  "diagnosis":                 { "status": "unconfigured", "provider": null }
}
```

| Capability | Meaning |
|---|---|
| `local_quality_engine` | The OpenCV engine. Always `ready`; it has no credentials to be missing |
| `ocr` | General OCR, from `OCR_PROVIDER` |
| `quality_provider_signals` | Whether a provider is contributing its own defect list — Google only |
| `handwriting` | Handwriting detection and localisation |
| `handwriting_devanagari` | The Hindi-handwriting route specifically |
| `diagnosis` | Diagnosis extraction |

`setup_required` carries the reason a capability is not ready, and it is
specific. Common ones:

| `setup_required` | Fix |
|---|---|
| `No provider selected for '<capability>'.` | Set the matching `*_PROVIDER` variable |
| `ALLOW_CLOUD_PROCESSING is false` | The credentials are fine; the master switch is off |
| `GOOGLE_PROJECT_ID / GOOGLE_PROCESSOR_ID / GOOGLE_CREDENTIALS_JSON not set` | One of the three is missing |
| `AZURE_DI_ENDPOINT / AZURE_DI_KEY not set` | One of the two is missing |
| `tesseract binary not found` | Tesseract is not on `PATH` in that container |
| `No usable Tesseract language data installed` | `tesseract-ocr-eng` (and `-hin`) is missing |

A capability that shows `"reachable": false` is configured but the credential
exchange failed — a key file that is not readable, a wrong project, an expired
key. The reason is deliberately reported as an exception type only: provider
error bodies can echo document content, so they are never logged or surfaced.

**Check the worker as well as the API.** They are separate containers, and a key
mounted into only one of them will make the Settings screen look healthy while
every job fails:

```bash
docker compose exec worker python -c \
  "from app.processing.providers import router; import json; print(json.dumps(router.health(), indent=2))"
```

---

## 7. Calibrating against your own scans

**The default thresholds were tuned by eye against 95 pages from three customer
files. They are a starting point, not a validated configuration.** Your
scanners, lighting and paper differ. Calibrate before you trust any
classification, and before you tell a scanning team to rescan anything.

The calibration tool runs the local engine only. It opens no database and calls
no provider, so it is safe to run on real scans on an unconnected machine.

### Run it

```bash
make calibrate SAMPLES=/path/to/a/folder/of/scans
# or directly, with more control:
cd backend && .venv/bin/python -m tools.calibrate /path/to/scans --dpi 150 --csv ../calibration.csv
```

Use **at least 100 pages**, and choose them to include the awkward cases, not
the tidy ones: photographed spreads as well as flatbed sheets, a rotated page,
a bitonal page, a faint pencil page, a blank page.

Each row gives the classification and the measurements behind it:

```
IP140922101.pdf            p13     rescan  0.25   photo  colour ink  2.14%
                                            ct   31 sh 0.098 lum  142 nz  4.2 sk +0.8 faint,blur
```

| Column | Meaning | Threshold it drives |
|---|---|---|
| `class` | `acceptable` / `review` / `rescan` / `blank` / `failed` | `review_severity_score`, `rescan_severity_score` |
| `profile` | `flatbed` / `photo` / `unknown` | — |
| `colour` | `colour` / `grey` / `bitonal` | `bitonal_loss` is raised for bitonal pages |
| `ink%`, `textink%` | Proportion of the sheet carrying ink | `blank_ink_coverage`, `near_blank_ink_coverage` |
| `contrast` | Ink-to-paper separation in grey levels | `faint_*`, `low_contrast_ink_paper` |
| `sharp` | Stroke sharpness, resolution-independent | `sharpness_min`, `sharpness_severe` |
| `luma` | Median luminance out of 255 | `dark_median_luma`, `dark_severe_median_luma` |
| `noise` | Noise sigma | `noise_sigma`, `noise_sigma_severe` |
| `skew`, `rot` | Skew in degrees; detected rotation | `skew_deg`, `rotation_confident` |
| `texth` | Estimated character height in pixels | `min_text_height_px` |
| `secs` | Seconds for that page | Feeds worker sizing — see [DEPLOYMENT.md](DEPLOYMENT.md) |

### Read the summary, then look at the pages

The tool prints class and defect counts at the end. Open the actual images for a
sample of each outcome. You are looking for two failures:

- **False rescans.** A page the engine flagged that a person can read perfectly
  well. Every one of these costs the scanning team a wasted trip to the ward.
- **Missed bad pages.** A page classed `acceptable` that a person cannot read.
  These are far more expensive: the file is signed off and the paper may be gone.

### Adjust the thresholds

Every number lives in `DEFAULT_THRESHOLDS` in
`backend/app/processing/quality/rules.py`, and every one can be overridden at
runtime through **Settings → Thresholds** (`PUT /api/settings/thresholds`,
admin only) without touching the image-processing code. Change them there, not
in the source, so the change is audited and the engine version stays meaningful.

Common adjustments:

| Symptom | Threshold | Direction |
|---|---|---|
| Too many pages flagged `blur` | `sharpness_min` | **Lower** (e.g. 0.115 → 0.095) |
| Blurred pages passing as acceptable | `sharpness_min` | Raise |
| Clean sparse forms flagged `faint` | `faint_ink_paper_contrast` | Lower |
| Faint pencil passing as acceptable | `faint_ink_paper_contrast` | Raise |
| Legitimately sparse pages called `blank` | `blank_ink_coverage` | Lower |
| Camera pages flagged `dark` en masse | `dark_median_luma` | Lower, and fix the lighting |
| Upright ruled forms flagged `rotated` | `rotation_confident` | Raise, or configure an OCR provider — it reads the glyphs and settles the question |
| Too much reaching the review queue overall | `review_severity_score` | Raise (2.5 → 3.5) |
| Too much auto-classified `rescan` | `rescan_severity_score` | Raise (6.0 → 8.0) |

Two rules cannot be tuned away, by design:

- a page that could not be measured is `failed`, never `acceptable`;
- a single **high**-severity legibility defect — blur, faint, dark, unreadable
  region or rotated — forces `rescan` whatever the total score.

Re-run `make calibrate` after each change. When you are satisfied, record the
thresholds you settled on and the sample you validated against; the
`thresholds_hash` stored on every quality result ties a verdict back to the
configuration that produced it.

### Sizing check

`make bench SAMPLES=/path/to/scans` prints per-page seconds for the local engine
on your hardware. Multiply by your daily page count to size the worker pool —
[DEPLOYMENT.md](DEPLOYMENT.md#sizing) works through this.

---

## 8. Common problems

| Symptom | Cause and fix |
|---|---|
| `env file /home/.../.env not found` on `make up` | You have not copied `.env.example` to `.env` |
| `set POSTGRES_PASSWORD in .env` | The compose file requires it; there is no default password on purpose |
| Backend restarts continuously | `docker compose logs backend`. Usually a wrong `DATABASE_URL`, or the HTTP layer not being present in this tree |
| Frontend loads, every API call returns 502 | The backend container is not healthy yet; nginx proxies to it regardless. `make logs` |
| All capabilities `unconfigured` with credentials set | `ALLOW_CLOUD_PROCESSING` is still `false` |
| Settings screen healthy, every job fails | The credential is mounted into `backend` but not into `worker` and `beat` |
| Hindi pages OCR as nonsense | `tesseract --list-langs` inside the container; `hin` is missing, or the page is handwritten, which Tesseract cannot read at all |
| Handwriting shows as `unconfigured` everywhere | Expected with no handwriting provider. It means *not checked*, not *none present* |
| Handwritten Hindi shows as unsupported | Google does not list handwriting support for Hindi. Set `HANDWRITING_DEVANAGARI_PROVIDER=azure_di` |
| Uploads rejected at a certain size | `MAX_UPLOAD_MB`; nginx does not cap uploads, the backend does |
| Quality analysis slow | `RENDER_DPI` is the dominant cost. 150 is the tested value; 300 is roughly four times the work |
