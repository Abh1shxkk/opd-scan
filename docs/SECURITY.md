# Security and privacy

This system holds scanned patient records. Everything below is a property the
code is built to have, or a configuration decision someone must make
deliberately. Where a control is not yet implemented, it says so.

---

## 1. Roles

Three roles, defined in `backend/app/models/core.py` and enforced in
`backend/app/core/rbac.py`. **Admin implies the other two.**

| Role | Intended holder | Purpose |
|---|---|---|
| `uploader` | Scanning clerk | Puts scans into the system and replaces the ones that come back flagged |
| `reviewer` | Records officer | Decides whether a page is acceptable, and confirms or corrects extracted diagnoses |
| `admin` | Records manager / systems administrator | Everything, plus user management, checklists and thresholds |

### What each may do

| Action | Route | uploader | reviewer | admin |
|---|---|:---:|:---:|:---:|
| Sign in, see own account | `GET /auth/me` | ● | ● | ● |
| Create, list, modify users | `/auth/users` | — | — | ● |
| Create a batch | `POST /batches` | ● | — | ● |
| Create a case | `POST /cases` | ● | — | ● |
| Confirm the patient/encounter reference | `PATCH /cases/{id}/confirm` | ● | — | ● |
| Upload documents | `POST /documents/upload` | ● | — | ● |
| Delete a document (soft, audited) | `DELETE /documents/{id}` | — | — | ● |
| Browse batches, cases, documents, pages | `GET` on those | ● | ● | ● |
| **View a page image, preview, thumbnail or annotated render** | `GET /pages/{id}/image` etc. | ● | ● | ● |
| Accept a page / request a rescan / correct a finding | `POST /pages/{id}/review` | — | ● | ● |
| Replace a page with a rescan | `POST /pages/{id}/replace` | ● | — | ● |
| Re-queue processing for a page | `POST /pages/{id}/reprocess` | ● | — | ● |
| **Confirm, correct or reject an extracted diagnosis** | `POST /diagnoses/{id}/review` | — | ● | ● |
| Recompute completeness for a case | `POST /cases/{id}/completeness/recompute` | ● | — | ● |
| Manage checklists | `/checklists` | — | — | ● |
| Cancel a job | `POST /jobs/{id}/cancel` | ● | — | ● |
| Read provider readiness | `GET /settings/capabilities` | ● | ● | ● |
| **Change quality thresholds** | `PUT /settings/thresholds` | — | — | ● |

Two separations are deliberate and should not be collapsed:

- **An uploader cannot accept a page.** The person who produced a scan does not
  get to certify it. Only a reviewer or an admin can accept a page or ask for a
  rescan.
- **Only a reviewer or an admin may confirm a diagnosis.**
  `can_confirm_diagnosis()` in `rbac.py` is the single place that decides this,
  and it is what any future clinical-transfer step must consult — see §8.

Give people the narrowest role that lets them work, and do not share accounts.
Every action is attributed to the account that performed it; a shared login
makes the audit trail worthless.

---

## 2. Enforcement is server side, on every route

Authentication is a bearer JWT from `POST /api/auth/login`. `current_user`
rejects a missing, malformed or expired token, and also rejects a token for a
user who has since been deactivated — deactivating an account takes effect
immediately, without waiting for the token to expire.

`require_roles()` produces the dependencies used across the routers:
`require_admin`, `require_uploader`, `require_reviewer`, `require_any`.

### The file routes are guarded too

This is the part that is usually got wrong, so it is stated plainly:

> **A page preview is patient data exactly as much as the JSON is.**
> `GET /pages/{id}/image`, `/preview`, `/thumb` and `/annotated`, and every
> `/reports/*` export, are role-checked server side on each request. They are
> not protected by having an unguessable URL.

Consequences that the rest of the system is built around:

- **Objects are never publicly readable.** Neither storage backend exposes a
  public URL. The local backend writes files `0600` and refuses any key that
  resolves outside `STORAGE_ROOT`; the S3 backend is used with a private bucket
  and no presigned URLs are issued.
