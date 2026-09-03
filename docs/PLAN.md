# Implementation Plan — AI Patient Record Scan Quality & Diagnosis Extraction System

**Status of this document:** written after inspecting three real sample files supplied by the customer
(`IP140922101`, `IP140922102`, `IP140922103` — 33, 35 and 27 pages, 10–25 MB each). Observations below
come from those files. Anything not yet measured is marked *unvalidated*.

---

## 1. What the samples actually look like

This matters more than any generic design, because the sample files are **not** clean flatbed scans.

| Observation | Consequence for the system |
|---|---|
| **Page 1 and the last page** are flatbed scans of a single A4 sheet, portrait, ~1740×2260 px (≈200 DPI equivalent) | Two capture profiles must coexist inside one file; thresholds cannot assume one geometry |
| **Pages 2 … n-1** are overhead **camera photographs of an open, bound case file** — a two-page spread, landscape, ~3300×3700 × 2200×2700 px, shot on a dark desk | Need spread awareness, background/black-border handling, perspective + curl tolerance |
| Several pages are **rotated 90°** (e.g. `IP140922102` p7 — text runs bottom-to-top) | Rotation detection is a first-class defect, not a nicety |
| Several pages were saved as **1-bit bitonal PNG** at 6500×4800 (e.g. `IP140922103` p10–p22) | Harsh thresholding has destroyed mid-tones; faint pen/pencil is gone. **Bitonal-loss is its own defect class** — the file looks "sharp" but content is missing |
| One page (`IP140922101` p13) is a **washed-out photo of Hindi handwritten progress notes** — barely legible, with show-through from the reverse side | Faint/low-contrast detection must key on ink-vs-paper separation, not global brightness |
| Blank or near-blank facing pages are common inside spreads; final pages are often blank with a black frame border | Blank must be a **separate** classification, never "Acceptable" and never "Rescan" by default |
| Printed forms carry a **printed page number in parentheses** in the top corner — `(4)`, `(5)`, `(14)`, `(15)`, `(22)`, `(23)` | This is a genuine, cheap **sequence-gap** signal for completeness checking |
| Diagnosis is recorded in several places, nearly always **handwritten**: `Final Diagnosis` + `International Code of Disease` rows on the *Admission Notification Slip*; `Diagnosis :-` on the *Case Procedure Record*; `Deagnosis` [sic] on the *ENT Examination* sheet; free-text discharge summary | Extraction must be **label-anchored across several known form types**, not a single template |
| Diagnosis text is English clinical shorthand with heavy abbreviation (obstetric formulae, `c̄` for *with*, procedure acronyms), while progress notes are **handwritten Hindi** | English handwriting + Hindi handwriting are different model problems and are reported separately |

**Direct consequence:** the largest quality win here is not better OCR, it is flagging the
*photographed, curled, bitonally-crushed and rotated* pages for rescan. That is what the quality
engine is built around.

---

## 2. Provider evaluation (verified September 2026)

| Capability | Google Enterprise Document OCR | Azure AI Document Intelligence (Read) |
|---|---|---|
| Printed English | Yes | Yes |
| Printed Hindi / Devanagari | Yes (`hi`, `Deva`) | Yes |
| **Handwritten English** | Yes | Yes |
| **Handwritten Hindi** | **No** — the language table's "handwriting supported" column is blank for Hindi | **Yes** — `hi` is listed under handwritten-supported languages |
| Built-in image quality scores | **Yes** — `enableImageQualityScores`, `qualityScore` 0–1 plus eight defect types: `defect_blurry`, `defect_noisy`, `defect_dark`, `defect_faint`, `defect_text_too_small`, `defect_document_cutoff`, `defect_text_cutoff`, `defect_glare` | No equivalent |
| Handwriting localisation | Token-level style detection (font-style add-on) | `styles[].isHandwritten` with spans → polygons |
| Price | Free to 1,000 pages/month; **$1.50 / 1,000 pages** to 5M; $0.60 / 1,000 beyond. Add-ons $6.00 per use. Not billed for failed requests | Tiered per 1,000 pages + 500 pages/month free tier; **exact rate must be confirmed in the Azure calculator for the target region** — not verified here |
| On-premises | No | **Yes** — disconnected containers under annual commitment tiers |

**Decision.** Neither provider alone covers the requirement. The system therefore uses a **router**, not a swap:

- **Google Enterprise Document OCR** — default for quality scores and printed/English-handwritten OCR.
- **Azure DI Read** — used for pages where Hindi handwriting is detected or expected, and available as a full alternative provider.
- **Local provider** (OpenCV + Tesseract) — always available, used for quality analysis and as a degraded fallback.

