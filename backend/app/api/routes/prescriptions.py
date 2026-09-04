"""Standalone prescription analyzer.

A deliberately different shape from the rest of this API: everywhere else, upload is a fire-and-
forget queue operation (a 35-page camera-photographed record must not hold a request open), and a
reviewer comes back later to see quality/handwriting/diagnosis results. Here, a prescription is
normally one or two pages and the whole point is "upload it, get the reading back" — so this route
runs ingest and the analysis synchronously in the same request instead of queuing background jobs.

It still goes through the same Document/LogicalPage/PageVersion tables as everything else (so the
same storage, retention and audit rules apply) via a single well-known Batch created on first use.
No Case is created — case_id is nullable and a prescription upload here has no patient/encounter
reference to attach.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core import audit
from app.core.rbac import current_user, require_uploader
from app.core.storage import get_storage, sha256_file
from app.db import get_db
from app.models import Batch, Document, PageVersion, User
from app.models.core import IngestStatus
from app.processing import ingest
from app.processing.providers.base import ProviderError, ProviderUnconfigured
from app.schemas.api import MedicineOut, PrescriptionOut, QualityOut, FindingOut
from app.services import ingest_service, pipeline

router = APIRouter(prefix="/prescriptions", tags=["prescriptions"])

_BATCH_NAME = "Prescription analyzer uploads"


def _get_or_create_batch(db: Session, actor_id: str) -> Batch:
    batch = db.execute(select(Batch).where(Batch.name == _BATCH_NAME)).scalar_one_or_none()
    if batch is None:
        batch = Batch(name=_BATCH_NAME, note="Auto-created for the standalone prescription analyzer.",
                      created_by=actor_id)
        db.add(batch)
        db.flush()
    return batch


def _quality_out(pv: PageVersion) -> QualityOut | None:
    if not pv.quality:
        return None
    return QualityOut(
        overall=pv.quality.overall.value,
        score=pv.quality.score,
        engine_version=pv.quality.engine_version,
        thresholds_hash=pv.quality.thresholds_hash,
        provider_used=pv.quality.provider_used,
        provider_error=pv.quality.provider_error,
        computed_at=pv.quality.computed_at,
        findings=[
            FindingOut(
                id=f.id, code=f.defect_code, label=f.defect_code, severity=f.severity.value,
                confidence=f.confidence, source=f.source, detail=f.detail, region=f.region_json,
            )
            for f in pv.quality.findings
        ],
    )


def _prescription_out(pv: PageVersion) -> PrescriptionOut | None:
    if not pv.prescription:
        return None
    p = pv.prescription
    return PrescriptionOut(
        status=p.status.value,
        language_detected=p.language_detected,
        raw_extracted_text=p.raw_extracted_text,
        diagnosis_or_notes=p.diagnosis_or_notes,
        possible_interpretation=p.possible_interpretation,
        patient_explanation=p.patient_explanation,
        medicines=[
            MedicineOut(
                name=m.name, dose=m.dose, frequency=m.frequency, duration=m.duration,
                general_use=m.general_use, confidence=m.confidence, uncertainty=m.uncertainty,
            )
            for m in p.medicines
        ],
        safety_warnings=list(p.safety_warnings_json or []),
        uncertainties=list(p.uncertainties_json or []),
        requires_professional_confirmation=p.requires_professional_confirmation,
        ocr_provider_used=p.ocr_provider_used,
        reasoning_provider_used=p.reasoning_provider_used,
        model_version=p.model_version,
        error=p.error,
        computed_at=p.computed_at,
    )


@router.post("/analyze")
async def analyze_prescription(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    """Upload one image/PDF and get its prescription reading back in the same response.

    Every page in the file is analysed (almost always one). A password-protected, corrupted or
    oversized file is rejected the same way the scan-QC uploader rejects it — with a specific
    reason, not a generic 500.
    """
    name = Path(file.filename or "prescription").name
    storage = get_storage()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(name).suffix) as tmp:
            tmp_path = tmp.name
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_mb * 1024 * 1024:
                    break
                tmp.write(chunk)

        try:
            ingest.validate_upload(name, size)
            page_count, _warnings = ingest.probe_container(tmp_path, name)
        except ingest.IngestRejected as exc:
            raise HTTPException(422, exc.message) from exc

        batch = _get_or_create_batch(db, actor.id)
        digest = sha256_file(tmp_path)

        doc = Document(
            batch_id=batch.id,
            case_id=None,
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
            db, actor_id=actor.id, action="prescription.upload", entity_type="document", entity_id=doc.id,
            ip=request.client.host if request.client else None,
            meta={"pages": page_count, "bytes": size},
        )
        db.commit()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(422, f"The file could not be accepted ({type(exc).__name__}).") from exc
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)

    # No background stages queued here (default_stages=[]) — quality and prescription both run
    # synchronously below, so the response is the finished result, not a "come back later" pointer.
    ingest_service.ingest_document(db, doc, default_stages=[])
    db.refresh(doc)

    pages_out = []
    for page in sorted(doc.pages, key=lambda p: p.ordinal):
        pv = page.active_version
        if pv is None:
            continue

        pipeline.run_quality(db, pv)
        db.commit()

        if settings.ocr_provider == "none" or settings.prescription_reasoning_provider == "none":
            pipeline.run_prescription(db, pv)  # writes the "unconfigured" result itself
        else:
            try:
                pipeline.run_prescription(db, pv)
            except (ProviderUnconfigured, ProviderError):
                # run_prescription already catches and records these; this is a last-resort net so a
                # transport error some layer forgot to catch still returns a result, not a 500.
                pass
        db.commit()
        db.refresh(pv)

        pages_out.append(
            {
                "page_version_id": pv.id,
                "ordinal": page.ordinal,
                "width": pv.width,
                "height": pv.height,
                "quality": _quality_out(pv),
                "prescription": _prescription_out(pv),
            }
        )

    return {
        "document_id": doc.id,
        "original_filename": doc.original_filename,
        "page_count": doc.page_count,
        "pages": pages_out,
    }


@router.get("/recent")
def recent_analyses(limit: int = 20, db: Session = Depends(get_db), _: User = Depends(current_user)):
    """The last few standalone uploads, so a user can find one again without re-uploading."""
    batch = db.execute(select(Batch).where(Batch.name == _BATCH_NAME)).scalar_one_or_none()
    if batch is None:
        return []
    docs = db.execute(
        select(Document)
        .where(Document.batch_id == batch.id)
        .order_by(Document.uploaded_at.desc())
        .limit(limit)
    ).scalars().all()
    return [
        {
            "document_id": d.id,
            "original_filename": d.original_filename,
            "uploaded_at": d.uploaded_at,
            "page_count": d.page_count,
            "ingest_status": d.ingest_status.value,
        }
        for d in docs
    ]


@router.get("/{document_id}")
def get_analysis(document_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    """Re-fetch a previous standalone analysis by document id."""
    doc = db.get(Document, document_id)
    if doc is None or doc.batch.name != _BATCH_NAME:
        raise HTTPException(404, "Analysis not found")

    pages_out = []
    for page in sorted(doc.pages, key=lambda p: p.ordinal):
        pv = page.active_version
        if pv is None:
            continue
        pages_out.append(
            {
                "page_version_id": pv.id,
                "ordinal": page.ordinal,
                "width": pv.width,
                "height": pv.height,
                "quality": _quality_out(pv),
                "prescription": _prescription_out(pv),
            }
        )

    return {
        "document_id": doc.id,
        "original_filename": doc.original_filename,
        "page_count": doc.page_count,
        "pages": pages_out,
    }
