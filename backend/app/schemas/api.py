"""Request and response shapes. Mirrors docs/API.md."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    is_active: bool

    class Config:
        from_attributes = True


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = ""
    password: str = Field(min_length=8)
    role: str = "uploader"


class UserPatch(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    full_name: str | None = None
    password: str | None = Field(default=None, min_length=8)


class BatchIn(BaseModel):
    name: str
    note: str = ""


class BatchOut(BaseModel):
    id: str
    name: str
    note: str
    created_at: datetime
    document_count: int = 0
    page_count: int = 0


class CaseIn(BaseModel):
    batch_id: str
    patient_ref: str = ""
    encounter_ref: str
    checklist_id: str | None = None


class CaseOut(BaseModel):
    id: str
    batch_id: str
    patient_ref: str
    encounter_ref: str
    checklist_id: str | None
    confirmed_by: str | None
    confirmed_at: datetime | None
    document_count: int = 0


class UploadResult(BaseModel):
    filename: str
    document_id: str | None
    status: str            # accepted | rejected | duplicate
    message: str = ""
    page_count: int | None = None
    job_id: str | None = None


class FindingOut(BaseModel):
    code: str
    label: str
    severity: str
    confidence: float | None
    source: str
    detail: str
    region: dict[str, int] | None


class HandwritingRegionOut(BaseModel):
    id: str
    category: str
    category_confidence: float | None
    confidence: float | None
    script_hint: str
    polygon: list[list[float]]
    model_version: str


class DiagnosisOut(BaseModel):
    id: str
    status: str
    anchor_label: str
    raw_text: str
    cleaned_text: str
    qualifier: str
    icd_code_verbatim: str | None
    is_handwritten: bool
    region: dict[str, Any] | None
    confidence: float | None
    model_version: str
    provider_used: str | None
    error: str | None
    extracted_at: datetime
    is_reviewed: bool
    reviews: list["DiagnosisReviewOut"] = []
    source: dict[str, Any] | None = None


class DiagnosisReviewOut(BaseModel):
    id: str
    reviewer_id: str
    reviewer_email: str | None = None
    action: str
    corrected_text: str | None
    corrected_qualifier: str | None
    comment: str
    created_at: datetime


class DiagnosisReviewIn(BaseModel):
    action: str                       # confirm | correct | reject
    corrected_text: str | None = None
    corrected_qualifier: str | None = None
    comment: str = ""


class PageVersionRef(BaseModel):
    id: str
    version_no: int
    is_active: bool
    created_at: datetime
    created_by: str | None
    width: int
    height: int
    replaces_version_id: str | None = None


class PageSummary(BaseModel):
    page_version_id: str
    logical_page_id: str
    document_id: str
    batch_id: str
    batch_name: str | None = None
    case_id: str | None = None
    patient_ref: str | None = None
    encounter_ref: str | None = None
    document_filename: str
    ordinal: int
    printed_page_label: str | None
    version_no: int
    width: int
    height: int
    colour_mode: str
    capture_profile: str
    page_class: str
    quality_score: float | None
    defect_codes: list[str]
    handwriting_status: str
    handwriting_categories: list[str]
    diagnosis_status: str
    review_state: str
    uploaded_at: datetime


class DocumentPageRef(BaseModel):
    page_version_id: str
    ordinal: int
    printed_page_label: str | None
    page_class: str


class PageDetail(PageSummary):
    findings: list[FindingOut] = []
    handwriting_regions: list[HandwritingRegionOut] = []
    handwriting_error: str | None = None
    diagnoses: list[DiagnosisOut] = []
    versions: list[PageVersionRef] = []
    metrics: dict[str, Any] = {}
    provider_used: str | None = None
    provider_error: str | None = None
    reviews: list[dict[str, Any]] = []
    document_pages: list[DocumentPageRef] = []


class PageReviewIn(BaseModel):
    action: str                       # accept | request_rescan | correct_finding | comment
    comment: str = ""
    payload: dict[str, Any] = {}


class PagedPages(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[PageSummary]


class ChecklistItemIn(BaseModel):
    doc_type: str
    min_pages: int = 1
    required: bool = True


class ChecklistIn(BaseModel):
    name: str
    items: list[ChecklistItemIn] = []
    is_active: bool = True


class ThresholdsIn(BaseModel):
    values: dict[str, float]


TokenOut.model_rebuild()
DiagnosisOut.model_rebuild()
