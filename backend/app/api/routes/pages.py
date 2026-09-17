"""Page listing, detail, images, review actions and rescan replacement.

The image routes are role-checked like every other route. A preview is patient data; serving it
from an unguessable URL without an auth check would be a hole in exactly the place people forget to
look.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import page_filters
from app.api.routes.diagnoses import _reviewer_name, split_safety_context
from app.core import audit
from app.core.rbac import current_user, require_reviewer, require_uploader
from app.core.storage import get_storage
from app.db import get_db
from app.models import (
    Batch,
    Case,
    Document,
    LogicalPage,
    PageReview,
    PageVersion,
    PrescriptionAnalysis,
    User,
)
from app.models.core import HandwritingStatus, JobKind, PageClass
from app.processing import ingest
from app.processing.quality.rules import DEFECT_LABELS
from app.services import threshold_autotune
from app.schemas.api import (
    DiagnosisOut,
    FindingOut,
    HandwritingOut,
    HandwritingRegionOut,
    MedicineOut,
    PagedPages,
    PageDetail,
    PageReviewIn,
    PageSummary,
    PageVersionRef,
    PrescriptionOut,
    QualityOut,
)
from app.services import annotate, ingest_service
from app.services import jobs as job_service
from app.services.query import PageFilters, active_page_query, count_pages, latest_correction

router = APIRouter(tags=["pages"])

_IMMUTABLE_CACHE = "private, max-age=3600"


def _media_for(key: str) -> str:
    return "image/png" if key.lower().endswith(".png") else "image/jpeg"


def _review_state(pv: PageVersion) -> str:
    actions = {r.action for r in pv.reviews}
    if "request_rescan" in actions:
        return "rescan_requested"
    if "accept" in actions:
        return "accepted"
    return "pending"


def _diagnosis_bucket(pv: PageVersion) -> str:
    if not pv.diagnoses:
        return "pending"
    order = [
        "processing_failed", "unreadable", "uncertain", "extracted_pending_review",
        "unconfigured", "pending", "not_found",
    ]
    present = {d.status.value for d in pv.diagnoses}
    for status in order:
        if status in present:
            return status
    return "pending"


def _summary(pv: PageVersion) -> PageSummary:
    page = pv.logical_page
    doc = page.document
    quality = pv.quality
    hw = pv.handwriting
    return PageSummary(
        page_version_id=pv.id,
        logical_page_id=page.id,
        document_id=doc.id,
        batch_id=doc.batch_id,
        batch_name=doc.batch.name if doc.batch else None,
        case_id=doc.case_id,
        patient_ref=doc.case.patient_ref if doc.case else None,
        encounter_ref=doc.case.encounter_ref if doc.case else None,
        document_filename=doc.original_filename,
        ordinal=page.ordinal,
        printed_page_label=page.printed_page_label,
        version_no=pv.version_no,
        width=pv.width,
        height=pv.height,
        colour_mode=pv.colour_mode.value,
        capture_profile=pv.capture_profile.value,
        page_class=quality.overall.value if quality else PageClass.unchecked.value,
        quality_score=quality.score if quality else None,
        defect_codes=sorted({f.defect_code for f in quality.findings}) if quality else [],
        handwriting_status=hw.status.value if hw else HandwritingStatus.pending.value,
        handwriting_categories=sorted({r.category.value for r in hw.regions}) if hw else [],
        handwriting_region_count=len(hw.regions) if hw else None,
        diagnosis_status=_diagnosis_bucket(pv),
        prescription_status=pv.prescription.status.value if pv.prescription else None,
        review_state=_review_state(pv),
        uploaded_at=doc.uploaded_at,
    )


def _load_page(db: Session, page_version_id: str) -> PageVersion:
    pv = db.execute(
        select(PageVersion)
        .where(PageVersion.id == page_version_id)
        .options(
            selectinload(PageVersion.logical_page).selectinload(LogicalPage.document).selectinload(Document.batch),
            selectinload(PageVersion.logical_page).selectinload(LogicalPage.document).selectinload(Document.case),
            selectinload(PageVersion.logical_page).selectinload(LogicalPage.versions),
            selectinload(PageVersion.logical_page)
            .selectinload(LogicalPage.document)
            .selectinload(Document.pages)
            .selectinload(LogicalPage.versions)
            .selectinload(PageVersion.quality),
            selectinload(PageVersion.quality),
            selectinload(PageVersion.handwriting),
            selectinload(PageVersion.diagnoses),
            selectinload(PageVersion.prescription).selectinload(PrescriptionAnalysis.medicines),
            selectinload(PageVersion.reviews),
        )
    ).scalar_one_or_none()
    if pv is None:
        raise HTTPException(404, "Page not found")
    return pv


@router.get("/pages", response_model=PagedPages)
def list_pages(
    f: PageFilters = Depends(page_filters),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    total = count_pages(db, f)
    # A document rarely exceeds a couple hundred pages; a low default here would split one
    # document's pages across pagination pages, breaking the per-document accordion grouping in
    # the UI (a document's pages would appear to "disappear" once its run crosses a page boundary).
    limit = f.limit or 200
    paged = PageFilters(**{**f.__dict__, "limit": limit})
    stmt = active_page_query(db, paged, apply_paging=True).options(
        selectinload(PageVersion.logical_page).selectinload(LogicalPage.document).selectinload(Document.batch),
        selectinload(PageVersion.logical_page).selectinload(LogicalPage.document).selectinload(Document.case),
        selectinload(PageVersion.quality),
        selectinload(PageVersion.handwriting),
        selectinload(PageVersion.diagnoses),
        selectinload(PageVersion.prescription),
        selectinload(PageVersion.reviews),
    )
    items = [_summary(pv) for pv in db.execute(stmt).scalars().unique()]
    return PagedPages(total=total, limit=limit, offset=f.offset or 0, items=items)


@router.get("/pages/{page_version_id}", response_model=PageDetail)
def page_detail(page_version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    pv = _load_page(db, page_version_id)
    base = _summary(pv).model_dump()

    findings = []
    if pv.quality:
        for f in pv.quality.findings:
            findings.append(
                FindingOut(
                    id=f.id,
                    code=f.defect_code,
                    label=DEFECT_LABELS.get(f.defect_code, f.defect_code),
                    severity=f.severity.value,
                    confidence=f.confidence,
                    source=f.source,
                    detail=f.detail,
                    region=f.region_json,
                )
            )

    hw_regions = []
    if pv.handwriting:
        for r in pv.handwriting.regions:
            hw_regions.append(
                HandwritingRegionOut(
                    id=r.id,
                    category=r.category.value,
                    category_confidence=r.category_confidence,
                    confidence=r.confidence,
                    script_hint=r.script_hint,
                    polygon=r.polygon_json or [],
                    model_version=r.model_version,
                )
            )

    quality_out = (
        QualityOut(
            overall=pv.quality.overall.value,
            score=pv.quality.score,
            engine_version=pv.quality.engine_version,
            thresholds_hash=pv.quality.thresholds_hash,
            provider_used=pv.quality.provider_used,
            provider_error=pv.quality.provider_error,
            computed_at=pv.quality.computed_at,
            findings=findings,
        )
        if pv.quality
        else None
    )

    handwriting_out = (
        HandwritingOut(
            status=pv.handwriting.status.value,
            model_version=pv.handwriting.model_version,
            provider_used=pv.handwriting.provider_used,
            error=pv.handwriting.error,
            computed_at=pv.handwriting.computed_at,
            regions=hw_regions,
        )
        if pv.handwriting
        else None
    )

    prescription_out = (
        PrescriptionOut(
            status=pv.prescription.status.value,
            language_detected=pv.prescription.language_detected,
            raw_extracted_text=pv.prescription.raw_extracted_text,
            diagnosis_or_notes=pv.prescription.diagnosis_or_notes,
            possible_interpretation=pv.prescription.possible_interpretation,
            patient_explanation=pv.prescription.patient_explanation,
            medicines=[
                MedicineOut(
                    name=m.name, dose=m.dose, frequency=m.frequency, duration=m.duration,
                    general_use=m.general_use, confidence=m.confidence, uncertainty=m.uncertainty,
                )
                for m in pv.prescription.medicines
            ],
            safety_warnings=list(pv.prescription.safety_warnings_json or []),
            uncertainties=list(pv.prescription.uncertainties_json or []),
            requires_professional_confirmation=pv.prescription.requires_professional_confirmation,
            ocr_provider_used=pv.prescription.ocr_provider_used,
            reasoning_provider_used=pv.prescription.reasoning_provider_used,
            model_version=pv.prescription.model_version,
            error=pv.prescription.error,
            computed_at=pv.prescription.computed_at,
        )
        if pv.prescription
        else None
    )

    # One lookup for every reviewer who corrected any diagnosis on this page, rather than one per
    # correction. Names matter here: "corrected by a3f9c1e2-…" tells a reader nothing.
    corrector_ids = {
        r.reviewer_id
        for d in pv.diagnoses
        for r in d.reviews
        if r.action in ("correct", "reject") and r.reviewer_id
    }
    correctors = (
        {u.id: u for u in db.execute(select(User).where(User.id.in_(corrector_ids))).scalars()}
        if corrector_ids
        else {}
    )

    diagnoses = []
    for d in pv.diagnoses:
        # Same split the diagnosis review screen uses, so a reviewer cross-checking one extraction
        # from two screens sees the same safety context in both.
        region, note, cleaning_applied, ambiguous_abbreviations = split_safety_context(d.region_json)
        correction = latest_correction(d)
        diagnoses.append(
            DiagnosisOut(
                id=d.id,
                status=d.status.value,
                anchor_label=d.anchor_label,
                raw_text=d.raw_text,
                cleaned_text=d.cleaned_text,
                qualifier=d.qualifier.value,
                icd_code_verbatim=d.icd_code_verbatim,
                is_handwritten=d.is_handwritten,
                region=region,
                note=note,
                cleaning_applied=cleaning_applied,
                ambiguous_abbreviations=ambiguous_abbreviations,
                confidence=d.confidence,
                model_version=d.model_version,
                provider_used=d.provider_used,
                error=d.error,
                extracted_at=d.extracted_at,
                is_reviewed=bool(d.reviews),
                corrected_text=correction.text,
                corrected_qualifier=correction.qualifier if correction.text else None,
                corrected_at=correction.corrected_at,
                corrected_by_name=_reviewer_name(correctors.get(correction.corrected_by)),
                reviews=[],
            )
        )

    versions = [
        PageVersionRef(
            id=v.id, version_no=v.version_no, is_active=v.is_active, created_at=v.created_at,
            created_by=v.created_by, width=v.width, height=v.height,
            replaces_version_id=v.replaces_version_id,
            colour_mode=v.colour_mode.value if v.colour_mode else None,
            capture_profile=v.capture_profile.value if v.capture_profile else None,
            dpi_estimate=v.dpi_estimate,
            # A superseded version keeps its own verdict; None means it was never measured, which
            # the UI must show as "not checked" rather than as a pass.
            page_class=v.quality.overall.value if v.quality else None,
        )
        for v in sorted(pv.logical_page.versions, key=lambda v: v.version_no)
    ]

    document_pages = []
    for sibling in sorted(pv.logical_page.document.pages, key=lambda p: p.ordinal):
        av = sibling.active_version
        if av is None:
            continue
        document_pages.append(
            {
                "page_version_id": av.id,
                "ordinal": sibling.ordinal,
                "printed_page_label": sibling.printed_page_label,
                "page_class": av.quality.overall.value if av.quality else PageClass.unchecked.value,
                "review_state": _review_state(av),
            }
        )

    audit.record(db, actor_id=user.id, action="page.view", entity_type="page_version", entity_id=pv.id)
    db.commit()

    # A review trail identified only by UUID cannot be read by the people whose decisions it
    # records, so each review carries the reviewer's name, falling back to their email.
    _review_names: dict[str, str] = {}
    if pv.reviews:
        for _u in db.execute(
            select(User).where(User.id.in_([r.reviewer_id for r in pv.reviews]))
        ).scalars():
            _review_names[_u.id] = (_u.full_name or "").strip() or _u.username or _u.email

    return PageDetail(
        **base,
        findings=findings,
        handwriting_regions=hw_regions,
        handwriting_error=pv.handwriting.error if pv.handwriting else None,
        diagnoses=diagnoses,
        versions=versions,
        metrics=(pv.quality.raw_metrics_json if pv.quality else {}) or {},
        provider_used=pv.quality.provider_used if pv.quality else None,
        provider_error=pv.quality.provider_error if pv.quality else None,
        # page_version_id and payload are sent because the frontend's PageReviewEntry type has
        # always declared them. payload is what a correct_finding review actually changed, which is
        # the only record of it — omitting it left that undiscoverable.
        reviews=[
            {"id": r.id, "action": r.action, "comment": r.comment, "reviewer_id": r.reviewer_id,
             "reviewer_name": _review_names.get(r.reviewer_id),
             "page_version_id": r.page_version_id,
             "payload": r.payload_json or {},
             "created_at": r.created_at.isoformat()}
            for r in sorted(pv.reviews, key=lambda r: r.created_at)
        ],
        document_pages=document_pages,
        quality=quality_out,
        handwriting=handwriting_out,
        prescription=prescription_out,
    )


# ------------------------------------------------------------------- images


def _serve(db: Session, pv: PageVersion, key: str | None, media: str) -> Response:
    if not key:
        raise HTTPException(404, "Image not available for this page")
    try:
        data = get_storage().get_bytes(key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, "Image not available for this page") from exc
    return Response(content=data, media_type=media, headers={"Cache-Control": _IMMUTABLE_CACHE})


@router.get("/pages/{page_version_id}/image")
def page_image(page_version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    pv = _load_page(db, page_version_id)
    return _serve(db, pv, pv.storage_key_render, _media_for(pv.storage_key_render))


@router.get("/pages/{page_version_id}/preview")
def page_preview(page_version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    pv = _load_page(db, page_version_id)
    key = ingest_service._derived_key(ingest_service.PREVIEW_PREFIX, pv.id, "jpg")  # noqa: SLF001
    if not get_storage().exists(key):
        # No bounded preview was written (an older record, or a replacement added before previews
        # existed): fall back to the full render rather than 404-ing the viewer.
        return _serve(db, pv, pv.storage_key_render, _media_for(pv.storage_key_render))
    return _serve(db, pv, key, "image/jpeg")


@router.get("/pages/{page_version_id}/thumb")
def page_thumb(page_version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    pv = _load_page(db, page_version_id)
    return _serve(db, pv, pv.storage_key_thumb or pv.storage_key_render, "image/jpeg")


@router.get("/pages/{page_version_id}/annotated")
def page_annotated(
    page_version_id: str,
    show: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """The page with overlays burned in, clearly captioned so it cannot pass for the original."""
    pv = _load_page(db, page_version_id)
    try:
        image = ingest.bytes_to_image(get_storage().get_bytes(pv.storage_key_render))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, "Image not available for this page") from exc
    if image is None:
        raise HTTPException(404, "Image could not be decoded")

    findings = list(pv.quality.findings) if pv.quality else []
    regions = list(pv.handwriting.regions) if pv.handwriting else []
    diag = [
        {"anchor_label": d.anchor_label, "status": d.status.value, "region": d.region_json}
        for d in pv.diagnoses
        if d.region_json
    ]
    data = annotate.annotated_bytes(image, findings, regions, diag, annotate.parse_show(show))
    audit.record(db, actor_id=user.id, action="page.view_annotated", entity_type="page_version",
                 entity_id=pv.id)
    db.commit()
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "private, no-store"})


# ------------------------------------------------------------------ actions


@router.post("/pages/{page_version_id}/review")
def review_page(
    page_version_id: str,
    payload: PageReviewIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_reviewer),
):
    if payload.action not in ("accept", "request_rescan", "correct_finding", "correct_prescription", "comment"):
        raise HTTPException(422, f"Unknown review action '{payload.action}'")
    pv = _load_page(db, page_version_id)
    review = PageReview(
        page_version_id=pv.id,
        reviewer_id=actor.id,
        action=payload.action,
        comment=payload.comment,
        payload_json=payload.payload,
    )
    db.add(review)
    audit.record(
        db, actor_id=actor.id, action=f"page.review.{payload.action}", entity_type="page_version",
        entity_id=pv.id, ip=request.client.host if request.client else None,
    )
    db.flush()
    autotuned: list[dict] = []
    if payload.action == "correct_finding":
        # See services/threshold_autotune.py: bounded, audited, automatic threshold adjustment from
        # accumulated "this is not a defect" corrections. Runs inline — it is a handful of indexed
        # queries, not a job worth queuing.
        autotuned = threshold_autotune.maybe_autotune(db)
    db.commit()
    # The session still holds the pre-commit collection, so the state must be re-read rather than
    # recomputed from the cached object — otherwise the client is told the review did not land.
    db.expire_all()
    return {
        "ok": True,
        "review_state": _review_state(_load_page(db, page_version_id)),
        "thresholds_autotuned": autotuned,
    }


def _first_page_of_pdf(data: bytes, filename: str):
    """Render a single-page PDF for use as a page replacement.

    Returns (image, source_bits_per_component). Raises 422 with a reason a clerk can act on — the
    same vocabulary the uploader uses for a rejected file, so "password-protected" reads the same
    here as it does there.
    """
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp_path = tmp.name
            tmp.write(data)

        try:
            page_count, _ = ingest.probe_container(tmp_path, filename)
        except ingest.IngestRejected as exc:
            raise HTTPException(422, exc.message) from exc

        if page_count != 1:
            raise HTTPException(
                422,
                f"This PDF has {page_count} pages. A replacement stands in for one page — scan just "
                "that sheet, or use the uploader to add the whole document.",
            )

        try:
            rendered = next(iter(ingest.iter_pages(tmp_path, filename, read_labels=False)))
        except ingest.IngestRejected as exc:
            raise HTTPException(422, exc.message) from exc
        except StopIteration:
            raise HTTPException(422, "The PDF reported one page but rendered none.") from None

        return rendered.image, rendered.source_bits_per_component
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


@router.post("/pages/{page_version_id}/replace")
async def replace_page(
    page_version_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    """Attach a rescan to the same logical page.

    The superseded version stays in history and stops being counted; the new one becomes active and
    is re-analysed from scratch.

    Accepts an image or a single-page PDF. The PDF path matters in practice: a ward scanner asked to
    redo one sheet almost always emits a PDF, and requiring a conversion step first is how a rescan
    workflow stops being used. A multi-page file is refused rather than silently taking its first
    page — that is a whole document, and replacing one page with it would quietly discard the rest.
    """
    pv = _load_page(db, page_version_id)
    data = await file.read()
    if not data:
        raise HTTPException(422, "The replacement file is empty")

    name = Path(file.filename or "rescan").name
    if name.lower().endswith(".pdf"):
        image, bits = _first_page_of_pdf(data, name)
    else:
        image, bits = ingest.bytes_to_image(data), None
        if image is None:
            raise HTTPException(
                422,
                "The replacement could not be read as an image. Upload a PNG, JPEG or TIFF, or a "
                "single-page PDF.",
            )

    version = ingest_service.add_replacement_version(
        db, pv.logical_page, image, actor.id, bits_per_component=bits
    )
    audit.record(
        db, actor_id=actor.id, action="page.replace", entity_type="page_version", entity_id=version.id,
        meta={"replaces": pv.id, "version_no": version.version_no},
    )
    db.commit()
    return {"page_version_id": version.id, "version_no": version.version_no}


@router.post("/pages/{page_version_id}/reprocess")
def reprocess_page(
    page_version_id: str,
    stages: list[str] = Query(default=["quality", "handwriting", "diagnosis"]),
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    pv = _load_page(db, page_version_id)
    unknown = [s for s in stages if s not in ("quality", "handwriting", "diagnosis", "prescription")]
    if unknown:
        raise HTTPException(422, f"Unknown stage(s): {', '.join(unknown)}")

    from datetime import datetime, timezone

    salt = datetime.now(timezone.utc).isoformat(timespec="seconds")
    jobs = job_service.queue_page_stages(db, pv.id, stages, salt=salt)
    db.commit()
    ingest_service._dispatch([j.id for j in jobs])  # noqa: SLF001 - internal helper, same package
    audit.record(db, actor_id=actor.id, action="page.reprocess", entity_type="page_version",
                 entity_id=pv.id, meta={"stages": stages})
    db.commit()
    return {"job_ids": [j.id for j in jobs]}


@router.get("/jobs")
def list_jobs(
    state: str | None = None,
    kind: str | None = None,
    document_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    from app.models import Job
    from app.models.core import JobState

    stmt = select(Job).order_by(Job.queued_at.desc()).limit(min(max(limit, 1), 500)).offset(max(offset, 0))
    if state:
        stmt = stmt.where(Job.state == JobState(state))
    if kind:
        stmt = stmt.where(Job.kind == JobKind(kind))
    if document_id:
        stmt = stmt.where(Job.document_id == document_id)
    return [
        {
            "id": j.id, "kind": j.kind.value, "state": j.state.value, "attempt": j.attempt,
            "max_attempts": j.max_attempts, "progress": j.progress, "error": j.error,
            "document_id": j.document_id, "page_version_id": j.page_version_id,
            "queued_at": j.queued_at, "started_at": j.started_at, "finished_at": j.finished_at,
        }
        for j in db.execute(stmt).scalars()
    ]


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: Session = Depends(get_db), actor: User = Depends(require_uploader)):
    job = job_service.cancel(db, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    audit.record(db, actor_id=actor.id, action="job.cancel", entity_type="job", entity_id=job_id)
    db.commit()
    return {"id": job.id, "state": job.state.value}
