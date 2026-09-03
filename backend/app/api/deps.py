"""Shared route dependencies — chiefly parsing the filter query string into ``PageFilters``.

The dashboard, the page list and every export take the *same* parameters through the *same* parser,
which is what makes "the export totals match the dashboard" a structural property rather than
something to remember.
"""

from __future__ import annotations

from fastapi import Query

from app.services.query import PageFilters


def page_filters(
    batch_id: str | None = Query(None),
    case_id: str | None = Query(None),
    patient_ref: str | None = Query(None),
    encounter_ref: str | None = Query(None),
    date_from: str | None = Query(None, alias="from"),
    date_to: str | None = Query(None, alias="to"),
    page_class: list[str] = Query(default_factory=list),
    defect_code: list[str] = Query(default_factory=list),
    handwriting: list[str] = Query(default_factory=list),
    diagnosis_status: list[str] = Query(default_factory=list),
    review_state: str | None = Query(None),
    uploader_id: str | None = Query(None),
    q: str | None = Query(None),
    limit: int | None = Query(None, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> PageFilters:
    return PageFilters(
        batch_id=batch_id,
        case_id=case_id,
        patient_ref=patient_ref,
        encounter_ref=encounter_ref,
        date_from=date_from,
        date_to=date_to,
        page_class=page_class,
        defect_code=defect_code,
        handwriting=handwriting,
        diagnosis_status=diagnosis_status,
        review_state=review_state,
        uploader_id=uploader_id,
        q=q,
        limit=limit,
        offset=offset,
    )
