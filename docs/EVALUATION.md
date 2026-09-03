# Evaluation status

**Read this before quoting any number about how well the system works.**

No accuracy figure in this document comes from an independently labelled dataset, because no such
dataset exists yet for this deployment. Everything below is either (a) a measurement of the
software's behaviour, or (b) an observation from a three-file pilot that the author of the code also
tuned against — which is the weakest form of evidence there is, and is reported as such.

---

## 1. What the pilot set was

| | |
|---|---|
| Files | 3 in-patient case files supplied by the customer (`IP140922101`, `IP140922102`, `IP140922103`) |
| Pages | 95 |
| Size | 10–25 MB per file |
| Capture | Mixed: page 1 and the last page are flatbed scans of a single A4 sheet; the interior pages are overhead **photographs of an open bound file** on a dark desk |
| Colour | Mostly 24-bit colour; 13 pages were stored 1-bit bitonal at 6500×4800 |
| Languages | Printed English forms; handwritten English clinical shorthand; handwritten Hindi progress notes |

This is not a representative sample. It is three files from one department in one year, and it was
used for tuning. **It cannot support a claimed accuracy for anything.**

---

## 2. Scan-defect detection

### What was measured

The local OpenCV engine was run over all 95 pages. Distribution of the final classification:

| Class | Pages |
|---|---|
| Acceptable | 40 |
| Review required | 33 |
| Rescan recommended | 22 |
| Blank | 0 |
| Failed | 0 |

Defect frequency (a page may carry several):

| Defect | Pages |
|---|---|
| Suspected cut-off | 29 |
| Low contrast | 18 |
| Bitonal loss | 13 |
| Rotated (all in the *uncertain* band) | 12 |
| Unreadable region | 9 |
| Skewed | 9 |
| Shadow | 6 |
| Glare | 5 |
| Blur | 3 |
| Near blank | 2 |
| Faint | 2 |

### How thresholds were set

Not by guessing. Two of them were derived from measurement:

**Sharpness.** A crisp flatbed page from the pilot was progressively Gaussian-blurred and the
`stroke_sharpness` metric read at each step:

| Blur σ | stroke_sharpness | Subjective legibility |
|---|---|---|
| 0 | 3.86 | crisp |
| 1.5 | 2.09 | soft but readable |
| 2.5 | 1.45 | clearly blurred |
| 4 | 1.01 | barely readable |
| 6 | 0.66 | unreadable |

Across the 95 pilot pages, `stroke_sharpness` runs from 1.25 (min) through 2.28 (5th percentile) to
3.86 (median). The shipped thresholds — medium below 2.0, high below 1.2 — therefore flag roughly
the worst 5% of this material.

**Render encoding.** Renders are stored as JPEG quality 95 rather than PNG. This was checked, not
assumed: five pilot pages were measured from both encodings and produced **identical page
classifications**, with metric drift far inside the thresholds (largest observed: noise sigma
+0.03). Storage falls from ≈5 MB to ≈1 MB per page, which at 1,000 pages/day is the difference
between ~9 GB and ~1 GB a day. Bitonal sources are still stored as PNG.

### Known false positives

Verified by eye against the images, and **not** fixed by loosening the rule, because in each case a
human glance is the correct outcome:

* **Suspected cut-off (29 pages)** is the noisiest signal. On a flatbed scan the sheet fills the
  frame, so the "is the paper edge visible?" gate cannot help, and the check falls back to counting
  writing components that abut the frame. Some of these pages are not cropped.
* **Unreadable region** occasionally boxes a blank coloured cover sheet, whose paper texture reads
  as very low-contrast ink.
* **Rotated** is discussed below and is deliberately never conclusive on its own.

### Known limitation: orientation

This is the weakest part of the local engine and the honest statement is that **image-only
orientation detection did not work reliably on this material.**

Two independent signals were implemented and measured against seven hand-labelled pages: text-line
energy after ruled lines are removed, and the direction from each glyph to its nearest neighbour.
Neither separated a genuinely sideways page from an upright page carrying tall ruled columns — an
ENT examination sheet and a bitonal ward chart both scored as "rotated" at confidences (0.36, 0.36)
*above* the genuinely rotated page (0.24).

The system therefore:

* requires both signals to agree before saying anything at all;
* reports agreement at 0.30–0.55 confidence as **"Orientation uncertain"**, medium severity, which
  routes the page to review rather than to rescan, and says in the finding text that it may simply
  be a ruled column;
* only calls a page rotated at ≥0.55;
* **discards the local guess entirely when an OCR provider reports the orientation**, because
  reading the glyphs is the only reliable method — and the only one that can also tell 0° from 180°,
  which no image-statistics method can.

Upside-down pages are not detected without a provider. This is stated in the UI, not just here.

### Not measured

Missed detections and false-alarm rates. There is no ground truth. To produce those numbers, a
second person who did not write the thresholds must label a few hundred pages independently
(`acceptable / review / rescan`, plus which defects), and `tools/calibrate.py --csv` output must be
compared against it. Until that is done, no sensitivity or specificity may be quoted.

---

## 3. Handwriting detection

