"""Patient intake — one screen, one submit.

The batch/case/upload flow in records.py is built for bulk scanning: create a batch, create a case,
then push files at it. That is the right shape for a clerk working through a trolley of case files,
and the wrong shape for the counter workflow this route serves, where someone has one patient's
paperwork in front of them and needs to record who it belongs to and attach the PDFs in a single
action.

So this route takes the whole form plus the files in one request, and does the bookkeeping itself:

* the Batch is an implementation detail here. Documents must belong to one, but the intake user has
  no concept of batches, so a single well-known batch is created on first use and reused forever —
  the same approach the standalone prescription analyzer takes.
* the Case is looked up by IPD number and reused if it already exists, so uploading a second file
  for the same admission adds to that admission rather than creating a duplicate record.
* files go through exactly the same validation, storage and ingest queue as the batch uploader.
  Nothing about scanning, quality checking or OCR is special-cased for intake.

The form fields are transcribed by a human from the paper record. Nothing here infers, corrects or
back-fills a value from the scan — an unfilled field stays empty, and means "not recorded".
"""

from __future__ import annotations

import tempfile
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes.records import case_out
from app.config import settings
from app.core import audit
from app.core.rbac import current_user, require_uploader
from app.core.storage import get_storage, sha256_file
from app.db import get_db
from app.models import Batch, Case, Document, User
from app.models.core import IngestStatus
from app.processing import ingest
from app.schemas.api import IntakeLookupOut, IntakeOptionsOut, IntakeOut, UploadResult
from app.services import ingest_service, settings_store

router = APIRouter(prefix="/intake", tags=["intake"])

_BATCH_NAME = "Patient record intake"

# Seeded on first read and editable by an admin afterwards. These are starting points, not a
# clinical vocabulary — every site will want its own department list, and the discharge/MLC values
# follow Indian hospital records practice (DAMA/LAMA are recorded distinctly from a normal
# discharge because they mean something different on a medico-legal file).
_DEFAULT_OPTIONS: dict[str, list[str]] = {
    "departments": [
        "General Medicine", "General Surgery", "Orthopaedics", "Paediatrics",
        "Obstetrics & Gynaecology", "ENT", "Ophthalmology", "Dermatology",
        "Psychiatry", "Cardiology", "Neurology", "Nephrology", "Oncology",
        "Radiology", "Emergency", "ICU",
    ],
    "discharge_types": [
        "Normal / Recovered", "Referred", "DAMA (Discharge Against Medical Advice)",
        "LAMA (Left Against Medical Advice)", "Absconded", "Transferred", "Death",
    ],
    "mlc_types": [
        "Not MLC", "Road Traffic Accident", "Assault", "Poisoning", "Burn",
        "Fall / Injury", "Snake Bite", "Suicide Attempt", "Other MLC",
    ],
}

_OPTIONS_KEY = "intake.options"


def _get_or_create_batch(db: Session, actor_id: str) -> Batch:
    batch = db.execute(select(Batch).where(Batch.name == _BATCH_NAME)).scalar_one_or_none()
    if batch is None:
        batch = Batch(
            name=_BATCH_NAME,
            note="Auto-created for the patient intake screen. Not managed by hand.",
            created_by=actor_id,
        )
        db.add(batch)
        db.flush()
    return batch


def _options(db: Session) -> dict[str, list[str]]:
    stored = settings_store.get_json(db, _OPTIONS_KEY) or {}
    # Merge rather than replace: a stored payload missing a key (older row, partial edit) still
    # yields a usable dropdown instead of an empty one.
    return {key: list(stored.get(key) or default) for key, default in _DEFAULT_OPTIONS.items()}


