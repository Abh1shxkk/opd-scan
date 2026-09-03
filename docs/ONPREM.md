# On-premises deployment

Running OPD Scan QC with no page ever leaving the hospital network.

This is the default posture, not a special mode: `ALLOW_CLOUD_PROCESSING` is
`false` until someone deliberately changes it, and while it is false both cloud
providers refuse to run and report themselves as unconfigured even when valid
credentials are present.

What follows is an honest account of what you get and what you give up.

---

## 1. Summary

| Capability | Offline | Notes |
|---|---|---|
| Upload, validation, page identity, versioning | **Full** | No network involved |
| Rasterisation and rendering | **Full** | PyMuPDF, local |
| **The entire OpenCV quality engine** | **Full** | All 14 defect types, all thresholds, all regions. Identical to a cloud deployment |
| Review workflow — accept, request rescan, correct a finding, comment | **Full** | |
| Page replacement and re-versioning | **Full** | |
| Completeness checklists | **Full** | |
| Dashboard, filters, exports (CSV, XLSX, PDF, rescan checklist, flagged ZIP) | **Full** | |
| Annotated overlays | **Full** | |
| Audit trail, RBAC, retention settings | **Full** | |
| **Printed-text OCR** | **Degraded** | Tesseract, English and Hindi. Lower quality than either cloud provider |
| Provider-side image-quality scores | **Unavailable** | Google-only feature. The local engine covers this ground independently |
| **Handwriting detection and localisation** | **Unavailable** | Reported as `unconfigured` |
| **Handwritten-Hindi transcription** | **Unavailable** | Unless a licensed Azure disconnected container is deployed — §5 |
| Diagnosis extraction | **Unavailable** | Reported as `unconfigured`. The diagnoses in these case files are nearly always handwritten |

The most important line in that table is the second-to-last one, and §4 explains
exactly how the system behaves about it.

---

## 2. What works fully offline

### The quality engine — the whole thing

`backend/app/processing/quality/` runs on the original render of every page with
**no credentials and no network call**, in every configuration. The offline
deployment loses nothing here.

That matters because it is where the value is. From the sample analysis in
[PLAN.md](PLAN.md):

> the largest quality win here is not better OCR, it is flagging the
> *photographed, curled, bitonally-crushed and rotated* pages for rescan.

All fourteen defect classes are available offline:

| | | |
|---|---|---|
| `blur` — out of focus | `faint` — ink barely separated from paper | `dark` — under-exposed |
| `low_contrast` | `noise` — speckled | `rotated` — 90°/270° |
| `skewed` | `glare` — blown highlights | `shadow` across the sheet |
| `unreadable_region` | `suspected_cutoff` at an edge | `bitonal_loss` — saved 1-bit, mid-tones gone |
| `low_resolution` — text too small | `near_blank` | |

So does everything built on them: severities, per-finding regions, the
`acceptable / review / rescan / blank / failed` classification, the two
structural rules (an unmeasurable page is `failed`, never `acceptable`; a single
high-severity legibility defect forces `rescan`), and the whole review workflow.

Threshold calibration also works offline. `make calibrate` and `make bench` open
no database and call no provider, so they can be run against real scans on a
completely disconnected machine — see [SETUP.md](SETUP.md#7-calibrating-against-your-own-scans).

### The rest of the application

Upload and validation, page identity and versioning, rescan replacement,
completeness checklists, the dashboard, all five report formats, annotated
overlays, RBAC, the audit trail and the retention settings are all local. None
of them changes behaviour when the network is cut.

---

## 3. What is degraded: printed-only OCR

Setting `OCR_PROVIDER=local_tesseract` gives printed-text OCR with the `eng` and
`hin` traineddata already installed in the backend image.

| | |
|---|---|
| Printed English | Yes |
| Printed Hindi (Devanagari) | Yes |
| **Handwriting of any kind** | **No** |
| Image-quality scores | No — the local engine covers this |
| Accuracy against Google or Azure | Lower. **Not measured here; no figure is stated** |

Tesseract is a printed-text engine. The provider therefore declares **no
handwriting languages at all**, so the router will not route handwriting work to
it under any configuration. This is deliberate: a printed-text engine run over
handwriting produces confident-looking nonsense, and confident nonsense in a
patient record is worse than an honest gap.

Where local OCR still earns its place:

- reading the printed page numbers in parentheses — `(4)`, `(5)`, `(14)` — that
  the forms carry, which feeds sequence-gap detection for completeness;
- reading printed form headers, so a page can be identified as an *Admission
  Notification Slip* or an *ENT Examination* sheet;
- **settling orientation.** The local engine cannot reliably separate a
  genuinely sideways page from an upright page carrying tall ruled columns, and
  says so. An OCR provider reads the glyphs and can, so configuring Tesseract
  reduces false `rotated` findings even with no cloud service.

Verify the language data:

```bash
docker compose exec backend tesseract --list-langs      # must list eng and hin
```

---

## 4. What is unavailable, and how the system says so

### The behaviour that matters

> **With no provider configured, handwriting and diagnosis results are reported
> as `unconfigured`. They are never reported as "none found".**

This is enforced in the data model and in the pipeline, not left to the user
interface:

- `handwriting_results.status` is one of `detected | none_detected | failed |
  unconfigured`. The `unconfigured` value exists precisely so that "we did not
  look" is a different state from "we looked and found nothing".
- `diagnosis_extractions.status` likewise distinguishes `unconfigured` from
  `not_found`.
- With no handwriting provider, `run_handwriting()` writes:

  > *"No handwriting provider is configured. Set HANDWRITING_PROVIDER (and
  > HANDWRITING_DEVANAGARI_PROVIDER for Hindi) to enable handwriting detection.
  > Until then handwriting is UNKNOWN for this page, not absent."*