**Not evaluated at all.** No handwriting provider was configured during this work, so no handwriting
has been detected on any page by this system.

What *is* verified is the failure behaviour, which is the part that could do harm:

* with no provider configured, all 95 pilot pages report handwriting status `unconfigured`, and the
  UI renders that as "Handwriting not checked";
* a provider that returns no tokens produces `failed`, not `none_detected`;
* a provider that returns tokens without handwriting flags produces `unsupported`, not
  `none_detected`;
* only a successful response containing flagged words can ever produce `detected`, and only a
  successful response with no flagged words can produce `none_detected`.

These paths are covered by tests (`tests/test_handwriting.py`).

When a provider is configured, evaluation must measure **separately**: English handwriting, Hindi
handwriting, and the category assignment (note / signature / stamp / tick / correction). The category
heuristic in particular is geometric and will be wrong often; anything below a confidence floor is
already reported as `uncertain` rather than guessed.

---

## 4. Diagnosis extraction

**Not evaluated on real pages.** No diagnosis provider was configured, so no diagnosis has been
extracted from the pilot files. All 95 pages report `unconfigured`.

The extraction *logic* is tested against constructed OCR output (`tests/test_diagnosis_extract.py`),
covering the behaviours that matter clinically:

| Behaviour | Verified |
|---|---|
| Label-anchored extraction (`Final Diagnosis`, `Provisional Diagnosis`, `Diagnosis`, the ENT sheet's misprinted `Deagnosis`, `Impression`) | yes |
| Qualifier from the label (`Provisional Diagnosis` → provisional) | yes |
| Qualifier in the text overrides the label (`r/o TB` under "Final Diagnosis" → ruled_out) | yes |
| `K/C/O` → past_history, `?TB` → suspected, `D/D` → differential | yes |
| ICD code carried verbatim when present, and **never invented** when absent | yes |
| Ambiguous abbreviations (TAH, BSO, AUB, …) flagged and **not expanded** | yes |
| `raw_text` immutable; `cleaned_text` differs only by whitespace and label punctuation, with each change named in `cleaning_applied` | yes |
| Illegible value → `unreadable` with empty `cleaned_text`, never a guess | yes |
| Several diagnoses on one line stay separate entries | yes |
| Reviewer correction appends; original AI output is never overwritten | yes |

What the pilot files tell us about the task, from reading them directly: the diagnosis is
**handwritten** in every case, in heavy clinical shorthand (obstetric formulae, `c̄` for *with*,
procedure acronyms), and appears in at least four different places — the *Final Diagnosis* row of
the Admission Notification Slip, the `Diagnosis :-` field of the Case Procedure Record, the
`Deagnosis` line of the ENT sheet, and the free-text discharge summary. Expect transcription of this
material to be hard, and expect a reviewer to be needed on essentially every extraction. The
workflow is built on that assumption: nothing is marked confirmed without a human.

**Transcription accuracy, qualifier-preservation rate and abbreviation handling are all unmeasured.**

---

## 5. Throughput and cost

Measured on this development machine (2 vCPU), single process, per page, at 150 dpi:

| Stage | Mean | p95 |
|---|---|---|
| Render page from PDF | 156 ms | 222 ms |
| Encode render + preview + thumbnail | 69 ms | 78 ms |
| Quality measurement (OpenCV) | 430 ms | 544 ms |
| Rule evaluation | 0.2 ms | 0.2 ms |
| **Total local pipeline** | **655 ms** | — |

That is **≈5,500 pages/hour per worker process**; 1,000 pages needs about **11 worker-minutes** of
CPU. The daily target is not close to being a throughput problem for the local engine — one modest
worker covers it many times over. Add the pre-printed page-label OCR (≈240 ms/page) if it is left
enabled.

End-to-end run over the pilot: 95 pages, 288 jobs (3 ingest + 3 stages × 95 pages), all succeeded,
about 2.5 minutes wall-clock in a single inline process.

Storage, measured: 54 MB originals, 99 MB renders, 40 MB previews, 2 MB thumbnails for 95 pages —
about **2 MB per page** all in. At 1,000 pages/day that is ~2 GB/day, ~700 GB/year before any
retention policy is applied.

**The real constraint is the cloud OCR call, not the CPU.** Provider latency dominates once one is
configured, and provider cost scales linearly: at Google's list price of $1.50 per 1,000 pages,
30,000 pages/month is roughly **$45/month** for OCR. Azure's per-page rate must be confirmed in the
regional pricing calculator; it is not quoted here because it was not verified.

---

## 6. What must happen before this is trusted in a ward

1. **Label a real dataset.** A few hundred pages, labelled by someone who did not write the
   thresholds, covering both capture profiles and both languages.
2. **Measure the three capabilities separately** — scan-defect detection, handwriting detection,
   diagnosis transcription. They fail in different ways and averaging them hides that.
3. For diagnosis, measure **qualifier preservation explicitly**: the failure that matters is not a
   misspelled word, it is a *suspected* diagnosis presented as confirmed.
4. **Configure a provider and re-run the pilot**, then repeat every item above.
5. Only then may an accuracy figure be written down, and it should be written down with the dataset
   it was measured on.
