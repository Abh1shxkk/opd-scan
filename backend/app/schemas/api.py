"""Request and response shapes. Mirrors docs/API.md."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: str
    email: str | None = None
    username: str | None = None
    full_name: str
    role: str
    is_active: bool
    # The frontend's User type has always required this; it was simply never sent, because until
    # now nothing rendered a user list.
    created_at: datetime | None = None

    class Config:
        from_attributes = True


class UserCreate(BaseModel):
    """At least one of ``email`` / ``username`` must be given — the route enforces that.

    Neither is individually required: staff are often issued a username and no mailbox, and making
    an address mandatory would only produce invented ones.

    ``email`` is a plain string, not ``EmailStr``. Strict validation refuses reserved top-level
    domains — ``.local``, ``.internal``, ``.test`` — which is exactly what a hospital's internal
    mail domain looks like, and this deployment's own seeded administrator could not be saved
    through a form that used it. The address is an identifier to sign in with here, not something
    this system sends mail to, so it is checked for shape and left alone otherwise.
    """

    email: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=64)
    full_name: str = ""
    password: str = Field(min_length=8)
    role: str = "uploader"


class UserPatch(BaseModel):
    # Identifiers are editable, but only one of the two may be cleared — an account with neither
    # could not be signed into and would be unreachable except through the database.
    # A plain string for the same reason as UserCreate: internal hospital domains are valid here.
    email: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=64)
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
    # Intake-form fields. Always present in the response (empty string / null when not recorded)
    # so the frontend never has to distinguish "absent from this payload" from "not filled in".
    patient_name: str = ""
    department: str = ""
    mobile: str = ""
    disease: str = ""
    icd_code: str = ""
    consultant_name: str = ""
    discharge_type: str = ""
    mlc_type: str = ""
    admission_date: date | None = None
    discharge_date: date | None = None
    record_date: date | None = None
    created_at: datetime | None = None
    # Enough to open the scan without a second round-trip: how many pages this case has, and the
    # first one, which is what the "open" action on the patient list navigates to.
    page_count: int = 0
    first_page_version_id: str | None = None
    # Live processing state, so the patient list can say what is still happening rather than
    # showing a finished-looking row for a record the workers have not touched yet.
    documents_pending: int = 0
    pages_measured: int = 0
    jobs_active: int = 0
    ingest_failed: int = 0


class CasePatch(BaseModel):
    """Editable intake fields.

    Every field is optional and only the ones actually sent are written, so a form that edits one
    value cannot blank the rest. `patient_ref` and `encounter_ref` are deliberately absent: they
    identify the case, and renaming an identity in place is how two patients' records merge.
    """

    patient_name: str | None = None
    department: str | None = None
    mobile: str | None = None
    disease: str | None = None
    icd_code: str | None = None
    consultant_name: str | None = None
    discharge_type: str | None = None
    mlc_type: str | None = None
    admission_date: date | None = None
    discharge_date: date | None = None
    record_date: date | None = None
    # Which checklist this record is measured against. Settable here because a case is created
    # before anyone knows what kind of record it is — without this the completeness feature could
    # never be reached at all: nothing else in the product ever set it.
    # Sending null detaches the checklist, which is why it is typed as an explicit union rather
    # than relying on the "unset means unchanged" rule alone.
    checklist_id: str | None = None


class IntakeOut(BaseModel):
    """What the intake screen gets back: the case that was created or reused, plus one row per
    uploaded file (accepted / rejected / duplicate, exactly like the batch uploader reports)."""

    case: CaseOut
    documents: list["UploadResult"]


class IntakeLookupOut(BaseModel):
    """Previous intake for an MR number, used to prefill the form. ``found`` is false when the MR
    number has never been seen — the form then stays blank rather than inventing anything."""

    found: bool
    case: CaseOut | None = None


class IntakeOptionsOut(BaseModel):
    """Dropdown values for the intake form, editable by an admin in Settings."""

    departments: list[str]
    discharge_types: list[str]
    mlc_types: list[str]


class UploadResult(BaseModel):
    filename: str
    document_id: str | None
    status: str            # accepted | rejected | duplicate
    message: str = ""
    page_count: int | None = None
    job_id: str | None = None


class FindingOut(BaseModel):
    id: str
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


class QualityOut(BaseModel):
    overall: str
    score: float | None
    engine_version: str
    thresholds_hash: str
    provider_used: str | None
    provider_error: str | None
    computed_at: datetime
    findings: list[FindingOut]


class HandwritingOut(BaseModel):
    status: str
    model_version: str
    provider_used: str | None
    error: str | None
    computed_at: datetime
    regions: list[HandwritingRegionOut]


class MedicineOut(BaseModel):
    name: str
    dose: str
    frequency: str
    duration: str
    general_use: str
    confidence: str
    uncertainty: str | None


class PrescriptionOut(BaseModel):
    status: str
    language_detected: str | None
    raw_extracted_text: str
    diagnosis_or_notes: str
    possible_interpretation: str
    patient_explanation: str
    medicines: list[MedicineOut]
    safety_warnings: list[str]
    uncertainties: list[str]
    requires_professional_confirmation: bool
    ocr_provider_used: str | None
    reasoning_provider_used: str | None
    model_version: str
    error: str | None
    computed_at: datetime


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
    # Safety context from the extractor. It is persisted inside `region_json` (see
    # services/pipeline.py) and lifted back out when serialising, so a reviewer can see what was
    # changed on the way from `raw_text` to `cleaned_text` and which abbreviations were left
    # deliberately unexpanded. Never inferred, never filled in when the extractor said nothing.
    note: str | None = None
    cleaning_applied: list[str] = []
    ambiguous_abbreviations: list[str] = []
    confidence: float | None
    model_version: str
    provider_used: str | None
    error: str | None
    extracted_at: datetime
    is_reviewed: bool
    # What a reviewer corrected this to, if anyone did. The extraction's own raw_text/cleaned_text
    # are never rewritten, so these are additive: null here means "nobody has corrected this",
    # which must stay distinguishable from "corrected to the same thing". Without them the page
    # viewer showed the AI's original reading long after a reviewer had fixed it.
    corrected_text: str | None = None
    corrected_qualifier: str | None = None
    corrected_at: datetime | None = None
    corrected_by_name: str | None = None
    reviews: list["DiagnosisReviewOut"] = []
    # The frontend's DiagnosisDetail type reads this field as `page` (a PageRef shape) — the key
    # and its inner field names must match exactly, not just carry equivalent data.
    page: dict[str, Any] | None = None


class DiagnosisReviewOut(BaseModel):
    id: str
    reviewer_id: str
    reviewer_email: str | None = None
    # The name a human recognises. A review trail identified only by UUID cannot be read by the
    # people whose decisions it records.
    reviewer_name: str | None = None
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
    # How this version was captured, and what the engine made of it. The version-history list
    # exists so a reviewer can see whether a rescan actually improved anything — without these it
    # shows "— · —" on every row and answers nothing.
    colour_mode: str | None = None
    capture_profile: str | None = None
    dpi_estimate: int | None = None
    page_class: str | None = None


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
    handwriting_region_count: int | None = None
    diagnosis_status: str
    # None when prescription analysis has never been requested for this page — distinct from any
    # PrescriptionStatus value, all of which mean it was at least attempted.
    prescription_status: str | None = None
    review_state: str
    uploaded_at: datetime


class DocumentPageRef(BaseModel):
    page_version_id: str
    ordinal: int
    printed_page_label: str | None
    page_class: str


class PageDetail(PageSummary):
    # Flat fields, used by the pages list/table and by any consumer that only needs a summary.
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
    # Nested, used by the page-detail viewer — the frontend's QualityPanel/HandwritingPanel read
    # these, not the flat fields above (which exist for the pages list/table).
    quality: QualityOut | None = None
    handwriting: HandwritingOut | None = None
    prescription: PrescriptionOut | None = None


class PageReviewIn(BaseModel):
    action: str                       # accept | request_rescan | correct_finding | correct_prescription | comment
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