- With no diagnosis provider, `run_diagnosis()` writes:

  > *"No diagnosis provider is configured. Set DIAGNOSIS_PROVIDER to enable
  > extraction. No conclusion is drawn about whether this page carries a
  > diagnosis."*

- The API contract requires that a `failed` or `unconfigured` status is rendered
  as **"not checked"**, never as "no handwriting".
- The dashboard counts `unconfigured` in its own bucket. It is never rolled into
  `none_detected`, just as `blank`, `failed` and `unchecked` are never rolled
  into `acceptable`.
- The router refuses to substitute. If handwritten Devanagari is needed and no
  configured provider documents that capability, the page is recorded as
  unsupported — not as clean.

**Tell your reviewers this before go-live.** An offline deployment produces a
column full of "not checked", and a reviewer who reads that as "no handwriting
here" will draw exactly the wrong conclusion from a case file whose progress
notes are entirely handwritten.

### Why handwritten Hindi is the hard case

The sample files carry handwritten Devanagari progress notes, and the diagnoses
themselves are nearly always handwritten. Of the two cloud providers:

- **Google Document AI** supports printed Hindi but **does not list handwriting
  support for Hindi**. The provider therefore declares Latin-script handwriting
  only and raises `ProviderUnsupported` for handwritten Devanagari rather than
  returning a confident wrong answer.
- **Azure AI Document Intelligence (Read)** does list Hindi under its
  handwritten-supported languages, which is the entire reason it exists in this
  system alongside Google.

There is no offline handwriting engine in this image. Tesseract cannot do it,
and the OpenCV engine measures legibility rather than reading text.

---

## 5. The one offline route to handwritten Hindi

Azure offers Document Intelligence as a **disconnected container** — an image
that runs inside your network and does not call Azure at run time. It is
licensed under **annual commitment tiers** and is requested through Microsoft,
not enabled from the portal.

| | |
|---|---|
| What it gives you | Handwritten Hindi and handwritten English transcription, entirely inside your network |
| Commercial model | Annual commitment tier, purchased in advance for a page allowance |
| How to obtain | Apply to Microsoft for disconnected-container access for Document Intelligence; the request names the model and the tier |
| Availability | Not every model or region is offered disconnected. **Confirm with Microsoft for `prebuilt-read` before planning around it** |
| Where the page goes | Nowhere. The container processes locally and reports usage against the commitment |

If your site needs handwritten Hindi and cannot send pages to a cloud service,
this is the route. Budget for it as an annual line item and start the
conversation with Microsoft early — the licensing step is not instant.

**This system does not currently ship an adapter for the disconnected container
endpoint.** The Azure provider talks to the standard cloud endpoint. Integrating
a disconnected container means pointing `AZURE_DI_ENDPOINT` at the container's
local address and confirming that its API surface and version match — which is a
piece of work to scope, not a setting to flip.

---

## 6. Running it

```bash
cp .env.example .env
```

Set at least:

```ini
SECRET_KEY=<48+ random characters>
POSTGRES_PASSWORD=<a real password>
MINIO_ROOT_USER=<a user name>
MINIO_ROOT_PASSWORD=<at least 8 characters>
```

