/**
 * The API shapes the app uses. Mirrors frontend/src/lib/types.ts (the web app) — only the subset the
 * mobile screens need. If the backend contract changes, change both.
 */

export type Role = 'admin' | 'uploader' | 'reviewer';

export interface User {
  id: string;
  email: string | null;
  username: string | null;
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

export type PageClass = 'acceptable' | 'review' | 'rescan' | 'blank' | 'failed' | 'unchecked';
export type ReviewState = 'pending' | 'accepted' | 'rescan_requested';
export type PageReviewAction = 'accept' | 'request_rescan' | 'comment';

export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface Case {
  id: string;
  batch_id: string;
  patient_ref: string;
  encounter_ref: string;
  created_at: string;
  document_count: number;
  page_count: number;
  first_page_version_id: string | null;
  documents_pending: number;
  pages_measured: number;
  jobs_active: number;
  ingest_failed: number;
  patient_name: string;
  department: string;
  mobile: string;
  disease: string;
  icd_code: string;
  consultant_name: string;
  discharge_type: string;
  mlc_type: string;
  admission_date: string | null;
  discharge_date: string | null;
  record_date: string | null;
}

export interface IntakeOptions {
  departments: string[];
  discharge_types: string[];
  mlc_types: string[];
}

export interface IntakeLookupResponse {
  found: boolean;
  case: Case | null;
}

export interface UploadResultRow {
  filename: string;
  document_id: string | null;
  status: 'accepted' | 'rejected' | 'duplicate';
  message: string;
  page_count: number | null;
  job_id: string | null;
}

export interface IntakeResponse {
  case: Case;
  documents: UploadResultRow[];
}

export interface IntakeFormValues {
  mr_number: string;
  ipd_number: string;
  patient_name: string;
  department: string;
  mobile: string;
  disease: string;
  icd_code: string;
  consultant_name: string;
  discharge_type: string;
  mlc_type: string;
  admission_date: string;
  discharge_date: string;
  record_date: string;
}

export interface DocumentSummary {
  id: string;
  case_id: string | null;
  patient_ref?: string | null;
  encounter_ref?: string | null;
  original_filename: string;
  page_count: number;
  uploaded_at: string;
  ingest_status: string;
  ingest_error: string | null;
  pages_active?: number;
  awaiting_review?: number;
}

export interface PageSummary {
  page_version_id: string;
  document_id: string;
  document_filename: string;
  case_id?: string | null;
  patient_ref?: string | null;
  encounter_ref?: string | null;
  ordinal: number;
  printed_page_label: string | null;
  version_no: number;
  width: number;
  height: number;
  page_class: PageClass;
  quality_score: number | null;
  review_state: ReviewState;
  uploaded_at: string;
}

export interface Finding {
  id: string;
  code: string;
  label: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export interface PageReview {
  action: string;
  comment: string;
  created_at: string;
  reviewer_name?: string | null;
}

export interface PageDetail extends PageSummary {
  findings: Finding[];
  reviews: PageReview[];
  document_pages?: Array<{
    page_version_id: string;
    ordinal: number;
    printed_page_label: string | null;
    page_class: PageClass;
    review_state?: ReviewState;
  }>;
}

export interface PageReviewResult {
  ok: boolean;
  review_state: ReviewState;
}

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | null;
}