- **The browser cannot use a plain `<img src>`.** The frontend fetches images
  with the bearer token attached and turns the response into a `blob:` URL — see
  `frontend/src/hooks/useAuthedObjectUrl.ts`. That is a direct consequence of
  authorising the image routes, not an inconvenience to be worked around.
- **nginx adds no authorisation.** It proxies `/api` and nothing more. Every
  decision is the backend's.
- **Exports carry the same rules as the screen.** A report accepts the same
  filters and produces the same totals, under the same role check.

### Client-side checks are cosmetic

The SPA hides controls a user may not use. That is for usability. Removing the
JavaScript check changes nothing: the server rejects the request.

---

## 3. Encryption

### In transit

| Hop | Protection |
|---|---|
| Browser → reverse proxy | **TLS 1.2+, which you must configure.** The compose stack does not terminate TLS |
| Reverse proxy → frontend/backend | Inside the Docker network or the host. Use TLS or a private network if they are on separate hosts |
| Backend/worker → Postgres | Enable `sslmode=require` in `DATABASE_URL` when the database is not on the same host |
| Backend/worker → Redis | Use `rediss://` and a password if Redis is not local |
| Worker → Google Document AI | HTTPS, enforced by the endpoint |
| Worker → Azure Document Intelligence | HTTPS, enforced by the endpoint |
| Worker → MinIO/S3 | HTTPS. `http://minio:9000` is acceptable only on the internal compose network; use `https://` for anything crossing a host boundary |

`nginx.conf` deliberately does not set HSTS. The TLS-terminating proxy is the
right place to own it, and setting it in two places makes it impossible to turn
off. Set it there.

### At rest

| Layer | Mechanism | Who configures it |
|---|---|---|
| Object store (S3/MinIO) | `S3_SERVER_SIDE_ENCRYPTION`, default `AES256`. Set to `aws:kms` for a customer-managed key | You |
| Object store (local volume) | **Nothing application-level.** Files are `0600`, owned by the non-root `opd` user. Encryption must come from the filesystem or the disk — LUKS, dm-crypt, an encrypted VM disk | You |
| PostgreSQL | **No column-level encryption.** Use an encrypted volume, or your platform's encryption-at-rest | You |
| Backups | Not encrypted by anything in this system | You |
| Passwords | bcrypt (cost 12), called directly; passwords over 72 bytes are SHA-256 pre-hashed so the whole password stays significant. Never stored or logged in the clear | Built in |

Be clear about what that means: **on a local-storage deployment, the scans on
disk are protected by file permissions and by whatever encrypts the underlying
volume.** If the volume is not encrypted, the scans are not encrypted. Encrypt
the volume.

---

## 4. Secrets

