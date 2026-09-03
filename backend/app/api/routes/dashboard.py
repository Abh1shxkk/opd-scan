from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import page_filters
from app.core.rbac import current_user
from app.db import get_db
from app.models import Document, User
from app.models.core import JobState
from app.services.query import PageFilters, dashboard_counts

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard")
def dashboard(
    f: PageFilters = Depends(page_filters),
    db: Session = Depends(get_db),
    _: User = Depends(current_user),
):
    """Counts for the dashboard.

    Built by the same query layer the exports use, so the two can never disagree under the same
    filters. Handwriting is reported alongside quality, never inside it, and the overlap figures
    exist so the UI can say plainly that a page may be in both sets.
    """
    payload = dashboard_counts(db, f)

    from app.models import Job

    job_counts = dict(
        db.execute(select(Job.state, func.count(Job.id)).group_by(Job.state)).all()
    )
    payload.setdefault("totals", {}).setdefault("processing", {})
    payload["totals"]["processing"] = {
        "queued": job_counts.get(JobState.queued, 0),
        "running": job_counts.get(JobState.running, 0),
        "failed": job_counts.get(JobState.failed, 0),
        "cancelled": job_counts.get(JobState.cancelled, 0),
    }
    payload["totals"]["files"] = db.execute(select(func.count(Document.id))).scalar() or 0
    return payload
