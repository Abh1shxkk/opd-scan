"""One shared filter/query builder for the page list, the dashboard and the exports.

Why this module exists at all: the number a clerk sees on the dashboard and the number of rows in
the spreadsheet they export five seconds later have to be the same number. The only reliable way to
guarantee that is to have exactly one place that turns a query string into SQL. Every caller —
``GET /pages``, ``GET /dashboard``, ``GET /reports/*`` — builds a :class:`PageFilters` and comes
here.

Counting rules that are enforced structurally rather than by convention:

* Only ``PageVersion.is_active`` rows are ever counted. A rescanned page contributes one row, not
  two, and it is the *current* scan that counts.
* Every count is **distinct active page versions**. Joins that could fan out (quality findings,
  handwriting regions, diagnosis extractions, reviews) are expressed as ``EXISTS`` subqueries so a
  page with four defects is still one page.
* ``blank``, ``failed`` and ``unchecked`` are their own quality buckets. They are never folded into
  ``acceptable`` — a page nobody could measure is not a page that passed.
* Handwriting is not a scan defect. It is counted on its own axis, and the ``overlaps`` block exists
  precisely so the UI can say "these two sets intersect" instead of implying they partition.
* A page with no quality row is ``unchecked``; with no handwriting row is ``pending``; with no
  diagnosis extraction is ``pending``. Absence of a result is never silently read as a clean result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Iterable, Sequence

from sqlalchemy import Select, and_, case, distinct, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models.core import (
    Batch,
    Case,
    DiagnosisExtraction,
    DiagnosisStatus,
    Document,
    HandwritingCategory,
    HandwritingRegion,
    HandwritingResult,
    HandwritingStatus,
    Job,
    JobState,
    LogicalPage,
    PageClass,
    PageReview,
    PageVersion,
    QualityFinding,
    QualityResult,
    Severity,
    User,
)
from app.processing.quality.rules import DEFECT_LABELS, DEFECT_ORDER

# --------------------------------------------------------------------- columns

#: The export column order, shared by CSV, XLSX, the PDF table and the ZIP manifest so that every
#: artefact of one query has the same shape. Matches docs/API.md → Reports → Columns.
EXPORT_COLUMNS: tuple[str, ...] = (
    "batch",
    "patient_ref",
    "encounter_ref",
    "filename",
    "page_no",
    "printed_label",
    "version",
    "scan_status",
    "defect_codes",
    "defect_severities",
    "handwriting_status",
    "handwriting_categories",
    "diagnosis_status",
    "diagnosis_qualifier",
    "diagnosis_text_raw",
    "diagnosis_text_reviewed",
    "reviewed_by",
    "reviewer_comment",
    "ai_vs_reviewed",
)

#: Human column headings for spreadsheets and PDFs.
EXPORT_HEADERS: dict[str, str] = {
    "batch": "Batch",
    "patient_ref": "Patient ref",
    "encounter_ref": "Encounter ref",
    "filename": "File",
    "page_no": "Page",
    "printed_label": "Printed label",
    "version": "Version",
    "scan_status": "Scan status",
    "defect_codes": "Defect codes",
    "defect_severities": "Defect severities",
    "handwriting_status": "Handwriting",
    "handwriting_categories": "Handwriting categories",
    "diagnosis_status": "Diagnosis status",
    "diagnosis_qualifier": "Diagnosis qualifier",
    "diagnosis_text_raw": "Diagnosis text (AI, raw)",
    "diagnosis_text_reviewed": "Diagnosis text (reviewer corrected)",
    "reviewed_by": "Reviewed by",
    "reviewer_comment": "Reviewer comment",
    "ai_vs_reviewed": "AI vs reviewed",
}

#: Values of ``ai_vs_reviewed``. The export must never leave a reader guessing whether a human
#: looked at a finding.
AI_ONLY = "ai_only"
REVIEWER_CONFIRMED = "reviewer_confirmed"
REVIEWER_CORRECTED = "reviewer_corrected"

#: Separator used inside multi-valued cells. Chosen so it survives CSV and reads cleanly in Excel.
MULTI_SEP = "; "

#: A page can carry several diagnosis extractions with different statuses. For the *one bucket per
#: page* dashboard count we take the most clinically significant one, in this order.
_DIAGNOSIS_PRIORITY: tuple[DiagnosisStatus, ...] = (
    DiagnosisStatus.extracted_pending_review,
    DiagnosisStatus.uncertain,
    DiagnosisStatus.unreadable,
    DiagnosisStatus.processing_failed,
    DiagnosisStatus.not_found,
    DiagnosisStatus.unconfigured,
    DiagnosisStatus.pending,
)

#: Quality classes that put a page in front of a human.
_NEEDS_REVIEW_CLASSES = (PageClass.review, PageClass.rescan)

#: Page review actions that close the "awaiting review" state.
_CLOSING_REVIEW_ACTIONS = ("accept", "request_rescan")

_SEVERITY_RANK = {Severity.low: 0, Severity.medium: 1, Severity.high: 2}


# --------------------------------------------------------------------- filters


@dataclass
class PageFilters:
    """The shared query string, parsed.

    Every field is optional; an unset field means "do not narrow on this". List fields are ORs
    within themselves and ANDs against the other fields, which is what a user expects from
    checkbox filters.
    """

    batch_id: str | None = None
    case_id: str | None = None
    patient_ref: str | None = None
    encounter_ref: str | None = None
    date_from: datetime | date | str | None = None
    date_to: datetime | date | str | None = None
    page_class: list[str] = field(default_factory=list)
    defect_code: list[str] = field(default_factory=list)
    handwriting: list[str] = field(default_factory=list)
    diagnosis_status: list[str] = field(default_factory=list)
    review_state: str | None = None  # pending | accepted | rescan_requested
    uploader_id: str | None = None
    q: str | None = None
    limit: int | None = None
    offset: int = 0

    # -- presentation -----------------------------------------------------

    def describe(self) -> list[tuple[str, str]]:
        """Human-readable (label, value) pairs for the "Report parameters" sheet.

        A totals table without the filters that produced it is a number without a meaning, so every
        export carries this block.
        """
        out: list[tuple[str, str]] = []
        simple = [
            ("Batch", self.batch_id),
            ("Case", self.case_id),
            ("Patient ref", self.patient_ref),
            ("Encounter ref", self.encounter_ref),
            ("Uploaded from", _fmt_dt(_coerce_dt(self.date_from, end_of_day=False))),
            ("Uploaded to", _fmt_dt(_coerce_dt(self.date_to, end_of_day=True))),
            ("Review state", self.review_state),
            ("Uploaded by (user id)", self.uploader_id),
            ("Search text", self.q),
        ]
        for label, value in simple:
            if value:
                out.append((label, str(value)))
        for label, values in [
            ("Page class", self.page_class),
            ("Defect code", self.defect_code),
            ("Handwriting", self.handwriting),
            ("Diagnosis status", self.diagnosis_status),
        ]:
            if values:
                out.append((label, MULTI_SEP.join(str(v) for v in values)))
        if self.limit:
            out.append(("Row limit", f"{self.limit} (offset {self.offset})"))
        if not out:
            out.append(("Filters", "none — all active page versions"))
        return out


# ----------------------------------------------------------------- coercion


def _coerce_dt(value: datetime | date | str | None, *, end_of_day: bool) -> datetime | None:
    """Accept whatever the query string produced and return an aware UTC datetime.

    A bare date on the ``to`` side means "up to the end of that day"; treating it as midnight would
    silently drop a whole day's uploads out of the totals.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        text = value.strip().replace("Z", "+00:00")
        try:
            value = datetime.fromisoformat(text)
        except ValueError:
            try:
                value = date.fromisoformat(text[:10])
            except ValueError:
                return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    # a plain date
    if end_of_day:
        return datetime(value.year, value.month, value.day, 23, 59, 59, 999999, tzinfo=timezone.utc)
    return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)


