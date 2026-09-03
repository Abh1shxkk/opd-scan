"""SQLAlchemy models.

Design notes that matter clinically and are easy to get wrong:

* ``Document.storage_key_original`` is written once at ingest and never updated. Enhancement,
  annotation and rescan all produce *new* rows elsewhere.
* ``LogicalPage`` is the stable identity of "page 7 of this record". A rescan creates a new
  ``PageVersion`` attached to the same ``LogicalPage``; only ``is_active`` versions are counted.
* Quality, handwriting and diagnosis each have their own result row and their own status, so a
  failure in one never masquerades as a clean result in another.
* ``DiagnosisExtraction.raw_text`` is immutable. Reviewer corrections are appended as
  ``DiagnosisReview`` rows; the original AI output is never overwritten.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    admin = "admin"
    uploader = "uploader"
    reviewer = "reviewer"


class IngestStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    rejected = "rejected"          # bad type / too large / too many pages
    password_protected = "password_protected"
    corrupted = "corrupted"


class PageClass(str, enum.Enum):
    unchecked = "unchecked"
    acceptable = "acceptable"
    review = "review"
    rescan = "rescan"
    blank = "blank"                # deliberate: blank is NOT a defect and NOT "acceptable"
    failed = "failed"


class Severity(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class HandwritingStatus(str, enum.Enum):
    detected = "detected"
    none_detected = "none_detected"
    failed = "failed"
    unconfigured = "unconfigured"
    pending = "pending"


class HandwritingCategory(str, enum.Enum):
    note = "note"
    signature = "signature"
    stamp = "stamp"
    tick = "tick"
    correction = "correction"
    uncertain = "uncertain"


class DiagnosisStatus(str, enum.Enum):
    pending = "pending"
    extracted_pending_review = "extracted_pending_review"
    not_found = "not_found"
    unreadable = "unreadable"
    uncertain = "uncertain"
    processing_failed = "processing_failed"
    unconfigured = "unconfigured"


class Qualifier(str, enum.Enum):
    final = "final"
    provisional = "provisional"
    suspected = "suspected"
    differential = "differential"
    ruled_out = "ruled_out"
    negated = "negated"
    past_history = "past_history"
    unspecified = "unspecified"


class JobKind(str, enum.Enum):
    ingest = "ingest"
    quality = "quality"
    handwriting = "handwriting"
    diagnosis = "diagnosis"


class JobState(str, enum.Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class CaptureProfile(str, enum.Enum):
    flatbed = "flatbed"
    photo = "photo"
    unknown = "unknown"


class ColourMode(str, enum.Enum):
    colour = "colour"
    grey = "grey"
    bitonal = "bitonal"


# ---------------------------------------------------------------- identity


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.uploader)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuditEvent(Base):
    """Append-only. Records access, change and review. Never contains patient text."""

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    actor_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


# ---------------------------------------------------------------- records


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), index=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)

    documents: Mapped[list[Document]] = relationship(back_populates="batch")
    cases: Mapped[list[Case]] = relationship(back_populates="batch")


class Case(Base):
    """A patient/encounter grouping. References are human-entered or human-confirmed.

    Nothing in this codebase merges two cases because OCR text looked similar.
    """

    __tablename__ = "cases"
    __table_args__ = (UniqueConstraint("batch_id", "encounter_ref", name="uq_case_batch_encounter"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("batches.id"), index=True)
    patient_ref: Mapped[str] = mapped_column(String(128), default="", index=True)
    encounter_ref: Mapped[str] = mapped_column(String(128), index=True)
    checklist_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("checklists.id"), nullable=True)
    confirmed_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    batch: Mapped[Batch] = relationship(back_populates="cases")
    documents: Mapped[list[Document]] = relationship(back_populates="case")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("batches.id"), index=True)
    case_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cases.id"), index=True, nullable=True)
    original_filename: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    mime: Mapped[str] = mapped_column(String(128), default="")
    byte_size: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    ingest_status: Mapped[IngestStatus] = mapped_column(Enum(IngestStatus), default=IngestStatus.pending, index=True)
    ingest_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_key_original: Mapped[str] = mapped_column(String(512))  # immutable

    batch: Mapped[Batch] = relationship(back_populates="documents")
    case: Mapped[Case | None] = relationship(back_populates="documents")
    pages: Mapped[list[LogicalPage]] = relationship(back_populates="document", cascade="all, delete-orphan")


class LogicalPage(Base):
    __tablename__ = "logical_pages"
    __table_args__ = (UniqueConstraint("document_id", "ordinal", name="uq_page_doc_ordinal"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(String(36), ForeignKey("documents.id"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)                       # 1-based within the document
    source_page_index: Mapped[int] = mapped_column(Integer, default=0)  # 0-based index in the original file
    spread_half: Mapped[str] = mapped_column(String(8), default="none")  # none|left|right
    printed_page_label: Mapped[str | None] = mapped_column(String(32), nullable=True)  # e.g. "(22)"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    document: Mapped[Document] = relationship(back_populates="pages")
    versions: Mapped[list[PageVersion]] = relationship(
        back_populates="logical_page", cascade="all, delete-orphan", order_by="PageVersion.version_no"
    )

    @property
    def active_version(self) -> PageVersion | None:
        for v in self.versions:
            if v.is_active:
                return v
        return None


class PageVersion(Base):
    __tablename__ = "page_versions"
    __table_args__ = (
        UniqueConstraint("logical_page_id", "version_no", name="uq_version_page_no"),
        Index("ix_pv_active", "logical_page_id", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    logical_page_id: Mapped[str] = mapped_column(String(36), ForeignKey("logical_pages.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    replaces_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    storage_key_render: Mapped[str] = mapped_column(String(512))
    storage_key_thumb: Mapped[str | None] = mapped_column(String(512), nullable=True)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    dpi_estimate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    colour_mode: Mapped[ColourMode] = mapped_column(Enum(ColourMode), default=ColourMode.colour)
    capture_profile: Mapped[CaptureProfile] = mapped_column(Enum(CaptureProfile), default=CaptureProfile.unknown)

    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    logical_page: Mapped[LogicalPage] = relationship(back_populates="versions")
    quality: Mapped[QualityResult | None] = relationship(
        back_populates="page_version", uselist=False, cascade="all, delete-orphan"
    )
    handwriting: Mapped[HandwritingResult | None] = relationship(
        back_populates="page_version", uselist=False, cascade="all, delete-orphan"
    )
    diagnoses: Mapped[list[DiagnosisExtraction]] = relationship(
        back_populates="page_version", cascade="all, delete-orphan"
    )
    reviews: Mapped[list[PageReview]] = relationship(back_populates="page_version", cascade="all, delete-orphan")


# ---------------------------------------------------------------- quality


class QualityResult(Base):
    __tablename__ = "quality_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("page_versions.id"), unique=True, index=True
    )
    engine_version: Mapped[str] = mapped_column(String(64), default="")
    thresholds_hash: Mapped[str] = mapped_column(String(64), default="")
    overall: Mapped[PageClass] = mapped_column(Enum(PageClass), default=PageClass.unchecked, index=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    provider_used: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_metrics_json: Mapped[dict] = mapped_column(JSON, default=dict)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    page_version: Mapped[PageVersion] = relationship(back_populates="quality")
    findings: Mapped[list[QualityFinding]] = relationship(
        back_populates="result", cascade="all, delete-orphan"
    )


class QualityFinding(Base):
    __tablename__ = "quality_findings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    quality_result_id: Mapped[str] = mapped_column(String(36), ForeignKey("quality_results.id"), index=True)
    defect_code: Mapped[str] = mapped_column(String(64), index=True)
    severity: Mapped[Severity] = mapped_column(Enum(Severity), default=Severity.medium)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="local")  # local | provider
    detail: Mapped[str] = mapped_column(Text, default="")
    region_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    result: Mapped[QualityResult] = relationship(back_populates="findings")


# ---------------------------------------------------------- handwriting


class HandwritingResult(Base):
    __tablename__ = "handwriting_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("page_versions.id"), unique=True, index=True
    )
    status: Mapped[HandwritingStatus] = mapped_column(
        Enum(HandwritingStatus), default=HandwritingStatus.pending, index=True
    )
    model_version: Mapped[str] = mapped_column(String(128), default="")
    provider_used: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    page_version: Mapped[PageVersion] = relationship(back_populates="handwriting")
    regions: Mapped[list[HandwritingRegion]] = relationship(
        back_populates="result", cascade="all, delete-orphan"
    )


class HandwritingRegion(Base):
    __tablename__ = "handwriting_regions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    handwriting_result_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("handwriting_results.id"), index=True
    )
    category: Mapped[HandwritingCategory] = mapped_column(
        Enum(HandwritingCategory), default=HandwritingCategory.uncertain
    )
    category_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    script_hint: Mapped[str] = mapped_column(String(32), default="unknown")
    polygon_json: Mapped[list] = mapped_column(JSON, default=list)  # [[x,y], ...] in image pixels
    model_version: Mapped[str] = mapped_column(String(128), default="")

    result: Mapped[HandwritingResult] = relationship(back_populates="regions")


# ----------------------------------------------------------- diagnosis


class DiagnosisExtraction(Base):
    __tablename__ = "diagnosis_extractions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_version_id: Mapped[str] = mapped_column(String(36), ForeignKey("page_versions.id"), index=True)
    status: Mapped[DiagnosisStatus] = mapped_column(
        Enum(DiagnosisStatus), default=DiagnosisStatus.pending, index=True
    )
    anchor_label: Mapped[str] = mapped_column(String(128), default="")   # the label found on the page
    raw_text: Mapped[str] = mapped_column(Text, default="")              # immutable transcription
    cleaned_text: Mapped[str] = mapped_column(Text, default="")          # presentation only
    qualifier: Mapped[Qualifier] = mapped_column(Enum(Qualifier), default=Qualifier.unspecified)
    icd_code_verbatim: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_handwritten: Mapped[bool] = mapped_column(Boolean, default=False)
    region_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_version: Mapped[str] = mapped_column(String(128), default="")
    provider_used: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    extracted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    page_version: Mapped[PageVersion] = relationship(back_populates="diagnoses")
    reviews: Mapped[list[DiagnosisReview]] = relationship(
        back_populates="extraction", cascade="all, delete-orphan", order_by="DiagnosisReview.created_at"
    )

    @property
    def is_reviewed(self) -> bool:
        return bool(self.reviews)


class DiagnosisReview(Base):
    """Append-only correction history. The AI's original output is never modified."""

    __tablename__ = "diagnosis_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    extraction_id: Mapped[str] = mapped_column(String(36), ForeignKey("diagnosis_extractions.id"), index=True)
    reviewer_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(32))  # confirm | correct | reject
    corrected_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    corrected_qualifier: Mapped[Qualifier | None] = mapped_column(Enum(Qualifier), nullable=True)
    comment: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    extraction: Mapped[DiagnosisExtraction] = relationship(back_populates="reviews")


