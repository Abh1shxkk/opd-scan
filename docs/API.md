# API contract

Base path `/api`. Auth is a bearer JWT from `/api/auth/login`. Every route is role-checked server
side, **including the file routes** — previews and originals are patient data.

Roles: `admin`, `uploader`, `reviewer`. Admin implies both others.

## Conventions

- Timestamps are ISO-8601 UTC.
- Page classes: `acceptable | review | rescan | blank | failed | unchecked`.
  `blank` and `failed` and `unchecked` are **never** rolled into `acceptable`.
- Handwriting status: `detected | none_detected | failed | unconfigured | pending`.
  A `failed`/`unconfigured` status must be rendered as "not checked", never as "no handwriting".
- Diagnosis status: `extracted_pending_review | not_found | unreadable | uncertain |
  processing_failed | unconfigured | pending`.
- Regions are `{x, y, w, h}` in **original render pixels**; polygons are `[[x,y], ...]` likewise.
  The viewer must scale by `displayed_width / page.width`.

## Auth

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | form-encoded `username`,`password` → `{access_token, token_type, user}` |
| GET | `/auth/me` | any | current user |
| POST | `/auth/users` | admin | create user |
| GET | `/auth/users` | admin | list users |
| PATCH | `/auth/users/{id}` | admin | role / active |

## Batches, cases, documents

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/batches` | any | `?q=&from=&to=` |
| POST | `/batches` | uploader | `{name, note}` |
| GET | `/batches/{id}` | any | includes counts |
| GET | `/cases` | any | `?batch_id=&patient_ref=&encounter_ref=` |
| POST | `/cases` | uploader | `{batch_id, patient_ref, encounter_ref, checklist_id?}` |
| PATCH | `/cases/{id}/confirm` | uploader | records who confirmed the reference and when |
| POST | `/documents/upload` | uploader | multipart: `files[]`, `batch_id`, optional `case_id`. Returns per-file `{document_id, status, message}`; rejected files come back with `status: rejected` and a human-readable `message`. |
| GET | `/documents` | any | filters below |
| GET | `/documents/{id}` | any | document + logical pages + active version summary |
| DELETE | `/documents/{id}` | admin | soft delete, audited |

### Document/page filters (shared by list, dashboard and exports)

`batch_id`, `case_id`, `patient_ref`, `encounter_ref`, `from`, `to`, `page_class[]`,
`defect_code[]`, `handwriting[]`, `diagnosis_status[]`, `review_state` (`pending|accepted|rescan_requested`),
`uploader_id`, `q`.

**Exports must accept the identical query string and produce identical totals.**

## Pages

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/pages` | any | paged list of **active** page versions with quality/handwriting/diagnosis summary |
| GET | `/pages/{page_version_id}` | any | full detail: metrics, findings, handwriting regions, diagnoses, versions |
| GET | `/pages/{id}/image` | any | original render (PNG) |
| GET | `/pages/{id}/preview` | any | bounded-size preview |
| GET | `/pages/{id}/thumb` | any | thumbnail |
| GET | `/pages/{id}/annotated` | any | render with overlays burned in; `?show=quality,handwriting,diagnosis` |
| POST | `/pages/{id}/review` | reviewer | `{action: accept|request_rescan|correct_finding|comment, comment?, payload?}` |
| POST | `/pages/{id}/replace` | uploader | multipart single image/PDF-page → creates version N+1, deactivates N |
| POST | `/pages/{id}/reprocess` | uploader | re-queue `quality|handwriting|diagnosis` |

## Diagnosis review

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/diagnoses` | any | queue; `?status=&reviewed=true|false` + shared filters |
| GET | `/diagnoses/{id}` | any | extraction + source page + region + review history |
| POST | `/diagnoses/{id}/review` | reviewer | `{action: confirm|correct|reject, corrected_text?, corrected_qualifier?, comment?}` — appends, never overwrites |

## Completeness

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/checklists` / POST / PATCH / DELETE | admin | checklist CRUD |
| GET | `/cases/{id}/completeness` | any | `{status: verified|incomplete|not_verified, findings: {...}}` |
| POST | `/cases/{id}/completeness/recompute` | uploader | |

`not_verified` is the default and must be shown as **"Completeness not verified"**.

## Dashboard

`GET /dashboard?<shared filters>` returns:

```jsonc
{
  "totals": {
    "files": 0, "pages_active": 0,
    "processing": {"queued": 0, "running": 0, "failed": 0},
    "quality": {"acceptable": 0, "review": 0, "rescan": 0, "blank": 0, "failed": 0, "unchecked": 0},
    "handwriting": {"detected": 0, "none_detected": 0, "failed": 0, "unconfigured": 0, "pending": 0},
    "diagnosis": {"extracted_pending_review": 0, "not_found": 0, "unreadable": 0,
                  "uncertain": 0, "processing_failed": 0, "unconfigured": 0, "pending": 0},
    "awaiting_review": 0
  },
  "overlaps": {
    "defect_and_handwriting": 0,
    "defect_only": 0,
    "handwriting_only": 0
  },
  "defects": [{"code": "blur", "label": "...", "pages": 0}],
  "capabilities": { "...": {"status": "ready|unconfigured", "setup_required": "..."} }
}
```

Every count is **distinct active page versions**. `defect_and_handwriting` exists so the UI can show
that the categories overlap rather than implying they partition the set.

## Reports

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/reports/pages.csv` | any | shared filters |
| GET | `/reports/pages.xlsx` | any | |
| GET | `/reports/pages.pdf` | any | |
| GET | `/reports/rescan-checklist.pdf` | any | pages classed `rescan` or with an accepted rescan request |
| GET | `/reports/flagged.zip` | any | selected flagged pages; `?annotated=true|false` |

Columns: batch, patient_ref, encounter_ref, filename, page_no, printed_label, version,
scan_status, defect_codes, defect_severities, handwriting_status, handwriting_categories,
diagnosis_status, diagnosis_qualifier, diagnosis_text (raw), diagnosis_text_reviewed,
reviewed_by, reviewer_comment, ai_vs_reviewed.

## Jobs and settings

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/jobs` | any | `?state=&kind=&document_id=` |
| POST | `/jobs/{id}/cancel` | uploader | |
| GET | `/settings/thresholds` / PUT | admin | quality thresholds |
| GET | `/settings/capabilities` | any | provider readiness + setup instructions |
| GET | `/health` | — | liveness |
