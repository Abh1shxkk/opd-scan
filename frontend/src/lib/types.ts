/**
 * Types mirroring the REST contract in docs/API.md and the enums in
 * backend/app/models/core.py.
 *
 * Two conventions worth stating up front, because they drive most of the UI code:
 *
 * 1. Anything the backend may legitimately not know is typed `| null`, never defaulted to a
 *    number or an empty string. `confidence: number | null` means "the API did not supply a
 *    confidence" and the UI must render nothing rather than invent a percentage.
 * 2. Statuses are unions of the exact backend enum values. Presentation strings live in
 *    `lib/status.ts` — never inline — so the "not checked" / "no handwriting" distinction
 *    cannot be got wrong in one screen and right in another.
 */

// ------------------------------------------------------------------ identity

export type Role = 'admin' | 'uploader' | 'reviewer';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

// -------------------------------------------------------------------- enums

/**
 * `blank`, `failed` and `unchecked` are first-class classes. They are never folded into
 * `acceptable` — see the counting rules in docs/PLAN.md §3.
 */
export type PageClass = 'acceptable' | 'review' | 'rescan' | 'blank' | 'failed' | 'unchecked';

export type Severity = 'low' | 'medium' | 'high';

/** `failed` and `unconfigured` mean "not checked" — NEVER "no handwriting". */
export type HandwritingStatus = 'detected' | 'none_detected' | 'failed' | 'unconfigured' | 'pending';

export type HandwritingCategory =
  | 'note'
  | 'signature'
  | 'stamp'
  | 'tick'
  | 'correction'
  | 'uncertain';

export type ScriptHint = 'latin' | 'devanagari' | 'mixed' | 'unknown';

export type DiagnosisStatus =
  | 'extracted_pending_review'
  | 'not_found'
  | 'unreadable'
  | 'uncertain'
  | 'processing_failed'
  | 'unconfigured'
  | 'pending';

export type Qualifier =
  | 'final'
  | 'provisional'
  | 'suspected'
  | 'differential'
  | 'ruled_out'
  | 'negated'
  | 'past_history'
  | 'unspecified';

export type ReviewState = 'pending' | 'accepted' | 'rescan_requested';

export type PageReviewAction = 'accept' | 'request_rescan' | 'correct_finding' | 'comment';

export type DiagnosisReviewAction = 'confirm' | 'correct' | 'reject';

export type IngestStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'password_protected'
  | 'corrupted';

export type JobKind = 'ingest' | 'quality' | 'handwriting' | 'diagnosis';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type CaptureProfile = 'flatbed' | 'photo' | 'unknown';
export type ColourMode = 'colour' | 'grey' | 'bitonal';

export type CompletenessStatus = 'verified' | 'incomplete' | 'not_verified';

// --------------------------------------------------------------- geometry

/** Region coordinates are in ORIGINAL RENDER PIXELS, i.e. the page_version width/height space. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `[[x, y], ...]`, likewise in original render pixels. */
export type Polygon = Array<[number, number]>;

// ------------------------------------------------------------ records

export interface Batch {
  id: string;
  name: string;
  note: string;
  created_by: string | null;
  created_at: string;
  document_count?: number;
  page_count?: number;
}