class PageReview(Base):
    __tablename__ = "page_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    page_version_id: Mapped[str] = mapped_column(String(36), ForeignKey("page_versions.id"), index=True)
    reviewer_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(32), index=True)  # accept|request_rescan|correct_finding|comment
    comment: Mapped[str] = mapped_column(Text, default="")
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    page_version: Mapped[PageVersion] = relationship(back_populates="reviews")


# -------------------------------------------------------- completeness


class Checklist(Base):
    __tablename__ = "checklists"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    items: Mapped[list[ChecklistItem]] = relationship(cascade="all, delete-orphan")


class ChecklistItem(Base):
    __tablename__ = "checklist_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    checklist_id: Mapped[str] = mapped_column(String(36), ForeignKey("checklists.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(128))
    min_pages: Mapped[int] = mapped_column(Integer, default=1)
    required: Mapped[bool] = mapped_column(Boolean, default=True)


class CompletenessResult(Base):
    __tablename__ = "completeness_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("cases.id"), unique=True, index=True)
    # 'not_verified' is the default and is what the UI shows when no checklist exists.
    status: Mapped[str] = mapped_column(String(32), default="not_verified")
    findings_json: Mapped[dict] = mapped_column(JSON, default=dict)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ---------------------------------------------------------------- jobs


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_job_idem"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    kind: Mapped[JobKind] = mapped_column(Enum(JobKind), index=True)
    state: Mapped[JobState] = mapped_column(Enum(JobState), default=JobState.queued, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(255))
    document_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("documents.id"), nullable=True)
    page_version_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("page_versions.id"), nullable=True, index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
