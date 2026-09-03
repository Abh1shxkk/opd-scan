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

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.core import audit
from app.core.rbac import current_user, require_admin, require_uploader
from app.core.storage import get_storage, sha256_file
from app.db import get_db
from app.models import Batch, Case, Document, LogicalPage, PageVersion, User
from app.models.core import IngestStatus
from app.processing import ingest
from app.schemas.api import BatchIn, BatchOut, CaseIn, CaseOut, UploadResult
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


@router.get("/cases", response_model=list[CaseOut])
def list_cases(
    batch_id: str | None = None,
    patient_ref: str | None = None,
    encounter_ref: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    stmt = select(Case).order_by(Case.created_at.desc())
    if batch_id:
        stmt = stmt.where(Case.batch_id == batch_id)
    if patient_ref:
        stmt = stmt.where(Case.patient_ref.ilike(f"%{patient_ref}%"))
    if encounter_ref:
        stmt = stmt.where(Case.encounter_ref.ilike(f"%{encounter_ref}%"))
    out = []
    for c in db.execute(stmt).scalars():
        count = db.execute(select(func.count(Document.id)).where(Document.case_id == c.id)).scalar() or 0
        out.append(
            CaseOut(
                id=c.id, batch_id=c.batch_id, patient_ref=c.patient_ref, encounter_ref=c.encounter_ref,
                checklist_id=c.checklist_id, confirmed_by=c.confirmed_by, confirmed_at=c.confirmed_at,
                document_count=count,
            )
        )
    return out


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
        return CaseOut(
            id=existing.id, batch_id=existing.batch_id, patient_ref=existing.patient_ref,
            encounter_ref=existing.encounter_ref, checklist_id=existing.checklist_id,
            confirmed_by=existing.confirmed_by, confirmed_at=existing.confirmed_at,
        )

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
    return CaseOut(
        id=case.id, batch_id=case.batch_id, patient_ref=case.patient_ref, encounter_ref=case.encounter_ref,
        checklist_id=case.checklist_id, confirmed_by=None, confirmed_at=None,
    )


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
    return CaseOut(
        id=case.id, batch_id=case.batch_id, patient_ref=case.patient_ref, encounter_ref=case.encounter_ref,
        checklist_id=case.checklist_id, confirmed_by=case.confirmed_by, confirmed_at=case.confirmed_at,
    )


@router.get("/cases/{case_id}/completeness")
def case_completeness(case_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    from app.models import CompletenessResult

    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    result = db.execute(
        select(CompletenessResult).where(CompletenessResult.case_id == case_id)
    ).scalar_one_or_none()
    return completeness_service.summarise(result)


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


@router.get("/documents")
def list_documents(
    batch_id: str | None = None,
    case_id: str | None = None,
    status: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    stmt = select(Document).order_by(Document.uploaded_at.desc())
    if batch_id:
        stmt = stmt.where(Document.batch_id == batch_id)
    if case_id:
        stmt = stmt.where(Document.case_id == case_id)
    if status:
        stmt = stmt.where(Document.ingest_status == IngestStatus(status))
    if q:
        stmt = stmt.where(Document.original_filename.ilike(f"%{q}%"))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
    rows = db.execute(stmt.limit(limit).offset(offset)).scalars().all()
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


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: str, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    audit.record(db, actor_id=actor.id, action="document.delete", entity_type="document", entity_id=doc.id,
                 meta={"pages": doc.page_count})
    db.delete(doc)
    db.commit()