export interface Case {
  id: string;
  batch_id: string;
  patient_ref: string;
  encounter_ref: string;
  checklist_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface DocumentSummary {
  id: string;
  batch_id: string;
  batch_name?: string | null;
  case_id: string | null;
  patient_ref?: string | null;
  encounter_ref?: string | null;
  original_filename: string;
  mime: string;
  byte_size: number;
  page_count: number;
  uploaded_by: string | null;
  uploaded_at: string;
  ingest_status: IngestStatus;
  ingest_error: string | null;
  /** Roll-up of active page versions in this document, when the API supplies it. */
  page_class_counts?: Partial<Record<PageClass, number>>;
}

// ------------------------------------------------------------- quality

export interface QualityFinding {
  id: string;
  /** One of the codes in backend/app/processing/quality/rules.py. */
  code: string;
  /** Human label supplied by the backend; `lib/defects.ts` is the fallback. */
  label?: string | null;
  severity: Severity;
  detail: string;
  /** null when the engine did not attach a confidence — render nothing, not "0%". */
  confidence: number | null;
  source: 'local' | 'provider';
  region: Region | null;
}

export interface QualityResult {
  overall: PageClass;
  score: number | null;
  engine_version: string;
  thresholds_hash: string;
  provider_used: string | null;
  provider_error: string | null;
  computed_at: string;
  findings: QualityFinding[];
  raw_metrics?: Record<string, unknown>;
}

// --------------------------------------------------------- handwriting

export interface HandwritingRegion {
  id: string;
  category: HandwritingCategory;
  category_confidence: number | null;
  confidence: number | null;
  script_hint: ScriptHint;
  polygon: Polygon;
  model_version?: string;
}

export interface HandwritingResult {
  status: HandwritingStatus;
  model_version: string;
  provider_used: string | null;
  error: string | null;
  computed_at: string;
  regions: HandwritingRegion[];
}

// ----------------------------------------------------------- diagnosis

export interface DiagnosisReview {
  id: string;
  extraction_id: string;
  reviewer_id: string;
  reviewer_name?: string | null;
  action: DiagnosisReviewAction;
  corrected_text: string | null;
  corrected_qualifier: Qualifier | null;
  comment: string;
  created_at: string;
}

export interface DiagnosisExtraction {
  id: string;
  page_version_id: string;
  status: DiagnosisStatus;
  /** The label literally found on the page, e.g. "Final Diagnosis" or the printed "Deagnosis". */
  anchor_label: string;
  /** Immutable transcription. Always displayed, even after a correction. */
  raw_text: string;
  /** Whitespace/punctuation tidying only. Presentation, never a clinical change. */
  cleaned_text: string;
  qualifier: Qualifier;
  /** Only present when a code is literally written on the page. */
  icd_code_verbatim: string | null;
  is_handwritten: boolean;
  region: Region | null;
  confidence: number | null;
  model_version: string;
  provider_used?: string | null;
  error?: string | null;
  extracted_at: string;
  /** Named transformations applied to produce cleaned_text, for audit. */
  cleaning_applied?: string[];
  /** Abbreviations recognised as ambiguous and deliberately NOT expanded. */
  ambiguous_abbreviations?: string[];
  note?: string;
  reviews?: DiagnosisReview[];
  is_reviewed?: boolean;
}

/** `/diagnoses/{id}` — the extraction plus enough page context to show the source image. */
export interface DiagnosisDetail extends DiagnosisExtraction {
  page: PageRef;
  reviews: DiagnosisReview[];
}

export interface PageRef {
  page_version_id: string;
  logical_page_id: string;
  document_id: string;
  document_filename: string;
  batch_id?: string | null;
  batch_name?: string | null;
  /** Present when the document has been attached to a patient encounter. */
  case_id?: string | null;
  patient_ref?: string | null;
  encounter_ref?: string | null;
  ordinal: number;
  printed_page_label: string | null;
  version_no: number;
  /** Original render dimensions — the coordinate space every region/polygon uses. */
  width: number;
  height: number;
}

// ---------------------------------------------------------------- pages

export interface PageReviewEntry {
  id: string;
  page_version_id: string;
  reviewer_id: string;
  reviewer_name?: string | null;
  action: PageReviewAction;
  comment: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface PageVersionRef {
  id: string;
  version_no: number;
  is_active: boolean;
  replaces_version_id: string | null;
  width: number;
  height: number;
  colour_mode: ColourMode;
  capture_profile: CaptureProfile;
  dpi_estimate: number | null;
  created_by: string | null;
  created_at: string;
  /** Class of that version, so superseded versions can show what they were. */
  page_class?: PageClass;
}

/** A row of `GET /pages` — always an ACTIVE page version. */
export interface PageSummary extends PageRef {
  page_class: PageClass;
  quality_score: number | null;
  /** Scan defects only. Handwriting is never in this list. */
  defect_codes: string[];
  defect_severities?: Severity[];
  handwriting_status: HandwritingStatus;
  handwriting_region_count?: number;
  diagnosis_status: DiagnosisStatus | null;
  diagnosis_count?: number;
  review_state: ReviewState;
  colour_mode?: ColourMode;
  capture_profile?: CaptureProfile;
  uploaded_at?: string;
}

/** `GET /pages/{page_version_id}` */
export interface PageDetail extends PageSummary {
  quality: QualityResult | null;
  handwriting: HandwritingResult | null;
  diagnoses: DiagnosisExtraction[];
  versions: PageVersionRef[];
  reviews: PageReviewEntry[];
  /** Sibling pages of the same document, for the thumbnail strip. */
  document_pages?: Array<{
    page_version_id: string;
    ordinal: number;
    printed_page_label: string | null;
    page_class: PageClass;
  }>;
}

// ------------------------------------------------------------ dashboard

export interface DashboardTotals {
  files: number;
  pages_active: number;
  processing: { queued: number; running: number; failed: number };
  quality: Record<PageClass, number>;
  handwriting: Record<HandwritingStatus, number>;
  diagnosis: Record<DiagnosisStatus, number>;
  awaiting_review: number;
}

export interface DashboardOverlaps {
  defect_and_handwriting: number;
  defect_only: number;
  handwriting_only: number;
}

export interface DefectCount {
  code: string;
  label: string;
  pages: number;
}

export interface Capability {
  status: 'ready' | 'unconfigured';
  provider?: string | null;
  setup_required?: string | null;
  detail?: Record<string, unknown>;
}

export type CapabilityMap = Record<string, Capability>;

export interface DashboardResponse {
  totals: DashboardTotals;
  overlaps: DashboardOverlaps;
  defects: DefectCount[];
  capabilities: CapabilityMap;
}

// -------------------------------------------------------------- upload

export interface UploadResultRow {
  document_id: string | null;
  /** `rejected` carries a human-readable `message` explaining exactly why. */
  status: IngestStatus | 'accepted' | 'rejected';
  message: string;
  filename?: string;
}

export interface UploadResponse {
  results: UploadResultRow[];
}

// -------------------------------------------------------- completeness

export interface CompletenessResponse {
  status: CompletenessStatus;
  findings: Record<string, unknown>;
  computed_at?: string | null;
  checklist_id?: string | null;
  checklist_name?: string | null;
}

// ----------------------------------------------------------- jobs etc.

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  document_id: string | null;
  page_version_id: string | null;
  attempt: number;
  max_attempts: number;
  error: string | null;
  progress: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ThresholdsResponse {
  thresholds: Record<string, number>;
  defaults?: Record<string, number>;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface RetentionInfo {
  retention_days_originals: number;
  retention_days_derivatives: number;
  max_upload_mb?: number;
  max_pages_per_document?: number;
}

export interface CapabilitiesResponse {
  capabilities: CapabilityMap;
  retention?: RetentionInfo;
}

export interface Checklist {
  id: string;
  name: string;
  is_active: boolean;
  items?: Array<{ id: string; doc_type: string; min_pages: number; required: boolean }>;
}

// ------------------------------------------------------------- paging

export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