@router.get("/options", response_model=IntakeOptionsOut)
def intake_options(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """Dropdown values for the intake form."""
    return IntakeOptionsOut(**_options(db))


@router.get("/lookup", response_model=IntakeLookupOut)
def lookup_mr(mr_number: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
    """The most recent intake for an MR number, so a returning patient's details can be prefilled.

    Prefilling is a convenience for the clerk, never an assertion: the values land in editable
    fields and are saved only if the person submitting the form leaves them there.
    """
    mr = mr_number.strip()
    if not mr:
        return IntakeLookupOut(found=False)

    case = db.execute(
        select(Case).where(Case.patient_ref == mr).order_by(Case.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    if case is None:
        return IntakeLookupOut(found=False)
    return IntakeLookupOut(found=True, case=case_out(case))


@router.post("", response_model=IntakeOut)
async def create_intake(
    request: Request,
    files: list[UploadFile] = File(default_factory=list),
    mr_number: str = Form(...),
    ipd_number: str = Form(""),
    patient_name: str = Form(""),
    department: str = Form(""),
    mobile: str = Form(""),
    disease: str = Form(""),
    icd_code: str = Form(""),
    consultant_name: str = Form(""),
    discharge_type: str = Form(""),
    mlc_type: str = Form(""),
    admission_date: str = Form(""),
    discharge_date: str = Form(""),
    record_date: str = Form(""),
    db: Session = Depends(get_db),
    actor: User = Depends(require_uploader),
):
    """Record a patient's details and attach their documents in one submit."""
    mr = mr_number.strip()
    if not mr:
        raise HTTPException(422, "An MR number is required. It is never inferred from the documents.")

    # The IPD number identifies the admission and is what a case is keyed on. When it is blank —
    # an OPD visit with no admission number — the MR number stands in, which keeps every case
    # addressable without inventing an admission number that the hospital never issued.
    encounter = ipd_number.strip() or mr

    admitted = _parse_date(admission_date, "date of admission")
    discharged = _parse_date(discharge_date, "date of discharge")
    recorded = _parse_date(record_date, "record date")
    if admitted and discharged and discharged < admitted:
        raise HTTPException(422, "The discharge date is before the admission date. Check both dates.")

    batch = _get_or_create_batch(db, actor.id)

    case = db.execute(
        select(Case).where(Case.batch_id == batch.id, Case.encounter_ref == encounter)
    ).scalar_one_or_none()
    created_case = case is None
    if case is None:
        case = Case(batch_id=batch.id, patient_ref=mr, encounter_ref=encounter)
        db.add(case)

    # An existing case is updated from the form, but only field by field and only where the form
    # actually carries a value: re-uploading a file with a half-filled form must not blank out
    # details a colleague recorded earlier.
    case.patient_ref = mr
    _set_if_given(case, "patient_name", patient_name)
    _set_if_given(case, "department", department)
    _set_if_given(case, "mobile", mobile)
    _set_if_given(case, "disease", disease)
    _set_if_given(case, "icd_code", icd_code)
    _set_if_given(case, "consultant_name", consultant_name)
    _set_if_given(case, "discharge_type", discharge_type)
    _set_if_given(case, "mlc_type", mlc_type)
    if admitted:
        case.admission_date = admitted
    if discharged:
        case.discharge_date = discharged
    # Defaults to today only when the clerk left it alone; an entered value is never overwritten.
    if recorded:
        case.record_date = recorded
    elif created_case and case.record_date is None:
        case.record_date = date.today()

    db.add(case)
    db.flush()

    audit.record(
        db,
        actor_id=actor.id,
        action="intake.case.create" if created_case else "intake.case.update",
        entity_type="case",
        entity_id=case.id,
        ip=request.client.host if request.client else None,
        meta={"files": len(files)},
    )
    db.commit()

    results = [
        await _store_one(db, upload_file, batch_id=batch.id, case_id=case.id, actor=actor, request=request)
        for upload_file in files
    ]

    db.refresh(case)
    return IntakeOut(case=case_out(case, document_count=len(case.documents)), documents=results)


def _set_if_given(case: Case, field: str, value: str) -> None:
    cleaned = value.strip()
    if cleaned:
        setattr(case, field, cleaned)


def _parse_date(raw: str, label: str) -> date | None:
    """Accept an empty field, reject a malformed one.

    A date that cannot be read is refused outright rather than stored as today or as null: on a
    discharge record the difference between "not recorded" and "recorded wrongly" matters, and a
    clerk who mistyped should be told at once, while the paper file is still in front of them.
    """
    value = raw.strip()
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(422, f"Could not read the {label} ('{value}'). Expected YYYY-MM-DD.") from None


async def _store_one(
    db: Session,
    upload_file: UploadFile,
    *,
    batch_id: str,
    case_id: str,
    actor: User,
    request: Request,
) -> UploadResult:
    """Validate, store and queue one uploaded file. Mirrors records.upload's per-file handling."""
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
            return UploadResult(filename=name, document_id=None, status="rejected", message=exc.message)

        digest = sha256_file(tmp_path)
        duplicate = db.execute(
            select(Document).where(Document.sha256 == digest, Document.batch_id == batch_id)
        ).scalar_one_or_none()
        if duplicate:
            return UploadResult(
                filename=name,
                document_id=duplicate.id,
                status="duplicate",
                message="This exact file has already been uploaded; it was not added again.",
                page_count=duplicate.page_count,
            )

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
            get_storage().put_stream(key, fh)
        doc.storage_key_original = key
        db.add(doc)

        audit.record(
            db,
            actor_id=actor.id,
            action="intake.document.upload",
            entity_type="document",
            entity_id=doc.id,
            ip=request.client.host if request.client else None,
            meta={"pages": page_count, "bytes": size, "case_id": case_id},
        )
        db.commit()

        job_id = ingest_service.queue_ingest(db, doc)
        return UploadResult(
            filename=name,
            document_id=doc.id,
            status="accepted",
            message="Queued for scanning.",
            page_count=page_count,
            job_id=job_id,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return UploadResult(
            filename=name,
            document_id=None,
            status="rejected",
            message=f"The file could not be accepted ({type(exc).__name__}).",
        )
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)
