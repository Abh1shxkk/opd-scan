"""Durable job bookkeeping.

Each test here corresponds to one of the guarantees in the module docstring of
``app/services/jobs.py``: no duplicates, atomic claiming, bounded retries, real cancellation and
recovery from a dead worker.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.models import Job
from app.models.core import JobKind, JobState
from app.services import jobs as job_service

PAGE = "page-version-0001"
OTHER_PAGE = "page-version-0002"


def queued_job(db, kind: JobKind = JobKind.quality, *, page: str = PAGE, max_attempts: int = 3) -> Job:
    job = job_service.enqueue(db, kind, page_version_id=page, max_attempts=max_attempts)
    db.commit()
    return job


def reload(db, job_id: str) -> Job:
    db.expire_all()
    return db.get(Job, job_id)


# ------------------------------------------------------------------ idempotency


def test_enqueueing_the_same_work_twice_returns_the_same_job(db):
    first = queued_job(db)
    second = job_service.enqueue(db, JobKind.quality, page_version_id=PAGE)
    db.commit()

    assert second.id == first.id
    assert db.execute(select(Job)).scalars().all() == [first]


def test_different_pages_and_kinds_are_different_jobs(db):
    a = queued_job(db, JobKind.quality, page=PAGE)
    b = queued_job(db, JobKind.quality, page=OTHER_PAGE)
    c = queued_job(db, JobKind.handwriting, page=PAGE)
    assert len({a.id, b.id, c.id}) == 3
    assert len({a.idempotency_key, b.idempotency_key, c.idempotency_key}) == 3


def test_a_salt_deliberately_creates_a_second_job(db):
    first = queued_job(db)
    second = job_service.enqueue(db, JobKind.quality, page_version_id=PAGE, salt="reprocess-2026")
    db.commit()
    assert second.id != first.id


def test_requeueing_a_failed_job_revives_it_in_place(db):
    job = queued_job(db, max_attempts=1)
    job_service.claim(db, job.id)
    assert job_service.fail_or_retry(db, job, "boom") is False
    assert reload(db, job.id).state == JobState.failed

    again = job_service.enqueue(db, JobKind.quality, page_version_id=PAGE)
    db.commit()
    assert again.id == job.id
    assert again.state == JobState.queued
    assert again.attempt == 0
    assert again.error is None


def test_queue_page_stages_creates_one_job_per_stage_and_is_idempotent(db):
    first = job_service.queue_page_stages(db, PAGE)
    db.commit()
    assert {j.kind for j in first} == {JobKind.quality, JobKind.handwriting, JobKind.diagnosis}

    second = job_service.queue_page_stages(db, PAGE)
    db.commit()
    assert {j.id for j in second} == {j.id for j in first}
    assert db.execute(select(Job)).scalars().all().__len__() == 3


# ----------------------------------------------------------------- claiming


def test_a_job_can_be_claimed_exactly_once(db):
    job = queued_job(db)

    claimed = job_service.claim(db, job.id)
    assert claimed is not None
    assert job_service.claim(db, job.id) is None, "a second worker must not win the same job"

    # Read the row back rather than trusting the returned object: the UPDATE runs with
    # synchronize_session=False.
    stored = reload(db, job.id)
    assert stored.state == JobState.running
    assert stored.worker_id == job_service.WORKER_ID
    assert stored.started_at is not None
    assert stored.heartbeat_at is not None


def test_claim_returns_a_job_that_knows_it_is_running(db):
    job = queued_job(db)
    assert job_service.claim(db, job.id).state == JobState.running


def test_claiming_a_missing_job_returns_none(db):
    assert job_service.claim(db, "does-not-exist") is None


def test_a_succeeded_job_cannot_be_reclaimed(db):
    job = queued_job(db)
    job_service.claim(db, job.id)
    job_service.succeed(db, job)
    assert reload(db, job.id).state == JobState.succeeded
    assert job_service.claim(db, job.id) is None


def test_heartbeat_moves_the_clock_and_clamps_progress(db):
    job = queued_job(db)
    job_service.claim(db, job.id)
    first = reload(db, job.id).heartbeat_at

    job_service.heartbeat(db, job, progress=2.5)
    assert reload(db, job.id).progress == 1.0
    job_service.heartbeat(db, job, progress=-1.0)
    assert reload(db, job.id).progress == 0.0
    assert reload(db, job.id).heartbeat_at >= first


# ------------------------------------------------------------------- retries


def test_fail_or_retry_requeues_until_the_attempt_limit_then_fails(db):
    job = queued_job(db, max_attempts=3)
    job_service.claim(db, job.id)
    job = reload(db, job.id)  # a worker that re-reads the row sees the retry path work

    assert job_service.fail_or_retry(db, job, "transient 1") is True
    assert (job.state, job.attempt) == (JobState.queued, 1)
    assert job.heartbeat_at is None and job.worker_id is None

    assert job_service.fail_or_retry(db, job, "transient 2") is True
    assert (job.state, job.attempt) == (JobState.queued, 2)

    assert job_service.fail_or_retry(db, job, "fatal") is False
    assert job.state == JobState.failed
    assert job.attempt == 3
    assert job.finished_at is not None
    assert job.error == "fatal"


def test_a_requeued_job_can_be_claimed_again(db):
    job = queued_job(db, max_attempts=3)
    job_service.claim(db, job.id)
    job_service.fail_or_retry(db, reload(db, job.id), "transient")
    assert reload(db, job.id).state == JobState.queued
    assert job_service.claim(db, job.id) is not None


def test_the_worker_retry_path_actually_requeues_the_row(db):
    job = queued_job(db, max_attempts=3)
    claimed = job_service.claim(db, job.id)          # exactly what workers.tasks._run_stage does
    assert job_service.fail_or_retry(db, claimed, "transient") is True
    assert reload(db, job.id).state == JobState.queued


def test_a_long_error_is_truncated_rather_than_rejected(db):
    job = queued_job(db, max_attempts=1)
    job_service.fail_or_retry(db, job, "x" * 5000)
    assert len(reload(db, job.id).error) == 2000


# ---------------------------------------------------------------- cancellation


def test_a_cancelled_job_is_never_run(db):
    job = queued_job(db)
    cancelled = job_service.cancel(db, job.id)

    assert cancelled.state == JobState.cancelled
    assert cancelled.finished_at is not None
    assert job_service.claim(db, job.id) is None, "a cancelled job must not be claimable"
    assert job_service.is_cancelled(db, job.id) is True
    assert reload(db, job.id).state == JobState.cancelled


def test_cancelling_a_running_job_is_visible_to_the_worker(db):
    job = queued_job(db)
    job_service.claim(db, job.id)
    assert job_service.is_cancelled(db, job.id) is False

    job_service.cancel(db, job.id)
    assert job_service.is_cancelled(db, job.id) is True


def test_cancelling_a_finished_job_leaves_it_alone(db):
    job = queued_job(db)
    job_service.claim(db, job.id)
    job_service.succeed(db, job)
    assert job_service.cancel(db, job.id).state == JobState.succeeded


def test_cancelling_an_unknown_job_returns_none(db):
    assert job_service.cancel(db, "nope") is None
    assert job_service.is_cancelled(db, "nope") is False


# ------------------------------------------------------------- stall recovery


def stale(db, job: Job, *, minutes: int = 60, attempt: int = 0) -> Job:
    job_service.claim(db, job.id)
    fresh = reload(db, job.id)
    fresh.heartbeat_at = job_service._now() - timedelta(minutes=minutes)
    fresh.attempt = attempt
    db.add(fresh)
    db.commit()
    return fresh


def test_sweep_requeues_a_running_job_whose_heartbeat_went_stale(db):
    job = stale(db, queued_job(db, max_attempts=3))

    result = job_service.sweep_stalled(db)

    assert result == {"requeued": 1, "failed": 0, "examined": 1}
    swept = reload(db, job.id)
    assert swept.state == JobState.queued
    assert swept.attempt == 1
    assert swept.worker_id is None
    assert swept.heartbeat_at is None
    assert "stopped responding" in swept.error


def test_sweep_fails_a_stalled_job_whose_attempts_are_exhausted(db):
    job = stale(db, queued_job(db, max_attempts=2), attempt=1)

    result = job_service.sweep_stalled(db)

    assert result == {"requeued": 0, "failed": 1, "examined": 1}
    swept = reload(db, job.id)
    assert swept.state == JobState.failed
    assert swept.finished_at is not None
    assert "retry limit" in swept.error


def test_sweep_leaves_a_healthy_running_job_alone(db):
    job = queued_job(db)
    job_service.claim(db, job.id)

    assert job_service.sweep_stalled(db) == {"requeued": 0, "failed": 0, "examined": 0}
    assert reload(db, job.id).state == JobState.running


def test_sweep_picks_up_a_running_job_that_never_heartbeated(db):
    job = queued_job(db)
    job_service.claim(db, job.id)
    fresh = reload(db, job.id)
    fresh.heartbeat_at = None
    db.add(fresh)
    db.commit()

    assert job_service.sweep_stalled(db)["examined"] == 1
    assert reload(db, job.id).state == JobState.queued


def test_sweep_ignores_queued_cancelled_and_finished_jobs(db):
    queued_job(db, JobKind.quality, page="a")
    cancelled = queued_job(db, JobKind.quality, page="b")
    job_service.cancel(db, cancelled.id)
    done = queued_job(db, JobKind.quality, page="c")
    job_service.claim(db, done.id)
    job_service.succeed(db, done)

    assert job_service.sweep_stalled(db) == {"requeued": 0, "failed": 0, "examined": 0}


# ---------------------------------------------------------------- key shape


def test_idempotency_key_depends_on_every_input():
    base = job_service.idempotency_key(JobKind.quality, page_version_id=PAGE)
    assert base == job_service.idempotency_key(JobKind.quality, page_version_id=PAGE)
    assert base != job_service.idempotency_key(JobKind.handwriting, page_version_id=PAGE)
    assert base != job_service.idempotency_key(JobKind.quality, page_version_id=OTHER_PAGE)
    assert base != job_service.idempotency_key(JobKind.quality, page_version_id=PAGE, salt="x")
    assert base != job_service.idempotency_key(JobKind.quality, document_id=PAGE)


@pytest.mark.parametrize("kind", list(JobKind))
def test_every_job_kind_can_be_enqueued_and_claimed(db, kind):
    job = job_service.enqueue(db, kind, page_version_id=PAGE, document_id="doc-1")
    db.commit()
    assert job_service.claim(db, job.id) is not None
