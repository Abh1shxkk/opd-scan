"""Diagnosis review.

The rules enforced here are the ones that matter clinically:

* A review is **appended**, never applied in place. ``raw_text`` and the original qualifier stay
  exactly as the model produced them, for as long as the record exists.
* Only Admin and Reviewer may confirm or correct.
* Confirmation is what makes an extraction usable downstream. Nothing in this codebase writes to a
  clinical record system, and the confirmed flag exists so that any future integration has an
  explicit authorised human decision to key off.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import page_filters
from app.core import audit
from app.core.rbac import current_user, require_reviewer
from app.db import get_db
from app.models import (
    DiagnosisExtraction,
    DiagnosisReview,
    Document,
    LogicalPage,
    PageVersion,
    User,
)
from app.models.core import DiagnosisStatus, Qualifier
from app.schemas.api import DiagnosisOut, DiagnosisReviewIn, DiagnosisReviewOut
from app.services.query import PageFilters, active_page_query

router = APIRouter(prefix="/diagnoses", tags=["diagnoses"])


def _serialise(d: DiagnosisExtraction, db: Session, include_source: bool = True) -> DiagnosisOut:
    pv = d.page_version
    page = pv.logical_page
    doc = page.document
    emails = {
        u.id: u.email
        for u in db.execute(
            select(User).where(User.id.in_([r.reviewer_id for r in d.reviews]))
        ).scalars()
    } if d.reviews else {}

    return DiagnosisOut(
        id=d.id,
        status=d.status.value,
        anchor_label=d.anchor_label,
        raw_text=d.raw_text,
        cleaned_text=d.cleaned_text,
        qualifier=d.qualifier.value,
        icd_code_verbatim=d.icd_code_verbatim,
        is_handwritten=d.is_handwritten,
        region=d.region_json,
        confidence=d.confidence,
        model_version=d.model_version,
        provider_used=d.provider_used,
        error=d.error,
        extracted_at=d.extracted_at,
        is_reviewed=bool(d.reviews),
        reviews=[
            DiagnosisReviewOut(
                id=r.id,
                reviewer_id=r.reviewer_id,
                reviewer_email=emails.get(r.reviewer_id),
                action=r.action,
                corrected_text=r.corrected_text,
                corrected_qualifier=r.corrected_qualifier.value if r.corrected_qualifier else None,
                comment=r.comment,
                created_at=r.created_at,
            )
            for r in d.reviews
        ],
        page=(
            {
                # Field names match the frontend's PageRef type exactly (document_filename, ordinal,
                # width, height) — this is consumed as `d.page`, not remapped on the way in.
                "page_version_id": pv.id,
                "logical_page_id": page.id,
                "document_id": doc.id,
                "document_filename": doc.original_filename,
                "ordinal": page.ordinal,
                "printed_page_label": page.printed_page_label,
                "version_no": pv.version_no,
                "width": pv.width,
                "height": pv.height,
                "batch_id": doc.batch_id,
                "batch_name": doc.batch.name if doc.batch else None,
                "case_id": doc.case_id,
                "patient_ref": doc.case.patient_ref if doc.case else None,
                "encounter_ref": doc.case.encounter_ref if doc.case else None,
            }
            if include_source
            else None
        ),
    )


def _load(db: Session, extraction_id: str) -> DiagnosisExtraction:
    d = db.execute(
        select(DiagnosisExtraction)
        .where(DiagnosisExtraction.id == extraction_id)
        .options(
            selectinload(DiagnosisExtraction.reviews),
            selectinload(DiagnosisExtraction.page_version)
            .selectinload(PageVersion.logical_page)
            .selectinload(LogicalPage.document)
            .selectinload(Document.case),
        )
    ).scalar_one_or_none()
    if d is None:
        raise HTTPException(404, "Diagnosis extraction not found")
    return d


@router.get("")
def list_diagnoses(
    status: str | None = None,
    reviewed: bool | None = None,
    limit: int = 100,
    offset: int = 0,
    f: PageFilters = Depends(page_filters),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    page_ids = select(active_page_query(db, f).subquery().c.id)
    stmt = (
        select(DiagnosisExtraction)
        .where(DiagnosisExtraction.page_version_id.in_(page_ids))
        .options(
            selectinload(DiagnosisExtraction.reviews),
            selectinload(DiagnosisExtraction.page_version)
            .selectinload(PageVersion.logical_page)
            .selectinload(LogicalPage.document)
            .selectinload(Document.case),
        )
        .order_by(DiagnosisExtraction.extracted_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if status:
        stmt = stmt.where(DiagnosisExtraction.status == DiagnosisStatus(status))

    rows = list(db.execute(stmt).scalars().unique())
    if reviewed is not None:
        rows = [d for d in rows if bool(d.reviews) is reviewed]
    # A plain array here means the frontend's `data.items` is always undefined — wrapped to match
    # the Paged<T> contract every other list endpoint (/pages, /documents) already follows.
    return {
        "items": [_serialise(d, db) for d in rows],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


@router.get("/{extraction_id}", response_model=DiagnosisOut)
def get_diagnosis(extraction_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    d = _load(db, extraction_id)
    audit.record(db, actor_id=user.id, action="diagnosis.view", entity_type="diagnosis_extraction",
                 entity_id=d.id)
    db.commit()
    return _serialise(d, db)


@router.post("/{extraction_id}/review", response_model=DiagnosisOut)
def review_diagnosis(
    extraction_id: str,
    payload: DiagnosisReviewIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_reviewer),
):
    if payload.action not in ("confirm", "correct", "reject"):
        raise HTTPException(422, f"Unknown review action '{payload.action}'")
    d = _load(db, extraction_id)

    corrected_qualifier = None
    if payload.corrected_qualifier:
        try:
            corrected_qualifier = Qualifier(payload.corrected_qualifier)
        except ValueError as exc:
            raise HTTPException(422, f"Unknown qualifier '{payload.corrected_qualifier}'") from exc

    if payload.action == "correct" and not (payload.corrected_text or corrected_qualifier):
        raise HTTPException(422, "A correction must supply corrected text or a corrected qualifier")

    review = DiagnosisReview(
        extraction_id=d.id,
        reviewer_id=actor.id,
        action=payload.action,
        corrected_text=payload.corrected_text,
        corrected_qualifier=corrected_qualifier,
        comment=payload.comment,
    )
    db.add(review)

    # The AI output is never overwritten. Only the workflow status moves, and only in the direction
    # a human chose.
    if payload.action == "reject":
        d.status = DiagnosisStatus.not_found if not d.raw_text else DiagnosisStatus.uncertain
        db.add(d)

    audit.record(
        db,
        actor_id=actor.id,
        action=f"diagnosis.review.{payload.action}",
        entity_type="diagnosis_extraction",
        entity_id=d.id,
        ip=request.client.host if request.client else None,
        meta={"had_correction": bool(payload.corrected_text)},
    )
    db.commit()
    # Objects survive the commit, and selectinload will not overwrite an already-loaded collection,
    # so without expiring first the response would report `is_reviewed: false` for the review that
    # was just written.
    db.expire_all()
    return _serialise(_load(db, extraction_id), db)
