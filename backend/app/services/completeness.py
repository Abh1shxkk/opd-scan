"""Document completeness — a different question from scan quality.

Scan quality asks "is this image readable?". Completeness asks "did everything that should have
been scanned actually arrive?". The system can only answer the second question against a reference,
and it says so plainly when it has none.

The default answer is **"Completeness not verified"**. It is never upgraded to "complete" merely
because the uploaded files processed cleanly — the files that were never put on the scanner are
exactly the ones the system cannot see.

Where a checklist exists, three kinds of finding are produced:

* **missing** — an expected document type has no pages, or fewer pages than its minimum;
* **duplicate** — the same page content appears more than once (matched on a perceptual hash of the
  render, so a re-scan of the same sheet is caught even though the bytes differ);
* **sequence gap** — the pre-printed page numbers on these case-sheet forms skip a value.

A sequence gap is reported as a gap in *the numbers found*, never as a claim about what the missing
page contained.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.storage import get_storage
from app.models import Case, Checklist, CompletenessResult, Document, LogicalPage, PageVersion
from app.processing import ingest

STATUS_VERIFIED = "verified"
STATUS_INCOMPLETE = "incomplete"
STATUS_NOT_VERIFIED = "not_verified"

NOT_VERIFIED_MESSAGE = "Completeness not verified"


def _phash(image: np.ndarray) -> int:
    """64-bit perceptual hash — tolerant of rescans, exposure and small skew differences."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(small)[:8, :8]
    flat = dct.flatten()[1:]  # drop DC
    med = float(np.median(flat))
    bits = 0
    for i, v in enumerate(flat[:64]):
        if v > med:
            bits |= 1 << i
    return bits


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def _page_labels(pages: list[LogicalPage]) -> list[int]:
    out: list[int] = []
    for p in pages:
        label = (p.printed_page_label or "").strip("() ")
        if label.isdigit():
            out.append(int(label))
    return sorted(set(out))


def compute(db: Session, case: Case, duplicate_threshold: int = 6) -> CompletenessResult:
    result = db.execute(
        select(CompletenessResult).where(CompletenessResult.case_id == case.id)
    ).scalar_one_or_none() or CompletenessResult(case_id=case.id)
    result.computed_at = datetime.now(timezone.utc)

    documents = db.execute(
        select(Document)
        .where(Document.case_id == case.id)
        .options(selectinload(Document.pages).selectinload(LogicalPage.versions))
    ).scalars().all()

    active_pages: list[tuple[Document, LogicalPage, PageVersion]] = []
    for doc in documents:
        for page in doc.pages:
            av = page.active_version
            if av:
                active_pages.append((doc, page, av))

    findings: dict[str, Any] = {
        "uploaded_documents": len(documents),
        "uploaded_pages": len(active_pages),
        "missing": [],
        "duplicates": [],
        "sequence_gaps": [],
        "notes": [],
    }

    # ---- duplicates: independent of any checklist, so always computed -----------------
    hashes: list[tuple[int, str, str, int]] = []
    storage = get_storage()
    for doc, page, av in active_pages:
        try:
            img = ingest.bytes_to_image(storage.get_bytes(av.storage_key_thumb or av.storage_key_render))
        except Exception:
            img = None
        if img is None:
            continue
        hashes.append((_phash(img), doc.id, page.id, page.ordinal))

    seen: list[tuple[int, str, str, int]] = []
    for h, doc_id, page_id, ordinal in hashes:
        match = next((s for s in seen if _hamming(s[0], h) <= duplicate_threshold), None)
        if match:
            findings["duplicates"].append(
                {
                    "page_id": page_id,
                    "document_id": doc_id,
                    "ordinal": ordinal,
                    "duplicate_of_page_id": match[2],
                    "duplicate_of_ordinal": match[3],
                    "note": "Visually near-identical to an earlier page. May be a genuine repeat "
                            "form, a duplicate scan, or a rescan filed as a new page.",
                }
            )
        else:
            seen.append((h, doc_id, page_id, ordinal))

    # ---- sequence gaps from the pre-printed page numbers -----------------------------
    for doc in documents:
        labels = _page_labels(list(doc.pages))
        if len(labels) >= 3:
            gaps = [n for n in range(labels[0], labels[-1] + 1) if n not in labels]
            if gaps:
                findings["sequence_gaps"].append(
                    {
                        "document_id": doc.id,
                        "found_range": [labels[0], labels[-1]],
                        "missing_numbers": gaps[:50],
                        "note": "The pre-printed form numbers skip these values. What those pages "
                                "contained cannot be known from the uploaded files. Note that a "
                                "photographed two-page spread carries two printed numbers but only "
                                "one is read per image, so files captured that way will show gaps "
                                "that are an artefact of the capture rather than a missing page.",
                    }
                )

    # ---- checklist comparison ---------------------------------------------------------
    checklist = db.get(Checklist, case.checklist_id) if case.checklist_id else None
    if checklist is None:
        result.status = STATUS_NOT_VERIFIED
        findings["notes"].append(
            "No expected-document checklist is attached to this case, so completeness cannot be "
            "verified. Duplicates and page-number gaps below are informational only."
        )
        result.findings_json = findings
        db.add(result)
        return result

    # Document type currently comes from the uploader's filename convention; it is recorded as the
    # uploader stated it and is never inferred from page content.
    have: Counter[str] = Counter()
    for doc in documents:
        stem = doc.original_filename.rsplit(".", 1)[0].lower()
        for item in checklist.items:
            if item.doc_type.lower() in stem:
                have[item.doc_type] += sum(1 for p in doc.pages if p.active_version)

    for item in checklist.items:
        count = have.get(item.doc_type, 0)
        if item.required and count == 0:
            findings["missing"].append(
                {"doc_type": item.doc_type, "expected_min_pages": item.min_pages, "found_pages": 0}
            )
        elif count and count < item.min_pages:
            findings["missing"].append(
                {"doc_type": item.doc_type, "expected_min_pages": item.min_pages, "found_pages": count}
            )

    findings["checklist"] = {"id": checklist.id, "name": checklist.name}
    findings["notes"].append(
        "Verified against the attached checklist only. A document that was never scanned and is not "
        "on the checklist cannot be detected."
    )
    result.status = STATUS_INCOMPLETE if findings["missing"] else STATUS_VERIFIED
    result.findings_json = findings
    db.add(result)
    return result


def summarise(result: CompletenessResult | None) -> dict[str, Any]:
    if result is None:
        return {"status": STATUS_NOT_VERIFIED, "label": NOT_VERIFIED_MESSAGE, "findings": {}}
    label = {
        STATUS_VERIFIED: "Complete against the attached checklist",
        STATUS_INCOMPLETE: "Incomplete against the attached checklist",
        STATUS_NOT_VERIFIED: NOT_VERIFIED_MESSAGE,
    }[result.status]
    return {"status": result.status, "label": label, "findings": result.findings_json,
            "computed_at": result.computed_at}
