"""Background tasks.

Every task follows the same shape: claim the job atomically, check for cancellation, do the work,
record success or a bounded retry. Nothing writes a result row without also writing the job state
that produced it, so the dashboard can never show a clean page whose analysis actually failed.
"""

from __future__ import annotations

import time
from datetime import timedelta

from celery import shared_task
from celery.utils.log import get_task_logger

from app.core.audit import redact
from app.db import SessionLocal
from app.models import Document, PageVersion
from app.models.core import IngestStatus, JobKind, JobState
from app.services import jobs as job_service
from app.services import pipeline
from app.services.ingest_service import ingest_document

logger = get_task_logger(__name__)

_STAGE_RUNNERS = {
    JobKind.quality: pipeline.run_quality,
    JobKind.handwriting: pipeline.run_handwriting,
    JobKind.diagnosis: pipeline.run_diagnosis,
}


def _run_stage(job_id: str, kind: JobKind) -> str:
    db = SessionLocal()
    try:
        job = job_service.claim(db, job_id)
        if job is None:
            return "not-claimable"
        if job_service.is_cancelled(db, job_id):
            return "cancelled"

        pv = db.get(PageVersion, job.page_version_id) if job.page_version_id else None
        if pv is None:
            job_service.fail_or_retry(db, job, "Page version no longer exists.")
            return "missing-page"

        try:
            _STAGE_RUNNERS[kind](db, pv)
            db.commit()
            job_service.succeed(db, job)
            return "ok"
        except Exception as exc:  # noqa: BLE001 - the failure must be recorded, not raised away
            db.rollback()
            message = f"{type(exc).__name__}: {exc}"
            logger.error(redact(f"{kind.value} job failed: {message}"))
            retry = job_service.fail_or_retry(db, job, message)
            return "retry" if retry else "failed"
    finally:
        db.close()


@shared_task(name="app.workers.tasks.run_quality", bind=True, max_retries=0)
def run_quality(self, job_id: str) -> str:  # noqa: ANN001, ARG001
    return _run_stage(job_id, JobKind.quality)


@shared_task(name="app.workers.tasks.run_handwriting", bind=True, max_retries=0)
def run_handwriting(self, job_id: str) -> str:  # noqa: ANN001, ARG001
    return _run_stage(job_id, JobKind.handwriting)


@shared_task(name="app.workers.tasks.run_diagnosis", bind=True, max_retries=0)
def run_diagnosis(self, job_id: str) -> str:  # noqa: ANN001, ARG001
    return _run_stage(job_id, JobKind.diagnosis)


@shared_task(name="app.workers.tasks.run_ingest", bind=True, max_retries=0)
def run_ingest(self, job_id: str) -> str:  # noqa: ANN001, ARG001
    """Split an uploaded file into logical pages, then queue the three analysis stages per page."""
    db = SessionLocal()
    try:
        job = job_service.claim(db, job_id)
        if job is None:
            return "not-claimable"

        doc = db.get(Document, job.document_id) if job.document_id else None
        if doc is None:
            job_service.fail_or_retry(db, job, "Document no longer exists.")
            return "missing-document"

        def _progress(done: int, total: int) -> bool:
            job_service.heartbeat(db, job, progress=done / max(total, 1))
            # Returning False asks the ingester to stop cleanly at a page boundary.
            return not job_service.is_cancelled(db, job.id)

        try:
            ingest_document(db, doc, on_progress=_progress)
            db.commit()
            if job_service.is_cancelled(db, job.id):
                return "cancelled"
            job_service.succeed(db, job)
            return "ok"
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            message = f"{type(exc).__name__}: {exc}"
            logger.error(redact(f"ingest job failed: {message}"))
            doc = db.get(Document, job.document_id)
            if doc is not None:
                doc.ingest_status = IngestStatus.failed
                doc.ingest_error = message[:2000]
                db.add(doc)
                db.commit()
            retry = job_service.fail_or_retry(db, job, message)
            return "retry" if retry else "failed"
    finally:
        db.close()


@shared_task(name="app.workers.tasks.sweep_stalled_jobs")
def sweep_stalled_jobs() -> dict:
    db = SessionLocal()
    try:
        result = job_service.sweep_stalled(db)
        if result["examined"]:
            logger.warning("swept stalled jobs: %s", result)
            dispatch_queued(limit=200)
        return result
    finally:
        db.close()


@shared_task(name="app.workers.tasks.apply_retention")
def apply_retention() -> dict:
    """Delete stored files past their retention window. Audit rows are never removed here."""
    from sqlalchemy import select

    from app.config import settings
    from app.core.storage import get_storage
    from app.models import Document as Doc
    from app.services import settings_store

    db = SessionLocal()
    removed = 0
    try:
        policy = settings_store.get_retention(db)
        days = int(policy.get("originals_days") or settings.retention_days_originals or 0)
        if days <= 0:
            return {"removed": 0, "note": "retention disabled (0 = keep indefinitely)"}
        from datetime import datetime, timezone

        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        storage = get_storage()
        for doc in db.execute(select(Doc).where(Doc.uploaded_at < cutoff)).scalars():
            try:
                storage.delete(doc.storage_key_original)
                removed += 1
            except Exception:  # noqa: BLE001 - a missing object is not an error worth failing on
                continue
        db.commit()
        return {"removed": removed, "cutoff_days": days}
    finally:
        db.close()


_TASK_FOR_KIND = {
    JobKind.ingest: run_ingest,
    JobKind.quality: run_quality,
    JobKind.handwriting: run_handwriting,
    JobKind.diagnosis: run_diagnosis,
}


def dispatch(job) -> None:  # noqa: ANN001
    """Send a job to the broker. Safe to call more than once — claiming is what decides."""
    task = _TASK_FOR_KIND[job.kind]
    task.apply_async(args=[job.id], queue="opd")


def dispatch_queued(limit: int = 100) -> int:
    """Push queued jobs to the broker. Used at startup and after a stall sweep, so a restart picks
    work back up without an operator doing anything."""
    from sqlalchemy import select

    from app.models import Job

    from app.services import inline_runner

    db = SessionLocal()
    try:
        rows = db.execute(
            select(Job).where(Job.state == JobState.queued).order_by(Job.queued_at).limit(limit)
        ).scalars().all()
    finally:
        db.close()

    if inline_runner.enabled():
        return inline_runner.submit_many(rows)
    for job in rows:
        dispatch(job)
    return len(rows)


def run_inline(job_id: str, kind: JobKind) -> str:
    """Execute a job in the calling process.

    Used when no broker is configured — a single-machine pilot, a test run, or the calibration
    tooling. The job bookkeeping is identical, so behaviour does not diverge between modes.
    """
    if kind == JobKind.ingest:
        return run_ingest.run(job_id)  # type: ignore[attr-defined]
    return _run_stage(job_id, kind)


def wait_for(db, job_ids: list[str], timeout: float = 600.0) -> bool:  # noqa: ANN001
    """Block until the given jobs leave the queue. Only for tests and CLI tools."""
    from sqlalchemy import select

    from app.models import Job

    deadline = time.time() + timeout
    while time.time() < deadline:
        db.expire_all()
        states = db.execute(select(Job.state).where(Job.id.in_(job_ids))).scalars().all()
        if all(s in (JobState.succeeded, JobState.failed, JobState.cancelled) for s in states):
            return True
        time.sleep(0.5)
    return False
