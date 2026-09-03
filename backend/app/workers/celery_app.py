"""Celery application.

``task_acks_late`` plus ``reject_on_worker_lost`` means a page being processed when a worker dies
goes back to the broker rather than vanishing. The database-side sweeper in ``jobs.sweep_stalled``
covers the case where the broker also loses it.
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.config import settings

celery_app = Celery("opd", broker=settings.redis_url, backend=settings.redis_url)

celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,        # long tasks: do not hoard work in one worker
    task_track_started=True,
    task_time_limit=15 * 60,             # hard ceiling per page
    task_soft_time_limit=12 * 60,
    result_expires=24 * 3600,
    broker_connection_retry_on_startup=True,
    task_default_queue="opd",
    timezone="UTC",
    beat_schedule={
        "sweep-stalled-jobs": {
            "task": "app.workers.tasks.sweep_stalled_jobs",
            "schedule": crontab(minute="*/5"),
        },
        "apply-retention": {
            "task": "app.workers.tasks.apply_retention",
            "schedule": crontab(hour="2", minute="30"),
        },
    },
)

celery_app.autodiscover_tasks(["app.workers"])
