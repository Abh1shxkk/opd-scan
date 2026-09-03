"""Report downloads.

Every export takes the identical filter query string as the dashboard and the page list, and the
PDF's totals block is literally the dashboard payload — so a printed report and the screen someone
is looking at cannot disagree.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import page_filters
from app.core import audit
from app.core.rbac import current_user
from app.db import get_db
from app.models import User
from app.services import reports as report_service
from app.services.query import PageFilters, dashboard_counts, page_rows, rescan_rows

router = APIRouter(prefix="/reports", tags=["reports"])


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")


def _download(data: bytes, filename: str, media: str) -> Response:
    return Response(
        content=data,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/pages.csv")
def pages_csv(f: PageFilters = Depends(page_filters), db: Session = Depends(get_db),
              user: User = Depends(current_user)):
    rows = page_rows(db, f)
    audit.record(db, actor_id=user.id, action="export.csv", entity_type="report",
                 meta={"rows": len(rows)})
    db.commit()
    return _download(report_service.export_csv(rows), f"scan-quality-{_stamp()}.csv", "text/csv")


@router.get("/pages.xlsx")
def pages_xlsx(f: PageFilters = Depends(page_filters), db: Session = Depends(get_db),
               user: User = Depends(current_user)):
    rows = page_rows(db, f)
    summary = dashboard_counts(db, f)
    audit.record(db, actor_id=user.id, action="export.xlsx", entity_type="report",
                 meta={"rows": len(rows)})
    db.commit()
    return _download(
        report_service.export_xlsx(rows, f, summary),
        f"scan-quality-{_stamp()}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.get("/pages.pdf")
def pages_pdf(f: PageFilters = Depends(page_filters), db: Session = Depends(get_db),
              user: User = Depends(current_user)):
    rows = page_rows(db, f)
    summary = dashboard_counts(db, f)
    audit.record(db, actor_id=user.id, action="export.pdf", entity_type="report",
                 meta={"rows": len(rows)})
    db.commit()
    return _download(
        report_service.export_pdf(rows, summary, f), f"scan-quality-{_stamp()}.pdf", "application/pdf"
    )


@router.get("/rescan-checklist.pdf")
def rescan_checklist(f: PageFilters = Depends(page_filters), db: Session = Depends(get_db),
                     user: User = Depends(current_user)):
    rows = rescan_rows(db, f)
    audit.record(db, actor_id=user.id, action="export.rescan_checklist", entity_type="report",
                 meta={"rows": len(rows)})
    db.commit()
    return _download(
        report_service.rescan_checklist_pdf(rows, f), f"rescan-checklist-{_stamp()}.pdf", "application/pdf"
    )


@router.get("/flagged.zip")
def flagged_zip(
    annotated: bool = Query(False),
    f: PageFilters = Depends(page_filters),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    rows = page_rows(db, f)
    audit.record(db, actor_id=user.id, action="export.flagged_zip", entity_type="report",
                 meta={"rows": len(rows), "annotated": annotated})
    db.commit()
    return _download(
        report_service.flagged_zip(db, rows, annotated, f), f"flagged-pages-{_stamp()}.zip",
        "application/zip",
    )