def _fmt_dt(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def _enum_values(raw: Iterable[Any] | None, enum_cls: Any) -> list[Any]:
    """Map user-supplied strings onto enum members, dropping anything unrecognised.

    Dropping is deliberate: an unknown ``page_class=banana`` must not silently widen the result set
    to everything, and must not 500 either.
    """
    out: list[Any] = []
    for item in raw or []:
        if isinstance(item, enum_cls):
            out.append(item)
            continue
        try:
            out.append(enum_cls(str(item).strip()))
        except ValueError:
            continue
    return out


def _enum_value(value: Any) -> Any:
    """Unwrap an enum member to its string value; pass anything else through."""
    return value.value if hasattr(value, "value") else value


def _split_handwriting(
    raw: Sequence[str] | None,
) -> tuple[list[HandwritingStatus], list[HandwritingCategory]]:
    """The ``handwriting[]`` filter carries both statuses and region categories.

    The UI offers one combined facet ("detected", "signature", "stamp", ...) so the parameter is
    interpreted by looking each value up in both enums. Anything matching neither is ignored.
    """
    statuses = _enum_values(raw, HandwritingStatus)
    known = {s.value for s in statuses}
    categories = _enum_values([r for r in (raw or []) if str(r).strip() not in known], HandwritingCategory)
    return statuses, categories


# ------------------------------------------------------------- query building


def _apply_filters(stmt: Select, f: PageFilters) -> Select:
    """Apply every filter in ``f`` to a statement already joined to the record hierarchy.

    Only many-to-one and one-to-one joins are used in the FROM clause (LogicalPage → Document →
    Batch/Case, and the unique QualityResult / HandwritingResult rows), so nothing here can
    multiply a page into several rows. Everything one-to-many — findings, handwriting regions,
    diagnosis extractions, reviews — is filtered with ``EXISTS``.
    """
    conditions: list[Any] = [PageVersion.is_active.is_(True)]

    if f.batch_id:
        conditions.append(Document.batch_id == f.batch_id)
    if f.case_id:
        conditions.append(Document.case_id == f.case_id)
    if f.patient_ref:
        conditions.append(Case.patient_ref == f.patient_ref)
    if f.encounter_ref:
        conditions.append(Case.encounter_ref == f.encounter_ref)
    if f.uploader_id:
        conditions.append(Document.uploaded_by == f.uploader_id)

    dt_from = _coerce_dt(f.date_from, end_of_day=False)
    dt_to = _coerce_dt(f.date_to, end_of_day=True)
    if dt_from:
        conditions.append(Document.uploaded_at >= dt_from)
    if dt_to:
        conditions.append(Document.uploaded_at <= dt_to)

    # -- quality class ----------------------------------------------------
    classes = _enum_values(f.page_class, PageClass)
    if classes:
        clause = QualityResult.overall.in_(classes)
        if PageClass.unchecked in classes:
            # A page that has never been through the quality engine has no QualityResult row at
            # all. It is unchecked, and asking for "unchecked" must return it.
            clause = or_(clause, QualityResult.id.is_(None))
        conditions.append(clause)

    # -- defect codes (EXISTS: a page with three defects is still one page) --
    codes = [str(c).strip() for c in (f.defect_code or []) if str(c).strip()]
    if codes:
        conditions.append(
            select(QualityFinding.id)
            .join(QualityResult, QualityResult.id == QualityFinding.quality_result_id)
            .where(
                QualityResult.page_version_id == PageVersion.id,
                QualityFinding.defect_code.in_(codes),
            )
            .exists()
        )

    # -- handwriting ------------------------------------------------------
    hw_statuses, hw_categories = _split_handwriting(f.handwriting)
    if hw_statuses:
        clause = HandwritingResult.status.in_(hw_statuses)
        if HandwritingStatus.pending in hw_statuses:
            # No handwriting row yet == pending, not "none detected".
            clause = or_(clause, HandwritingResult.id.is_(None))
        conditions.append(clause)
    if hw_categories:
        conditions.append(
            select(HandwritingRegion.id)
            .join(HandwritingResult, HandwritingResult.id == HandwritingRegion.handwriting_result_id)
            .where(
                HandwritingResult.page_version_id == PageVersion.id,
                HandwritingRegion.category.in_(hw_categories),
            )
            .exists()
        )

    # -- diagnosis status -------------------------------------------------
    diag_statuses = _enum_values(f.diagnosis_status, DiagnosisStatus)
    if diag_statuses:
        clause = (
            select(DiagnosisExtraction.id)
            .where(
                DiagnosisExtraction.page_version_id == PageVersion.id,
                DiagnosisExtraction.status.in_(diag_statuses),
            )
            .exists()
        )
        if DiagnosisStatus.pending in diag_statuses:
            # No extraction row yet == pending.
            clause = or_(
                clause,
                ~select(DiagnosisExtraction.id)
                .where(DiagnosisExtraction.page_version_id == PageVersion.id)
                .exists(),
            )
        conditions.append(clause)

    # -- review state -----------------------------------------------------
    if f.review_state:
        closed = (
            select(PageReview.id)
            .where(
                PageReview.page_version_id == PageVersion.id,
                PageReview.action.in_(_CLOSING_REVIEW_ACTIONS),
            )
            .exists()
        )
        if f.review_state == "accepted":
            conditions.append(
                select(PageReview.id)
                .where(PageReview.page_version_id == PageVersion.id, PageReview.action == "accept")
                .exists()
            )
        elif f.review_state == "rescan_requested":
            conditions.append(
                select(PageReview.id)
                .where(PageReview.page_version_id == PageVersion.id, PageReview.action == "request_rescan")
                .exists()
            )
        elif f.review_state == "pending":
            # Identical definition to the dashboard's awaiting_review, on purpose.
            conditions.append(and_(QualityResult.overall.in_(_NEEDS_REVIEW_CLASSES), ~closed))

    # -- free text --------------------------------------------------------
    # Deliberately limited to identifiers and file names. Diagnosis text is patient content; it is
    # not swept into a general search box where it could leak into logs or shoulder-surfing.
    if f.q:
        needle = f"%{f.q.strip()}%"
        conditions.append(
            or_(
                Document.original_filename.ilike(needle),
                Batch.name.ilike(needle),
                Case.patient_ref.ilike(needle),
                Case.encounter_ref.ilike(needle),
                LogicalPage.printed_page_label.ilike(needle),
            )
        )

    return stmt.where(*conditions)


def _core_select(f: PageFilters, *columns: Any) -> Select:
    """The shared FROM/WHERE core. ``columns`` chooses what comes back."""
    stmt = (
        select(*columns)
        .select_from(PageVersion)
        .join(LogicalPage, LogicalPage.id == PageVersion.logical_page_id)
        .join(Document, Document.id == LogicalPage.document_id)
        .join(Batch, Batch.id == Document.batch_id)
        .outerjoin(Case, Case.id == Document.case_id)  # a document need not belong to a case yet
        .outerjoin(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .outerjoin(HandwritingResult, HandwritingResult.page_version_id == PageVersion.id)
    )
    return _apply_filters(stmt, f)


def active_page_query(db: Session, f: PageFilters, *, apply_paging: bool = False) -> Select:
    """Return the shared ``SELECT`` over **active** page versions matching ``f``.

    ``db`` is accepted for symmetry with the other entry points (and so a future implementation can
    consult per-user scoping) but the statement is not executed here — the caller decides whether it
    wants entities, a count, or a stream.

    Paging is off by default: the dashboard and the exports must see the whole filtered set, and
    only the paged list view asks for a window.
    """
    stmt = _core_select(f, PageVersion).order_by(
        Document.uploaded_at.desc(),
        Document.id,
        LogicalPage.ordinal,
        PageVersion.version_no,
    )
    # Every join above is many-to-one or one-to-one, so rows cannot fan out — no distinct() needed.
    # (A plain SELECT DISTINCT combined with ORDER BY on a joined-but-unselected column, as the sort
    # above requires, is also rejected outright by PostgreSQL: "ORDER BY expressions must appear in
    # select list".)
    if apply_paging and f.limit:
        stmt = stmt.limit(f.limit).offset(f.offset or 0)
    return stmt


def count_pages(db: Session, f: PageFilters) -> int:
    """Distinct active page versions matching ``f`` — the number the list view shows."""
    return int(db.execute(_core_select(f, func.count(distinct(PageVersion.id)))).scalar() or 0)


# ------------------------------------------------------------------ dashboard


def _zeroed(enum_cls: Any) -> dict[str, int]:
    """A bucket dict with every enum member present at zero.

    Buckets are pre-created so a status that happens to have no pages today still appears in the
    JSON. A missing key reads as "not applicable"; a zero reads as "none" — they are different.
    """
    return {m.value: 0 for m in enum_cls}


def dashboard_counts(db: Session, f: PageFilters) -> dict[str, Any]:
    """Every total on the dashboard, in the exact shape of docs/API.md → Dashboard.

    All page counts are ``COUNT(DISTINCT page_versions.id)`` over the same filtered set the list and
    the exports use.
    """
    # The filtered page ids, materialised once and joined against for each aggregate. One WHERE
    # clause, many aggregates — that is what keeps the dashboard and the export in agreement.
    filtered = _core_select(f, PageVersion.id.label("id")).distinct().subquery("filtered_pages")
    ids = select(filtered.c.id)

    def base() -> Select:
        return select().select_from(filtered).join(PageVersion, PageVersion.id == filtered.c.id)

    # -- headline ---------------------------------------------------------
    pages_active = int(db.execute(select(func.count()).select_from(filtered)).scalar() or 0)
    files = int(db.execute(_core_select(f, func.count(distinct(Document.id)))).scalar() or 0)

    # -- quality: one bucket per page, missing row => unchecked ------------
    quality = _zeroed(PageClass)
    rows = db.execute(
        base()
        .add_columns(QualityResult.overall, func.count(distinct(PageVersion.id)))
        .outerjoin(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .group_by(QualityResult.overall)
    ).all()
    for overall, n in rows:
        key = _enum_value(overall) or PageClass.unchecked.value
        quality[key] = quality.get(key, 0) + int(n)

    # -- handwriting: missing row => pending, never "none_detected" --------
    handwriting = _zeroed(HandwritingStatus)
    rows = db.execute(
        base()
        .add_columns(HandwritingResult.status, func.count(distinct(PageVersion.id)))
        .outerjoin(HandwritingResult, HandwritingResult.page_version_id == PageVersion.id)
        .group_by(HandwritingResult.status)
    ).all()
    for status, n in rows:
        key = _enum_value(status) or HandwritingStatus.pending.value
        handwriting[key] = handwriting.get(key, 0) + int(n)

    # -- diagnosis: a page may hold several extractions, so rank them and --
    # -- keep the most significant, giving one bucket per page ------------
    diagnosis = _zeroed(DiagnosisStatus)
    rank = case(
        *[(DiagnosisExtraction.status == s, i) for i, s in enumerate(_DIAGNOSIS_PRIORITY)],
        else_=len(_DIAGNOSIS_PRIORITY),  # includes the NULL of "no extraction row at all"
    )
    per_page = (
        base()
        .add_columns(PageVersion.id.label("pv"), func.min(rank).label("rank"))
        .outerjoin(DiagnosisExtraction, DiagnosisExtraction.page_version_id == PageVersion.id)
        .group_by(PageVersion.id)
        .subquery("diag_rank")
    )
    for rnk, n in db.execute(
        select(per_page.c.rank, func.count()).select_from(per_page).group_by(per_page.c.rank)
    ).all():
        idx = int(rnk) if rnk is not None else len(_DIAGNOSIS_PRIORITY)
        status = (
            _DIAGNOSIS_PRIORITY[idx] if idx < len(_DIAGNOSIS_PRIORITY) else DiagnosisStatus.pending
        )
        diagnosis[status.value] += int(n)

    # -- awaiting review ---------------------------------------------------
    closed = (
        select(PageReview.id)
        .where(
            PageReview.page_version_id == PageVersion.id,
            PageReview.action.in_(_CLOSING_REVIEW_ACTIONS),
        )
        .exists()
    )
    awaiting_review = int(
        db.execute(
            base()
            .add_columns(func.count(distinct(PageVersion.id)))
            .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
            .where(QualityResult.overall.in_(_NEEDS_REVIEW_CLASSES), ~closed)
        ).scalar()
        or 0
    )

    # -- processing jobs ---------------------------------------------------
    processing = {"queued": 0, "running": 0, "failed": 0}
    doc_ids = _core_select(f, distinct(Document.id))
    for state, n in db.execute(
        select(Job.state, func.count(distinct(Job.id)))
        .where(
            Job.state.in_([JobState.queued, JobState.running, JobState.failed]),
            or_(Job.page_version_id.in_(ids), Job.document_id.in_(doc_ids)),
        )
        .group_by(Job.state)
    ).all():
        processing[_enum_value(state)] = int(n)

    # -- overlaps ----------------------------------------------------------
    # Handwriting is never counted as a defect; this block is what lets the UI show that the two
    # sets intersect instead of implying they partition the pages.
    has_defect = (
        select(QualityFinding.id)
        .join(QualityResult, QualityResult.id == QualityFinding.quality_result_id)
        .where(QualityResult.page_version_id == PageVersion.id)
        .exists()
    )
    has_handwriting = (
        select(HandwritingResult.id)
        .where(
            HandwritingResult.page_version_id == PageVersion.id,
            HandwritingResult.status == HandwritingStatus.detected,
        )
        .exists()
    )
    both, defect_only, handwriting_only = db.execute(
        base().add_columns(
            func.count(distinct(case((and_(has_defect, has_handwriting), PageVersion.id)))),
            func.count(distinct(case((and_(has_defect, ~has_handwriting), PageVersion.id)))),
            func.count(distinct(case((and_(~has_defect, has_handwriting), PageVersion.id)))),
        )
    ).one()

    # -- defect breakdown --------------------------------------------------
    defect_rows = db.execute(
        base()
        .add_columns(QualityFinding.defect_code, func.count(distinct(PageVersion.id)))
        .join(QualityResult, QualityResult.page_version_id == PageVersion.id)
        .join(QualityFinding, QualityFinding.quality_result_id == QualityResult.id)
        .group_by(QualityFinding.defect_code)
    ).all()
    order = {code: i for i, code in enumerate(DEFECT_ORDER)}
    defects = sorted(
        (
            {"code": code, "label": DEFECT_LABELS.get(code, code), "pages": int(n)}
            for code, n in defect_rows
        ),
        key=lambda d: (-d["pages"], order.get(d["code"], 999), d["code"]),
    )

    # Imported lazily and defensively: the dashboard must still render its counts on a deployment
    # where a provider SDK is not installed, and an unavailable provider is reported as
    # "unconfigured" rather than being quietly omitted.
    try:
        from app.processing.providers import router as provider_router

        capabilities = provider_router.capability_status()
    except Exception as exc:
        capabilities = {
            "provider_status": {
                "status": "unconfigured",
                "setup_required": f"Provider status could not be read: {type(exc).__name__}: {exc}",
            }
        }

    return {
        "totals": {
            "files": files,
            "pages_active": pages_active,
            "processing": processing,
            "quality": quality,
            "handwriting": handwriting,
            "diagnosis": diagnosis,
            "awaiting_review": awaiting_review,
        },
        "overlaps": {
            "defect_and_handwriting": int(both or 0),
            "defect_only": int(defect_only or 0),
            "handwriting_only": int(handwriting_only or 0),
        },
        "defects": defects,
        "capabilities": capabilities,
    }


# ----------------------------------------------------------------- export rows


def _diagnosis_bucket(extractions: Sequence[DiagnosisExtraction]) -> DiagnosisStatus:
    """The single status that represents this page, using the dashboard's own priority order."""
    if not extractions:
        return DiagnosisStatus.pending
    best = min(
        extractions,
        key=lambda e: _DIAGNOSIS_PRIORITY.index(e.status)
        if e.status in _DIAGNOSIS_PRIORITY
        else len(_DIAGNOSIS_PRIORITY),
    )
    return best.status


def _user_label(users: dict[str, User], user_id: str | None) -> str:
    """Prefer a real name; fall back to the login, then to the raw id. Never blank on a real id."""
    if not user_id:
        return ""
    user = users.get(user_id)
    if not user:
        return user_id
    return user.full_name or user.email or user.id


def _page_row(pv: PageVersion, users: dict[str, User]) -> dict[str, Any]:
    """Flatten one active page version into an export row.

    Nothing here is truncated or rounded away: the diagnosis text is the verbatim clinical record
    extract. Layout-driven shortening happens only in the PDF writer, and is marked there.
    """
    lp = pv.logical_page
    doc = lp.document
    case_row = doc.case
    quality = pv.quality
    hw = pv.handwriting

    # -- defects: one entry per code, carrying that code's worst severity, so the two columns stay
    # -- positionally aligned and a reader can pair them off by eye.
    worst: dict[str, Severity] = {}
    for finding in quality.findings if quality else []:
        current = worst.get(finding.defect_code)
        if current is None or _SEVERITY_RANK[finding.severity] > _SEVERITY_RANK[current]:
            worst[finding.defect_code] = finding.severity
    order = {code: i for i, code in enumerate(DEFECT_ORDER)}
    codes = sorted(worst, key=lambda c: (order.get(c, 999), c))

    # -- handwriting categories, with a count when a category repeats.
    cat_counts: dict[str, int] = {}
    for region in hw.regions if hw else []:
        key = _enum_value(region.category)
        cat_counts[key] = cat_counts.get(key, 0) + 1
    categories = MULTI_SEP.join(
        f"{k} x{v}" if v > 1 else k for k, v in sorted(cat_counts.items())
    )

    # -- diagnosis --------------------------------------------------------
    extractions = list(pv.diagnoses)
    bucket = _diagnosis_bucket(extractions)
    raw_parts: list[str] = []
    reviewed_parts: list[str] = []
    qualifiers: list[str] = []
    diag_confirmed = False
    diag_corrected = False
    reviewer_ids: list[str] = []
    comments: list[str] = []

    for extraction in extractions:
        if extraction.raw_text:
            raw_parts.append(extraction.raw_text)
        qualifier = _enum_value(extraction.qualifier)
        latest_correction = None
        for review in extraction.reviews:  # ordered by created_at in the model
            reviewer_ids.append(review.reviewer_id)
            if review.comment:
                comments.append(f"[diagnosis/{review.action}] {review.comment}")
            if review.action == "confirm":
                diag_confirmed = True
            elif review.action in ("correct", "reject"):
                diag_corrected = True
                if review.corrected_text:
                    latest_correction = review.corrected_text
                if review.corrected_qualifier is not None:
                    qualifier = _enum_value(review.corrected_qualifier)
        if latest_correction:
            reviewed_parts.append(latest_correction)
        if qualifier:
            qualifiers.append(qualifier)

    # -- page-level reviews ------------------------------------------------
    page_confirmed = False
    page_corrected = False
    for review in pv.reviews:
        reviewer_ids.append(review.reviewer_id)
        if review.comment:
            comments.append(f"[page/{review.action}] {review.comment}")
        if review.action in _CLOSING_REVIEW_ACTIONS:
            page_confirmed = True
        elif review.action == "correct_finding":
            page_corrected = True

    # A human overriding the machine outranks a human agreeing with it; agreement outranks silence.
    if diag_corrected or page_corrected:
        ai_vs_reviewed = REVIEWER_CORRECTED
    elif diag_confirmed or page_confirmed:
        ai_vs_reviewed = REVIEWER_CONFIRMED
    else:
        ai_vs_reviewed = AI_ONLY

    seen: list[str] = []
    for rid in reviewer_ids:
        label = _user_label(users, rid)
        if label and label not in seen:
            seen.append(label)

    return {
        "batch": doc.batch.name if doc.batch else "",
        "patient_ref": case_row.patient_ref if case_row else "",
        "encounter_ref": case_row.encounter_ref if case_row else "",
        "filename": doc.original_filename,
        "page_no": lp.ordinal,
        "printed_label": lp.printed_page_label or "",
        "version": pv.version_no,
        # No quality row means the page was never measured — "unchecked", not "acceptable".
        "scan_status": _enum_value(quality.overall) if quality else PageClass.unchecked.value,
        "defect_codes": MULTI_SEP.join(codes),
        "defect_severities": MULTI_SEP.join(_enum_value(worst[c]) for c in codes),
        # No handwriting row means the check has not run — "pending", not "none_detected".
        "handwriting_status": _enum_value(hw.status) if hw else HandwritingStatus.pending.value,
        "handwriting_categories": categories,
        "diagnosis_status": _enum_value(bucket),
        "diagnosis_qualifier": MULTI_SEP.join(dict.fromkeys(qualifiers)),
        # Verbatim, in full. The immutable AI transcription.
        "diagnosis_text_raw": "\n---\n".join(raw_parts),
        # Only populated when a reviewer actually rewrote the text; a plain confirmation shows up in
        # ai_vs_reviewed instead of being copied in here as if it were a new transcription.
        "diagnosis_text_reviewed": "\n---\n".join(reviewed_parts),
        "reviewed_by": MULTI_SEP.join(seen),
        "reviewer_comment": " | ".join(comments),
        "ai_vs_reviewed": ai_vs_reviewed,
        # -- private payload, prefixed with "_" and never written to a tabular export. It lets the
        # -- ZIP builder and the checklist work from the rows they were handed instead of going
        # -- back to the database per page.
        "_page_version_id": pv.id,
        "_logical_page_id": lp.id,
        "_document_id": doc.id,
        "_storage_key_render": pv.storage_key_render,
        "_width": pv.width,
        "_height": pv.height,
        "_quality_findings": [
            {
                "defect_code": f.defect_code,
                "label": DEFECT_LABELS.get(f.defect_code, f.defect_code),
                "severity": _enum_value(f.severity),
                "detail": f.detail,
                "source": f.source,
                "confidence": f.confidence,
                "region": f.region_json,
            }
            for f in (quality.findings if quality else [])
        ],
        "_handwriting_regions": [
            {
                "category": _enum_value(r.category),
                "confidence": r.confidence,
                "polygon": r.polygon_json or [],
            }
            for r in (hw.regions if hw else [])
        ],
        "_diagnosis_regions": [
            {
                "status": _enum_value(e.status),
                "anchor_label": e.anchor_label,
                "region": e.region_json,
            }
            for e in extractions
        ],
    }


def page_rows(db: Session, f: PageFilters) -> list[dict[str, Any]]:
    """Fully-populated flat rows for export — one row per **active** page version.

    Eager-loaded in a fixed number of queries regardless of row count (``selectinload`` issues one
    extra SELECT per relationship, not one per page), and streamed with ``yield_per`` so a
    fifty-thousand-page batch does not materialise fifty thousand ORM graphs at once.
    """
    # Loaded first and in full: the user table is small, and reading it here avoids a per-row lookup
    # (and avoids issuing a second query while a server-side cursor is open on the same connection).
    users = {u.id: u for u in db.execute(select(User)).scalars()}

    stmt = active_page_query(db, f, apply_paging=True).options(
        selectinload(PageVersion.logical_page)
        .selectinload(LogicalPage.document)
        .selectinload(Document.batch),
        selectinload(PageVersion.logical_page)
        .selectinload(LogicalPage.document)
        .selectinload(Document.case),
        selectinload(PageVersion.quality).selectinload(QualityResult.findings),
        selectinload(PageVersion.handwriting).selectinload(HandwritingResult.regions),
        selectinload(PageVersion.diagnoses).selectinload(DiagnosisExtraction.reviews),
        selectinload(PageVersion.reviews),
    )

    out: list[dict[str, Any]] = []
    for pv in db.execute(stmt.execution_options(yield_per=1000)).scalars():
        out.append(_page_row(pv, users))
    return out


def rescan_rows(db: Session, f: PageFilters) -> list[dict[str, Any]]:
    """Rows for ``/reports/rescan-checklist.pdf``.

    Per docs/API.md: pages classed ``rescan``, plus any page a reviewer has explicitly asked to be
    rescanned (which may be classed ``review``, or even ``acceptable`` if the reviewer saw something
    the engine did not). The union is taken here rather than in the route so the checklist and the
    dashboard cannot drift apart.
    """
    rows = page_rows(db, f)
    if f.page_class or f.review_state:
        return rows  # caller narrowed it deliberately; respect that

    requested: set[str] = set()
    ids = _core_select(f, PageVersion.id).distinct()
    for (pv_id,) in db.execute(
        select(distinct(PageReview.page_version_id)).where(
            PageReview.action == "request_rescan",
            PageReview.page_version_id.in_(ids),
        )
    ).all():
        requested.add(pv_id)

    return [
        r
        for r in rows
        if r["scan_status"] == PageClass.rescan.value or r["_page_version_id"] in requested
    ]