Then:

```bash
make up ONPREM=1
# equivalently
docker compose -f docker-compose.yml -f docker-compose.onprem.yml up -d --build
```

### What the overlay changes

| Setting | Value | Why |
|---|---|---|
| `ALLOW_CLOUD_PROCESSING` | `false` | The master switch. Both cloud providers refuse to run |
| `OCR_PROVIDER` | `local_tesseract` | Printed English and printed Hindi, locally |
| `HANDWRITING_PROVIDER` | `none` | No offline handwriting engine exists in this image |
| `HANDWRITING_DEVANAGARI_PROVIDER` | `none` | ditto |
| `DIAGNOSIS_PROVIDER` | `none` | ditto |
| `STORAGE_BACKEND` | `s3` | Pointed at MinIO |
| `S3_ENDPOINT_URL` | `http://minio:9000` | Internal to the compose network |
| `S3_SERVER_SIDE_ENCRYPTION` | `AES256` | MinIO encrypts objects at rest |
| `LOG_PATIENT_TEXT` | `false` | |
| `ALLOW_TRAINING_USE` | `false` | |

It also adds two services:

- **`minio`** — the private, S3-compatible object store. Not published to the
  host except for the console on `127.0.0.1:9001`, so an administrator can
  inspect the bucket over an SSH tunnel without exposing it to the ward network.
- **`minio-init`** — a one-shot job that creates the bucket, sets anonymous
  access to `none` and enables versioning, then exits. `docker compose ps`
  showing it as `exited` is the correct outcome.

Setting a cloud provider while `ALLOW_CLOUD_PROCESSING` is false has no effect.
The provider still refuses. There is no configuration in which credentials alone
are enough.

### Verify

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
     localhost:8000/api/settings/capabilities | python -m json.tool
```

Expect, and check that you get, exactly this shape:

```jsonc
{
  "local_quality_engine":     { "status": "ready",        "provider": "opencv" },
  "ocr":                      { "status": "ready",        "provider": "local_tesseract" },
  "quality_provider_signals": { "status": "ready",        "provider": "local_tesseract" },
  "handwriting":              { "status": "unconfigured", "provider": null },
  "handwriting_devanagari":   { "status": "unconfigured", "provider": null },
  "diagnosis":                { "status": "unconfigured", "provider": null }
}
```

`quality_provider_signals` reading `ready` here means an OCR provider is
configured, not that it contributes defect scores — Tesseract has none. The
local engine is the source of every quality finding in this deployment, which is
also true in a cloud deployment.

---

## 7. Air-gapped installation

For a site with no internet access at all:

1. **Build the images on a connected machine** and export them:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.onprem.yml build
   docker save \
     opd-scan-qc/backend:local opd-scan-qc/frontend:local \
     postgres:16-alpine redis:7-alpine \
     minio/minio:RELEASE.2025-04-22T22-12-26Z \
     minio/mc:RELEASE.2025-04-16T18-13-26Z \
     -o opd-images.tar
   ```

2. **Transfer** `opd-images.tar`, the repository and your `.env` on removable
   media, under your normal media-handling policy.

3. **Load and start** on the target:

   ```bash
   docker load -i opd-images.tar
   docker compose -f docker-compose.yml -f docker-compose.onprem.yml up -d --no-build
   ```

The backend image already contains Tesseract with `eng` and `hin` traineddata,
so nothing further is fetched at run time. Confirm with `tesseract --list-langs`
inside the container before signing off the installation.

Updates follow the same route: build, export, transfer, load. There is no
mechanism in the stack that reaches out for anything, which is the property you
are buying.

---

## 8. Choosing

| If the hospital… | Then |
|---|---|
| cannot send patient images outside its network | Run offline. Accept that handwriting and diagnosis read `unconfigured`, and make sure reviewers understand what that means |
| needs handwritten Hindi and cannot use a cloud service | Budget for an Azure disconnected container, and scope the adapter work in §5 |
| can send images to a cloud provider after a data-protection assessment | Configure Google for quality scores and printed OCR, Azure for handwritten Devanagari. See [SETUP.md](SETUP.md#5d-a-recommended-combination) |
| is unsure | **Start offline.** The quality engine is the largest part of the value and is unaffected. Handwriting and diagnosis can be enabled later without reprocessing anything you do not choose to reprocess |

The offline deployment is not a crippled version of the product. It is the whole
scan-quality system with the transcription features honestly switched off — and
it says so on every page it did not check.