| Secret | Setting | Handling |
|---|---|---|
| JWT signing key | `SECRET_KEY` | 48+ random characters. Rotating it invalidates every issued token, which is the correct response to a suspected compromise |
| Database password | `DATABASE_URL`, `POSTGRES_PASSWORD` | Keep the two in step |
| Google service-account key | `GOOGLE_CREDENTIALS_JSON` | A **path** to a file, not the key contents. Mount it read-only |
| Azure API key | `AZURE_DI_KEY` | Rotate on a schedule; Azure issues two keys so one can be swapped while the other is live |
| S3/MinIO credentials | `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Scope to the single bucket |

Rules:

- **`.env` is never committed.** `.gitignore` excludes `.env`, `*.pem`, `*.key`,
  `*service-account*.json` and `*credentials*.json`. That is a safety net, not
  the policy.
- **Credentials are never baked into an image.** Both Dockerfiles copy their
  source trees by name rather than with `COPY . .`, precisely so that a
  developer's `.env` or key file cannot end up in a layer.
- **Mount the Google key read-only**, into `backend`, `worker` *and* `beat`. A
  key mounted into only the API makes the Settings screen look healthy while
  every job fails.
- **Least privilege on the service account.** `roles/documentai.apiUser` only.
  Not Editor, not Owner.
- **Rotate after any staff change** that involved access to the deployment host.
- Prefer your orchestrator's secret store over a plain `.env` on disk wherever
  one is available.

`backend/app/config.py` contains no secret values; every secret arrives from the
environment. `.env.example` contains only `CHANGE_ME` placeholders, so a value
left unedited is obvious.

---

## 5. Retention

| Setting | Controls | Default |
|---|---|---|
| `RETENTION_DAYS_ORIGINALS` | Deletion of the original uploaded file | `0` — keep indefinitely |
| `RETENTION_DAYS_DERIVATIVES` | Deletion of renders, previews and thumbnails | `0` — keep indefinitely |

Both default to keeping data for ever, because the alternative — deleting
patient records on a default nobody chose — is worse. **Set them to your
records-retention policy, from a decision that is written down.**

Notes:

- Derivatives are regenerable from the original, so the derivatives period can
  be much shorter than the originals period.
- Deletion sweeps run on the `beat` schedule. **The sweep is not implemented in
  this tree** (`backend/app/workers/` is empty), so today these settings record
  a policy that nothing yet enforces. Do not report retention as satisfied on
  the strength of the setting alone.
- Metadata, audit rows and reviewer decisions are not deleted by these settings.
  That is deliberate: the record of *who decided what* is what an investigation
  needs, and it contains no page content.
- **If your backups outlive your retention period, you have not deleted
  anything.** Align the two and say so in the data-protection record.

---

## 6. Audit logging

Every access, change and review is recorded in `audit_events` with actor,
action, entity type, entity id, IP and timestamp. `backend/app/core/audit.py`
guarantees two things:

**It is complete.** The audit trail is meant to answer "who looked at this
record, and who accepted this page". It records identifiers and actions.

**It carries no patient text, by construction rather than by discipline.**

- `_FORBIDDEN_KEYS` replaces the value of any metadata key named `text`,
  `raw_text`, `cleaned_text`, `diagnosis`, `content`, `ocr`, `full_text`,
  `patient_name`, `filename`, `original_filename`, `comment` or
  `corrected_text` with `<redacted>` — whatever a caller passes;
- any string metadata value longer than 120 characters becomes
  `<redacted:long-string>`, because long strings are how free text leaks;
- `redact()` masks UUIDs in log messages;
- the helpers take identifiers and counts, never content;
- provider error bodies are never logged or surfaced. Google and Azure can echo
  document content in an error response, so those handlers report the HTTP
  status or the exception type only.

**Filenames are patient data.** A scanning team names files
`Sharma_Ramesh_discharge.pdf`. `original_filename` is stored in the database
where it is role-protected, and it is excluded from logs.

`LOG_PATIENT_TEXT=true` disables the redaction. **It must remain `false` in any
environment holding real records.** It exists for local debugging against
synthetic data.

Diagnosis reviews are **append-only**. A correction adds a `diagnosis_reviews`
row; it never overwrites the machine output. Both the original extraction and
every subsequent decision are always retrievable, and reports carry an
`ai_vs_reviewed` column so the difference is visible rather than buried.

---

## 7. Data use — training

> **Uploaded patient records are not used to train, fine-tune or evaluate any
> model.**

This is a property of the codebase, not a promise about intent:

- there is no training, fine-tuning or dataset-export path anywhere in the tree;
- the only models involved are the vendors' own pre-trained OCR models, called
  per page and used only to produce that page's result;
- `ALLOW_TRAINING_USE` exists in `config.py` solely so that the answer is
  explicit and auditable. It defaults to `false` and nothing reads it to enable
  a training path, because there is none.

If you enable a cloud provider, the vendor's own data-use terms then apply to
the pages you send. Read them, and record the conclusion in your
data-protection assessment. That is a separate question from this system's
behaviour, and it is not one this document can answer for you.

---

## 8. Cloud processing is a deployment decision

`ALLOW_CLOUD_PROCESSING` defaults to **`false`**.

While it is false, both cloud providers refuse to run and report themselves as
`unconfigured` **even when valid credentials are present**. This is checked
inside each provider, not only in the router, so there is no configuration in
which credentials alone are enough:

```
"Cloud processing is disabled. Set ALLOW_CLOUD_PROCESSING=true to send pages
 to a cloud OCR service."
