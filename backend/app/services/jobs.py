"""Durable background jobs.

The behaviours this module exists to guarantee:

* **No duplicate processing.** Every job carries an idempotency key derived from what it operates
  on, with a unique constraint behind it. Re-queuing the same work returns the existing job.
* **Claiming is atomic.** A worker moves a job from ``queued`` to ``running`` with a conditional
  UPDATE. Two workers racing for the same job cannot both win.
* **Recovery after a restart.** A running job whose heartbeat has gone stale is swept back to
  ``queued`` (or failed once attempts are exhausted) by the beat task, so a killed worker does not
  strand pages in a permanent "running" state.
* **Bounded retries and real cancellation.** Attempts are capped; a cancelled job stops before its
  next unit of work rather than being killed mid-write.
* **Separate states per stage.** Quality, handwriting and diagnosis are separate job kinds, so one
  failing never masks another's result.
"""

from __future__ import annotations

import hashlib
import os
import socket
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Job
from app.models.core import JobKind, JobState

STALE_AFTER = timedelta(minutes=15)
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def idempotency_key(kind: JobKind, *, page_version_id: str | None = None, document_id: str | None = None,
                    salt: str = "") -> str:
    basis = f"{kind.value}|{page_version_id or ''}|{document_id or ''}|{salt}"
    return hashlib.sha256(basis.encode()).hexdigest()


def enqueue(
    db: Session,
    kind: JobKind,
    *,
    page_version_id: str | None = None,
    document_id: str | None = None,
    max_attempts: int = 3,
    salt: str = "",
) -> Job:
    """Create or return the job for this unit of work.

    ``salt`` lets an operator deliberately request a fresh run of work that already succeeded (a
    reprocess after changing thresholds, say) without weakening the duplicate protection for the
    normal path.
    """
    key = idempotency_key(kind, page_version_id=page_version_id, document_id=document_id, salt=salt)
    existing = db.execute(select(Job).where(Job.idempotency_key == key)).scalar_one_or_none()
    if existing:
        if existing.state in (JobState.failed, JobState.cancelled):
            existing.state = JobState.queued
            existing.attempt = 0
            existing.error = None
            existing.queued_at = _now()
            db.add(existing)
        return existing

    job = Job(
        kind=kind,
        state=JobState.queued,
        idempotency_key=key,
        page_version_id=page_version_id,
        document_id=document_id,
        max_attempts=max_attempts,
    )
    db.add(job)
    try:
        db.flush()
    except IntegrityError:
        # Another request created the same job between our SELECT and INSERT.
        db.rollback()
        return db.execute(select(Job).where(Job.idempotency_key == key)).scalar_one()
    return job


def claim(db: Session, job_id: str) -> Job | None:
    """Atomically move a job to running. Returns None if someone else already has it."""
    result = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == JobState.queued)
        .values(state=JobState.running, started_at=_now(), heartbeat_at=_now(), worker_id=WORKER_ID)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    if result.rowcount == 0:
        return None
    # The UPDATE went straight to the database, and the session keeps objects alive across commits,
    # so the identity map still holds a Job that believes it is queued. Handing that stale object
    # back meant a later `job.state = queued` in the retry path looked like a no-op to SQLAlchemy
    # and was silently dropped from the UPDATE — failed stages were never re-queued.
    db.expire_all()
    return db.get(Job, job_id)


def heartbeat(db: Session, job: Job, progress: float | None = None) -> None:
    job.heartbeat_at = _now()
    if progress is not None:
        job.progress = max(0.0, min(1.0, progress))
    db.add(job)
    db.commit()


def succeed(db: Session, job: Job) -> None:
    job.state = JobState.succeeded
    job.progress = 1.0
    job.finished_at = _now()
    job.error = None
    db.add(job)
    db.commit()


def fail_or_retry(db: Session, job: Job, error: str) -> bool:
    """Record a failure. Returns True if the job should be retried."""
    job.attempt += 1
    job.error = error[:2000]
    if job.attempt < job.max_attempts:
        job.state = JobState.queued
        job.heartbeat_at = None
        job.worker_id = None
        db.add(job)
        db.commit()
        return True
    job.state = JobState.failed
    job.finished_at = _now()
    db.add(job)
    db.commit()
    return False


def cancel(db: Session, job_id: str) -> Job | None:
    job = db.get(Job, job_id)
    if job is None or job.state in (JobState.succeeded, JobState.cancelled):
        return job
    job.state = JobState.cancelled
    job.finished_at = _now()
    db.add(job)
    db.commit()
    return job


def is_cancelled(db: Session, job_id: str) -> bool:
    db.expire_all()
    job = db.get(Job, job_id)
    return bool(job and job.state == JobState.cancelled)


def sweep_stalled(db: Session, stale_after: timedelta = STALE_AFTER) -> dict[str, int]:
    """Return jobs abandoned by a dead worker to the queue.

    Run by celery beat. Without it, a worker killed mid-page would leave that page permanently
    "running" and invisible to both the retry logic and the operator.
    """
    cutoff = _now() - stale_after
    stalled = db.execute(
        select(Job).where(
            Job.state == JobState.running,
            (Job.heartbeat_at.is_(None)) | (Job.heartbeat_at < cutoff),
        )
    ).scalars().all()

    requeued = failed = 0
    for job in stalled:
        job.attempt += 1
        if job.attempt < job.max_attempts:
            job.state = JobState.queued
            job.worker_id = None
            job.heartbeat_at = None
            job.error = "Worker stopped responding; job returned to the queue."
            requeued += 1
        else:
            job.state = JobState.failed
            job.finished_at = _now()
            job.error = "Worker stopped responding and the retry limit was reached."
            failed += 1
        db.add(job)
    db.commit()
    return {"requeued": requeued, "failed": failed, "examined": len(stalled)}


def queue_page_stages(db: Session, page_version_id: str, stages: list[str] | None = None, salt: str = "") -> list[Job]:
    """Queue the three analysis stages for a page. Each is independent by design.

    ``stages=None`` (the default) queues the standard three. Pass ``[]`` explicitly to queue none —
    that is a deliberate choice a caller makes, not the same thing as "unspecified", so it must not
    fall through to the default via truthiness the way ``stages or [...]`` would.
    """
    if stages is None:
        stages = ["quality", "handwriting", "diagnosis"]
    jobs = []
    for stage in stages:
        jobs.append(enqueue(db, JobKind(stage), page_version_id=page_version_id, salt=salt))
    return jobs
