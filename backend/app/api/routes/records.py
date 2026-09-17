"""Batches, cases and document upload.

The upload route deliberately does two things separately: it *stores and validates* synchronously,
so a clerk gets an immediate, specific rejection for a password-protected or oversized file, and it
*queues* the page splitting, so a 35-page camera-photographed file does not hold the request open.

Patient and encounter references are taken from the person uploading. Nothing here reads a
reference out of the page and merges two records on the strength of it.
"""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core import audit
from app.core.rbac import current_user, require_admin, require_uploader
from app.core.storage import get_storage, sha256_file
from app.db import get_db
from app.models import (
    Batch,
    Case,
    Checklist,
    Document,
    Job,
    LogicalPage,
    PageReview,
    PageVersion,
    QualityResult,
    User,
)
from app.models.core import IngestStatus, JobState, PageClass

# The classes that put a page in front of a reviewer.
#
# Must stay identical to `_NEEDS_REVIEW_CLASSES` in services/query.py, which is what the dashboard's
# "awaiting review" figure and the `review_state=pending` page filter both use. `failed` is
# deliberately NOT in here: a page the engine could not measure is unmeasured, not un-reviewed, and
# counting it as outstanding review work would inflate the queue with pages a reviewer cannot act on.
_NEEDS_REVIEW = (PageClass.review, PageClass.rescan)
from app.processing import ingest
from app.schemas.api import BatchIn, BatchOut, CaseIn, CaseOut, CasePatch, UploadResult
from app.services import completeness as completeness_service
from app.services import ingest_service

router = APIRouter(tags=["records"])


# ------------------------------------------------------------------ batches


@router.get("/batches", response_model=list[BatchOut])
def list_batches(q: str | None = None, db: Session = Depends(get_db), _: User = Depends(current_user)):
    stmt = select(Batch).order_by(Batch.created_at.desc())
    if q:
        stmt = stmt.where(Batch.name.ilike(f"%{q}%"))
    out = []
    for b in db.execute(stmt).scalars():
        doc_count = db.execute(
            select(func.count(Document.id)).where(Document.batch_id == b.id)
        ).scalar() or 0
        page_count = db.execute(
            select(func.count(PageVersion.id))
            .join(LogicalPage, LogicalPage.id == PageVersion.logical_page_id)
            .join(Document, Document.id == LogicalPage.document_id)
            .where(Document.batch_id == b.id, PageVersion.is_active.is_(True))
        ).scalar() or 0
        out.append(
            BatchOut(
                id=b.id, name=b.name, note=b.note, created_at=b.created_at,
                document_count=doc_count, page_count=page_count,
            )
        )
    return out


@router.post("/batches", response_model=BatchOut, status_code=201)
def create_batch(payload: BatchIn, db: Session = Depends(get_db), actor: User = Depends(require_uploader)):
    batch = Batch(name=payload.name.strip(), note=payload.note, created_by=actor.id)
    db.add(batch)
    db.flush()
    audit.record(db, actor_id=actor.id, action="batch.create", entity_type="batch", entity_id=batch.id)
    db.commit()
    return BatchOut(id=batch.id, name=batch.name, note=batch.note, created_at=batch.created_at)