```

Setting it to `true` means **page images of patient records leave your network**
and are processed by Google or Microsoft. That is a decision for the
organisation, not a default and not a developer's choice. Before making it:

1. record it in your data-protection impact assessment;
2. choose the processing region deliberately — Google's processor location
   (`us` / `eu` / `asia1`) **cannot be changed after the processor is created**,
   and Azure's is fixed by the resource's region;
3. confirm the vendor's data-retention and data-use terms for the service you
   are calling;
4. confirm that a cross-border transfer is lawful for your jurisdiction;
5. name the accountable person.

If any of that is unsettled, run on premises. Upload, the entire OpenCV quality
engine, the review workflow and every report work with no provider at all — see
[ONPREM.md](ONPREM.md).

The local quality engine never leaves the machine under any configuration. It
takes no credentials and makes no network call.

---

## 9. Transfer into a clinical record system

**Nothing in this codebase pushes to any clinical record system.** There is no
EMR, HIS, registry or messaging integration. That is a deliberate boundary, and
it is where this system stops.

If a later project adds one, these conditions are not negotiable:

1. **Only human-confirmed extractions may transfer.** An extraction is eligible
   only when a reviewer or admin has confirmed or corrected it — a
   `diagnosis_reviews` row with action `confirm` or `correct`, by a user for
   whom `can_confirm_diagnosis()` is true. A status of
   `extracted_pending_review` is machine output that nobody has checked, and it
   must never leave the system.
2. **The confirming human must be identified in the transfer**, along with the
   time of confirmation. "The system said so" is not an attribution.
3. **The transfer itself must be an explicit, authorised action**, not a
   background consequence of a review. Confirming a transcription is a statement
   about what the page says; writing to a clinical record is a different act and
   needs its own decision.
4. **Transfer the text as written.** No normalisation to a code system, no
   inferred ICD codes, no expansion of an abbreviation into a fuller diagnosis.
   `icd_code_verbatim` holds a code only when it is literally written on the
   page.
5. **Preserve the qualifier.** `provisional`, `suspected`, `differential`,
   `ruled_out`, `negated` and `past_history` change the clinical meaning
   entirely. Dropping the qualifier turns a ruled-out diagnosis into a
   diagnosis. A transfer that cannot carry the qualifier must not carry the
   text.
6. **Audit both ends.** Record what was sent, by whom, to where, and when.

The system transcribes what a clinician wrote. It does not diagnose, does not
infer a diagnosis from symptoms or medicines, and does not code. Any downstream
integration must preserve that boundary rather than quietly erasing it.

---

## 10. Hardening checklist

Before a deployment holding real records:

- [ ] `SECRET_KEY` is 48+ random characters and is not the default
- [ ] `POSTGRES_PASSWORD` is not the placeholder
- [ ] `ENVIRONMENT=prod`
- [ ] `LOG_PATIENT_TEXT=false`, asserted by configuration management
- [ ] `ALLOW_CLOUD_PROCESSING` matches a written, signed decision
- [ ] `RETENTION_DAYS_*` match a written records-retention policy
- [ ] TLS terminates in front of the stack; HSTS is set on that proxy
- [ ] Port 8080 is not reachable beyond the staff LAN; 5432, 6379, 8000 and 9000 are not published at all
- [ ] The storage volume and the database volume are on encrypted disks
- [ ] `S3_SERVER_SIDE_ENCRYPTION` is set when using S3 or MinIO
- [ ] The Google key is mounted read-only into `backend`, `worker` and `beat`, and the service account holds only `roles/documentai.apiUser`
- [ ] The first admin account is a named person, not a shared login
- [ ] Every user has the narrowest role that lets them work
- [ ] Backups of the database *and* the object store run, and a restore has been tested
- [ ] Log retention is set, and logs stay inside your trust boundary
- [ ] `/api/settings/capabilities` is monitored for a capability silently becoming `unconfigured`
- [ ] Staff have been told that `unconfigured` means *not checked*, never *nothing found*