At 1,000 pages/day ≈ 30,000 pages/month, Google list price works out to roughly **$45/month** for OCR.
Azure cost is additive and only incurred for pages routed to it. **These are list prices read from the
vendors' public pricing pages; they are not a quote and exclude egress, storage and support.**

**The OpenCV quality analyser always runs on the original image, independently of any provider.** No
page is ever classified from OCR confidence or DPI metadata alone.

---

## 3. Data model

```
users(id, email, full_name, password_hash, role[admin|uploader|reviewer], is_active, created_at)
audit_events(id, actor_id, action, entity_type, entity_id, ip, meta_json, created_at)

batches(id, name, created_by, status, note, created_at)
cases(id, batch_id, patient_ref, encounter_ref, confirmed_by, confirmed_at, checklist_id, created_at)
      -- patient/encounter refs are entered or confirmed by a human; never auto-merged from OCR

documents(id, case_id, batch_id, original_filename, sha256, mime, byte_size, page_count,
          uploaded_by, uploaded_at, ingest_status, ingest_error, storage_key_original)
      -- storage_key_original is immutable; nothing ever writes back to it

logical_pages(id, document_id, ordinal, printed_page_label, source_page_index, spread_half[none|left|right],
              active_version_id, created_at)
      -- the stable identity of "page 7 of this record". Rescans attach here.

page_versions(id, logical_page_id, version_no, is_active, replaces_version_id,
              storage_key_render, storage_key_thumb, width, height, dpi_estimate,
              colour_mode[colour|grey|bitonal], capture_profile[flatbed|photo|unknown],
              created_by, created_at)
      -- only is_active=true rows count in dashboard/report totals

quality_results(id, page_version_id, engine_version, thresholds_id, overall[acceptable|review|rescan|blank|unchecked],
                score, computed_at, raw_metrics_json, provider_used, provider_error)
quality_findings(id, quality_result_id, defect_code, severity[low|medium|high], confidence,
                 source[local|provider], region_json)

handwriting_results(id, page_version_id, model_version, status[detected|none_detected|failed|unconfigured],
                    provider_used, error, computed_at)
handwriting_regions(id, handwriting_results_id, category[note|signature|stamp|tick|correction|uncertain],
                    confidence, polygon_json, script_hint[latin|devanagari|mixed|unknown])
      -- status 'failed'/'unconfigured' is NEVER rendered as "no handwriting"

diagnosis_extractions(id, page_version_id, status[extracted_pending_review|not_found|unreadable|uncertain|processing_failed|unconfigured],
                      anchor_label, raw_text, cleaned_text, qualifier[final|provisional|suspected|differential|ruled_out|negated|past_history|unspecified],
                      icd_code_verbatim, region_json, confidence, model_version, extracted_at)
      -- raw_text is immutable; cleaned_text is presentation only; icd_code_verbatim only if literally on the page
diagnosis_reviews(id, extraction_id, reviewer_id, action[confirm|correct|reject], corrected_text,
                  corrected_qualifier, comment, created_at)
      -- append-only; original AI output always preserved

page_reviews(id, page_version_id, reviewer_id, action[accept|request_rescan|correct_finding|comment],
             comment, created_at)

checklists(id, name, is_active), checklist_items(id, checklist_id, doc_type, min_pages, required)
completeness_results(id, case_id, status[verified|incomplete|not_verified], computed_at, findings_json)

jobs(id, kind[ingest|quality|handwriting|diagnosis], page_version_id, document_id, state[queued|running|succeeded|failed|cancelled],
     attempt, max_attempts, idempotency_key UNIQUE, started_at, finished_at, error, worker_id, heartbeat_at)
settings(key, value_json, updated_by, updated_at)   -- thresholds, provider config, retention
```

Counting rules baked into the queries:

- a page is counted once per metric; a page with both a defect and handwriting appears in **both** counts and in an explicit "overlap" figure;
- `unchecked`, `failed` and `blank` never roll up into "Acceptable";
- only `page_versions.is_active` rows are counted;
- handwriting presence is never a quality defect.

---

## 4. Build order

1. Backend skeleton, models, migrations, auth/RBAC, audit, storage adapters
2. Ingest: upload → validate → rasterise → logical pages → version 1
3. Local OpenCV quality analyser, tuned against the 95 real sample pages
4. Provider interface + Google/Azure adapters + local fallback
5. Handwriting detection and regions
6. Diagnosis extraction with qualifier preservation
7. Celery jobs, idempotency, retries, cancellation, recovery
8. Completeness checklist
9. React frontend
10. Reports and exports
11. Tests, Docker, benchmark