@router.get("/batches/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    b = db.get(Batch, batch_id)
    if not b:
        raise HTTPException(404, "Batch not found")
    return BatchOut(id=b.id, name=b.name, note=b.note, created_at=b.created_at)


# -------------------------------------------------------------------- cases


def case_out(
    case: Case,
    document_count: int = 0,
    page_count: int = 0,
    first_page_version_id: str | None = None,
    documents_pending: int = 0,
    pages_measured: int = 0,
    jobs_active: int = 0,
    ingest_failed: int = 0,
) -> CaseOut:
    """The one place a Case becomes a CaseOut.

    Built as a helper rather than spelled out at each return site on purpose: this response has
    grown a dozen intake fields, and hand-listing them per endpoint is precisely how a field ends
    up silently missing from one response and blank in the UI.
    """
    return CaseOut(
        id=case.id,
        batch_id=case.batch_id,
        patient_ref=case.patient_ref,
        encounter_ref=case.encounter_ref,
        checklist_id=case.checklist_id,
        confirmed_by=case.confirmed_by,
        confirmed_at=case.confirmed_at,
        document_count=document_count,
        patient_name=case.patient_name,
        department=case.department,
        mobile=case.mobile,
        disease=case.disease,
        icd_code=case.icd_code,
        consultant_name=case.consultant_name,
        discharge_type=case.discharge_type,
        mlc_type=case.mlc_type,
        admission_date=case.admission_date,
        discharge_date=case.discharge_date,
        record_date=case.record_date,
        created_at=case.created_at,
        page_count=page_count,
        first_page_version_id=first_page_version_id,
        documents_pending=documents_pending,
        pages_measured=pages_measured,
        jobs_active=jobs_active,
        ingest_failed=ingest_failed,
    )


def _case_detail(db: Session, case: Case) -> CaseOut:
    """One case's counts. The list does this in aggregate; this is the single-row version."""
    docs = list(db.execute(select(Document).where(Document.case_id == case.id)).scalars())
    doc_ids = [d.id for d in docs]

    pending = sum(1 for d in docs if d.ingest_status in (IngestStatus.pending, IngestStatus.running))
    failed = sum(
        1
        for d in docs
        if d.ingest_status
        in (
            IngestStatus.failed,
            IngestStatus.rejected,
            IngestStatus.corrupted,
            IngestStatus.password_protected,
        )
    )

    pages = 0
    measured = 0
    first_pv: str | None = None
    jobs = 0
    if doc_ids:
        rows = db.execute(
            select(PageVersion.id, LogicalPage.ordinal, Document.uploaded_at)
            .join(LogicalPage, LogicalPage.id == PageVersion.logical_page_id)
            .join(Document, Document.id == LogicalPage.document_id)
            .where(Document.id.in_(doc_ids), PageVersion.is_active.is_(True))
            .order_by(Document.uploaded_at.asc(), LogicalPage.ordinal.asc())
        ).all()
        pages = len(rows)
        if rows:
            first_pv = rows[0][0]
        measured = (
            db.execute(
                select(func.count(QualityResult.id))
                .join(PageVersion, PageVersion.id == QualityResult.page_version_id)
                .join(LogicalPage, LogicalPage.id == PageVersion.logical_page_id)
                .where(LogicalPage.document_id.in_(doc_ids), PageVersion.is_active.is_(True))
            ).scalar()
            or 0
        )
        jobs = (
            db.execute(
                select(func.count(Job.id)).where(
                    Job.document_id.in_(doc_ids),
                    Job.state.in_([JobState.queued, JobState.running]),
                )
            ).scalar()
            or 0
        )

    return case_out(case, len(docs), pages, first_pv, pending, measured, jobs, failed)


def _cases_stmt(batch_id, patient_ref, encounter_ref, created_from, created_to):
    stmt = select(Case).order_by(Case.created_at.desc())
    if batch_id:
        stmt = stmt.where(Case.batch_id == batch_id)
    if patient_ref:
        stmt = stmt.where(Case.patient_ref.ilike(f"%{patient_ref}%"))
    if encounter_ref:
        stmt = stmt.where(Case.encounter_ref.ilike(f"%{encounter_ref}%"))
    # Entry-time window. The client converts its local day/time to UTC instants, so "records
    # entered on the 17th" means the clerk's 17th, not the server's.
    if created_from:
        stmt = stmt.where(Case.created_at >= created_from)
    if created_to:
        stmt = stmt.where(Case.created_at <= created_to)
    return stmt


@router.get("/cases", response_model=list[CaseOut])
def list_cases(
    batch_id: str | None = None,
    patient_ref: str | None = None,
    encounter_ref: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    stmt = _cases_stmt(batch_id, patient_ref, encounter_ref, created_from, created_to)
    return _serialise_cases(db, list(db.execute(stmt).scalars()))


@router.get("/cases/paged")
def list_cases_paged(
    batch_id: str | None = None,
    patient_ref: str | None = None,
    encounter_ref: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    """One page of patient records plus the total matching and the total in the database, so the
    list screen never loads the whole archive at once."""
    stmt = _cases_stmt(batch_id, patient_ref, encounter_ref, created_from, created_to)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    grand_total = db.execute(select(func.count(Case.id))).scalar() or 0
    cases = list(db.execute(stmt.limit(limit).offset(offset)).scalars())
    return {
        "items": [c.model_dump() for c in _serialise_cases(db, cases)],
        "total": total,
        "grand_total": grand_total,
        "limit": limit,
        "offset": offset,
    }


def _serialise_cases(db: Session, cases: list[Case]) -> list[CaseOut]:
    if not cases:
        return []

    ids = [c.id for c in cases]

    # Two aggregate queries for the whole list rather than two per row: this screen is the one a
    # records clerk lives in, and it grows with the archive.
    doc_counts = dict(
        db.execute(
            select(Document.case_id, func.count(Document.id))
            .where(Document.case_id.in_(ids))
            .group_by(Document.case_id)
        ).all()
    )

    # Documents the ingest has not finished with, and the ones it refused outright. A record whose
    # file is still being rasterised has no pages yet, and saying nothing about that is how a row
    # reads as "empty" when it is really "not done".
    pending_counts = dict(
        db.execute(
            select(Document.case_id, func.count(Document.id))
            .where(
                Document.case_id.in_(ids),
                Document.ingest_status.in_([IngestStatus.pending, IngestStatus.running]),
            )
            .group_by(Document.case_id)
        ).all()
    )
    failed_counts = dict(
        db.execute(
            select(Document.case_id, func.count(Document.id))
            .where(
                Document.case_id.in_(ids),
                Document.ingest_status.in_(
                    [
                        IngestStatus.failed,
                        IngestStatus.rejected,
                        IngestStatus.corrupted,
                        IngestStatus.password_protected,
                    ]
                ),
            )
            .group_by(Document.case_id)
        ).all()
    )

    # Pages the quality engine has actually measured, and work still queued or running for this
    # record's documents.
    measured_counts = dict(
        db.execute(
            select(Document.case_id, func.count(QualityResult.id))
            .join(LogicalPage, LogicalPage.document_id == Document.id)
            .join(PageVersion, PageVersion.logical_page_id == LogicalPage.id)
            .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
            .where(Document.case_id.in_(ids), PageVersion.is_active.is_(True))
            .group_by(Document.case_id)
        ).all()
    )
    job_counts = dict(
        db.execute(
            select(Document.case_id, func.count(Job.id))
            .join(Job, Job.document_id == Document.id)
            .where(
                Document.case_id.in_(ids),
                Job.state.in_([JobState.queued, JobState.running]),
            )
            .group_by(Document.case_id)
        ).all()
    )

    page_rows = db.execute(
        select(
            Document.case_id,
            PageVersion.id,
            LogicalPage.ordinal,
            Document.uploaded_at,
        )
        .join(LogicalPage, LogicalPage.document_id == Document.id)
        .join(PageVersion, PageVersion.logical_page_id == LogicalPage.id)
        .where(Document.case_id.in_(ids), PageVersion.is_active.is_(True))
        .order_by(Document.uploaded_at.asc(), LogicalPage.ordinal.asc())
    ).all()

    page_counts: dict[str, int] = {}
    first_page: dict[str, str] = {}
    for case_id, pv_id, _ordinal, _uploaded in page_rows:
        page_counts[case_id] = page_counts.get(case_id, 0) + 1
        # Ordered above, so the first row seen for a case is its first page.
        first_page.setdefault(case_id, pv_id)

    return [
        case_out(
            c,
            doc_counts.get(c.id, 0),
            page_counts.get(c.id, 0),
            first_page.get(c.id),
            pending_counts.get(c.id, 0),
            measured_counts.get(c.id, 0),
            job_counts.get(c.id, 0),
            failed_counts.get(c.id, 0),
        )
        for c in cases
    ]


@router.get("/cases/{case_id}", response_model=CaseOut)
def get_case(case_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    """One patient record, with the same counts the list shows."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    return _case_detail(db, case)


@router.post("/cases", response_model=CaseOut, status_code=201)
def create_case(payload: CaseIn, db: Session = Depends(get_db), actor: User = Depends(require_uploader)):
    if not db.get(Batch, payload.batch_id):
        raise HTTPException(404, "Batch not found")
    encounter = payload.encounter_ref.strip()
    if not encounter:
        raise HTTPException(422, "An encounter reference is required. It is never inferred from the scan.")

    existing = db.execute(
        select(Case).where(Case.batch_id == payload.batch_id, Case.encounter_ref == encounter)
    ).scalar_one_or_none()
    if existing:
        return case_out(existing)

    case = Case(
        batch_id=payload.batch_id,
        patient_ref=payload.patient_ref.strip(),
        encounter_ref=encounter,
        checklist_id=payload.checklist_id,
    )
    db.add(case)
    db.flush()
    audit.record(db, actor_id=actor.id, action="case.create", entity_type="case", entity_id=case.id)
    db.commit()
    return case_out(case)


@router.patch("/cases/{case_id}", response_model=CaseOut)
def update_case(
    case_id: str,
    payload: CasePatch,
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    """Correct the details on a patient record.

    Only the fields actually sent are written — `exclude_unset` rather than a blanket assignment —
    so an edit form that touches one value cannot quietly blank the eleven it did not show. The MR
    and IPD numbers are not editable here: they identify the case, and rewriting an identity in
    place is how one patient's pages end up filed under another's.
    """
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return case_out(case)

    admitted = changes.get("admission_date", case.admission_date)
    discharged = changes.get("discharge_date", case.discharge_date)
    if admitted and discharged and discharged < admitted:
        raise HTTPException(422, "The discharge date is before the admission date. Check both dates.")

    # A checklist that does not exist would leave the case pointing at nothing and the completeness
    # panel silently reporting "not verified" forever — the exact failure this field exists to fix.
    if changes.get("checklist_id") and not db.get(Checklist, changes["checklist_id"]):
        raise HTTPException(404, "Checklist not found")

    for field, value in changes.items():
        setattr(case, field, value)

    # The audit records which fields moved, never the patient text that moved into them.
    audit.record(
        db,
        actor_id=actor.id,
        action="case.update",
        entity_type="case",
        entity_id=case.id,
        meta={"fields": sorted(changes.keys())},
    )
    db.add(case)
    db.commit()
    db.refresh(case)
    count = db.execute(select(func.count(Document.id)).where(Document.case_id == case.id)).scalar() or 0
    return case_out(case, count)


@router.delete("/cases/{case_id}", status_code=204)
def delete_case(case_id: str, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    """Delete a patient record and everything filed under it.

    Admin only, and genuinely destructive: the case's documents, their pages, every scan version
    and every analysis go with it. The stored files are left to the same storage sweep that
    handles a deleted document, so this endpoint never removes bytes it did not record removing.
    """
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")

    doc_ids = [
        d.id for d in db.execute(select(Document).where(Document.case_id == case.id)).scalars()
    ]
    audit.record(
        db,
        actor_id=actor.id,
        action="case.delete",
        entity_type="case",
        entity_id=case.id,
        meta={"documents": len(doc_ids), "encounter_ref": case.encounter_ref},
    )
    db.delete(case)
    db.commit()


@router.patch("/cases/{case_id}/confirm", response_model=CaseOut)
def confirm_case(case_id: str, db: Session = Depends(get_db), actor: User = Depends(require_uploader)):
    """Record that a human checked the patient/encounter reference against the paper file."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    case.confirmed_by = actor.id
    case.confirmed_at = datetime.now(timezone.utc)
    db.add(case)
    audit.record(db, actor_id=actor.id, action="case.confirm", entity_type="case", entity_id=case.id)
    db.commit()
    return case_out(case)


@router.get("/cases/{case_id}/completeness")
def case_completeness(case_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    from app.models import CompletenessResult

    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    result = db.execute(
        select(CompletenessResult).where(CompletenessResult.case_id == case_id)
    ).scalar_one_or_none()
    # The case's own checklist_id rides along even when nothing has been computed yet. Otherwise
    # the only way to know which checklist a case is attached to is to have already assessed it,
    # and the control for attaching one could never show its current value.
    return {**completeness_service.summarise(result), "checklist_id": case.checklist_id}


@router.post("/cases/{case_id}/completeness/recompute")
def recompute_completeness(case_id: str, db: Session = Depends(get_db), actor: User = Depends(require_uploader)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    result = completeness_service.compute(db, case)
    audit.record(db, actor_id=actor.id, action="completeness.recompute", entity_type="case", entity_id=case_id)
    db.commit()
    return completeness_service.summarise(result)


# ---------------------------------------------------------------- documents


@router.post("/documents/upload", response_model=list[UploadResult])
async def upload(
    request: Request,
    files: list[UploadFile] = File(...),
    batch_id: str = Form(...),
    case_id: str | None = Form(None),
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    if not db.get(Batch, batch_id):
        raise HTTPException(404, "Batch not found")
    if case_id and not db.get(Case, case_id):
        raise HTTPException(404, "Case not found")

    storage = get_storage()
    results: list[UploadResult] = []

    for upload_file in files:
        name = Path(upload_file.filename or "unnamed").name
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=Path(name).suffix) as tmp:
                tmp_path = tmp.name
                size = 0
                while chunk := await upload_file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_mb * 1024 * 1024:
                        break
                    tmp.write(chunk)

            try:
                ingest.validate_upload(name, size)
                page_count, _ = ingest.probe_container(tmp_path, name)
            except ingest.IngestRejected as exc:
                results.append(UploadResult(filename=name, document_id=None, status="rejected",
                                            message=exc.message))
                continue

            digest = sha256_file(tmp_path)
            duplicate = db.execute(
                select(Document).where(Document.sha256 == digest, Document.batch_id == batch_id)
            ).scalar_one_or_none()
            if duplicate:
                results.append(
                    UploadResult(
                        filename=name,
                        document_id=duplicate.id,
                        status="duplicate",
                        message="An identical file is already in this batch; it was not added again.",
                        page_count=duplicate.page_count,
                    )
                )
                continue

            doc = Document(
                batch_id=batch_id,
                case_id=case_id,
                original_filename=name,
                sha256=digest,
                mime=ingest.sniff_stream_mime(name),
                byte_size=size,
                page_count=page_count,
                uploaded_by=actor.id,
                ingest_status=IngestStatus.pending,
                storage_key_original="",
            )
            db.add(doc)
            db.flush()

            key = ingest_service.original_key(doc.id, name)
            with open(tmp_path, "rb") as fh:
                storage.put_stream(key, fh)
            doc.storage_key_original = key
            db.add(doc)

            audit.record(
                db, actor_id=actor.id, action="document.upload", entity_type="document",
                entity_id=doc.id,
                ip=request.client.host if request.client else None,
                meta={"pages": page_count, "bytes": size, "batch_id": batch_id},
            )
            db.commit()

            job_id = ingest_service.queue_ingest(db, doc)
            results.append(
                UploadResult(filename=name, document_id=doc.id, status="accepted",
                             message="Queued for processing.", page_count=page_count, job_id=job_id)
            )
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            results.append(
                UploadResult(filename=name, document_id=None, status="rejected",
                             message=f"The file could not be accepted ({type(exc).__name__}).")
            )
        finally:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)

    return results


_EMPTY_ROLLUP: dict[str, object] = {
    "pages_active": 0,
    "awaiting_review": 0,
    "page_class_counts": {},
}


def _document_has_open_page():
    """A page that is in a class needing a look and that no reviewer has closed.

    Deliberately the same definition as `services/query.py`'s `review_state == "pending"`, so the
    file list and the page list cannot disagree about what is outstanding.
    """
    closing = ("accept", "request_rescan")
    closed = (
        select(PageReview.id)
        .where(
            PageReview.page_version_id == PageVersion.id,
            PageReview.action.in_(closing),
        )
        .exists()
    )
    return (
        select(PageVersion.id)
        .join(LogicalPage, LogicalPage.id == PageVersion.logical_page_id)
        .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .where(
            LogicalPage.document_id == Document.id,
            PageVersion.is_active.is_(True),
            QualityResult.overall.in_(_NEEDS_REVIEW),
            ~closed,
        )
        .exists()
    )


def _document_rollups(db: Session, doc_ids: list[str]) -> dict[str, dict]:
    """Active page counts, class breakdown and outstanding review count, per document.

    Three aggregate queries for the whole page of results rather than three per row.
    """
    if not doc_ids:
        return {}

    out: dict[str, dict] = {
        d: {"pages_active": 0, "awaiting_review": 0, "page_class_counts": {}} for d in doc_ids
    }

    class_rows = db.execute(
        select(LogicalPage.document_id, QualityResult.overall, func.count(PageVersion.id))
        .join(PageVersion, PageVersion.logical_page_id == LogicalPage.id)
        .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .where(LogicalPage.document_id.in_(doc_ids), PageVersion.is_active.is_(True))
        .group_by(LogicalPage.document_id, QualityResult.overall)
    ).all()
    for doc_id, overall, count in class_rows:
        key = overall.value if hasattr(overall, "value") else str(overall)
        out[doc_id]["page_class_counts"][key] = count

    active_rows = db.execute(
        select(LogicalPage.document_id, func.count(PageVersion.id))
        .join(PageVersion, PageVersion.logical_page_id == LogicalPage.id)
        .where(LogicalPage.document_id.in_(doc_ids), PageVersion.is_active.is_(True))
        .group_by(LogicalPage.document_id)
    ).all()
    for doc_id, count in active_rows:
        out[doc_id]["pages_active"] = count

    closed = (
        select(PageReview.id)
        .where(
            PageReview.page_version_id == PageVersion.id,
            PageReview.action.in_(("accept", "request_rescan")),
        )
        .exists()
    )
    open_rows = db.execute(
        select(LogicalPage.document_id, func.count(PageVersion.id))
        .join(PageVersion, PageVersion.logical_page_id == LogicalPage.id)
        .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .where(
            LogicalPage.document_id.in_(doc_ids),
            PageVersion.is_active.is_(True),
            QualityResult.overall.in_(_NEEDS_REVIEW),
            ~closed,
        )
        .group_by(LogicalPage.document_id)
    ).all()
    for doc_id, count in open_rows:
        out[doc_id]["awaiting_review"] = count

    return out


@router.get("/documents")
def list_documents(
    batch_id: str | None = None,
    case_id: str | None = None,
    status: str | None = None,
    q: str | None = None,
    needs_review: bool = False,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    """The uploaded files, with a roll-up of what is inside each one.

    The roll-up exists so a reviewer can work a file at a time. A queue that interleaves page 7 of
    one patient's discharge summary with page 2 of another's case sheet asks a person to change
    context on every row; grouping by the document they were scanned from is how the paper was
    handled in the first place.

    `needs_review=true` narrows to files that still have a page nobody has closed — the same
    definition the dashboard's "awaiting review" figure uses, so the two never disagree.
    """
    stmt = select(Document).order_by(Document.uploaded_at.desc())
    if batch_id:
        stmt = stmt.where(Document.batch_id == batch_id)
    if case_id:
        stmt = stmt.where(Document.case_id == case_id)
    if status:
        stmt = stmt.where(Document.ingest_status == IngestStatus(status))
    if q:
        stmt = stmt.where(Document.original_filename.ilike(f"%{q}%"))
    if needs_review:
        stmt = stmt.where(_document_has_open_page())

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(stmt.limit(limit).offset(offset)).scalars().all()
    rollups = _document_rollups(db, [d.id for d in rows])
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [
            {
                "id": d.id,
                "batch_id": d.batch_id,
                "batch_name": d.batch.name if d.batch else None,
                "case_id": d.case_id,
                "patient_ref": d.case.patient_ref if d.case else None,
                "encounter_ref": d.case.encounter_ref if d.case else None,
                "original_filename": d.original_filename,
                "mime": d.mime,
                "page_count": d.page_count,
                "byte_size": d.byte_size,
                "uploaded_at": d.uploaded_at,
                "uploaded_by": d.uploaded_by,
                "ingest_status": d.ingest_status.value,
                "ingest_error": d.ingest_error,
                **rollups.get(d.id, _EMPTY_ROLLUP),
            }
            for d in rows
        ],
    }


@router.get("/documents/{document_id}")
def get_document(document_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    pages = []
    for page in sorted(doc.pages, key=lambda p: p.ordinal):
        av = page.active_version
        pages.append(
            {
                "logical_page_id": page.id,
                "ordinal": page.ordinal,
                "printed_page_label": page.printed_page_label,
                "active_version_id": av.id if av else None,
                "version_count": len(page.versions),
                "page_class": av.quality.overall.value if (av and av.quality) else "unchecked",
            }
        )
    return {
        "id": doc.id,
        "batch_id": doc.batch_id,
        "batch_name": doc.batch.name if doc.batch else None,
        "case_id": doc.case_id,
        "patient_ref": doc.case.patient_ref if doc.case else None,
        "encounter_ref": doc.case.encounter_ref if doc.case else None,
        "original_filename": doc.original_filename,
        "mime": doc.mime,
        "page_count": doc.page_count,
        "byte_size": doc.byte_size,
        "sha256": doc.sha256,
        "uploaded_at": doc.uploaded_at,
        "uploaded_by": doc.uploaded_by,
        "ingest_status": doc.ingest_status.value,
        "ingest_error": doc.ingest_error,
        "pages": pages,
    }


@router.get("/documents/{document_id}/file")
def document_file(document_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Stream the original upload — the PDF exactly as it arrived.

    Audited, unlike the page-image routes: this hands over the whole document rather than one
    rendered page, and who read a patient's file is worth being able to answer.

    Served inline so the browser's own PDF viewer can open it, with `no-store` so a shared
    workstation does not leave a patient's record in the disk cache.
    """
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    if not doc.storage_key_original:
        raise HTTPException(404, "The original file for this document is no longer stored")

    storage = get_storage()
    if not storage.exists(doc.storage_key_original):
        raise HTTPException(404, "The original file for this document is no longer stored")

    audit.record(
        db,
        actor_id=user.id,
        action="document.file.view",
        entity_type="document",
        entity_id=doc.id,
    )
    db.commit()

    data = storage.get_bytes(doc.storage_key_original)
    filename = doc.original_filename.replace('"', "") or "document"
    return Response(
        content=data,
        media_type=doc.mime or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: str, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    audit.record(db, actor_id=actor.id, action="document.delete", entity_type="document", entity_id=doc.id,
                 meta={"pages": doc.page_count})
    db.delete(doc)
    db.commit()
