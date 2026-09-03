/**
 * Typed fetch client.
 *
 * Responsibilities kept here so no screen re-implements them:
 *  - attach the bearer token to every request, including the image routes (previews and originals
 *    are patient data and are role-checked server side, so they cannot be plain <img src>);
 *  - turn a 401 into a single, global "session expired" event rather than a per-screen error;
 *  - surface the backend's own error message when it sends one, because upload rejections carry
 *    the human-readable reason a clerk needs ("password protected", "412 pages, limit is 500").
 */

import type {
  Batch,
  Capability,
  CapabilitiesResponse,
  Case,
  Checklist,
  CompletenessResponse,
  DashboardResponse,
  DiagnosisDetail,
  DiagnosisExtraction,
  DiagnosisReviewAction,
  DocumentSummary,
  Job,
  LoginResponse,
  Paged,
  PageDetail,
  PageReviewAction,
  PageSummary,
  Qualifier,
  ThresholdsResponse,
  UploadResultRow,
  User,
} from './types';

export const API_BASE = '/api';
const TOKEN_KEY = 'opd.auth.token';
const USER_KEY = 'opd.auth.user';

/** Dispatched when the server rejects the token; App listens and routes to /login. */
export const UNAUTHORIZED_EVENT = 'opd:unauthorized';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// ------------------------------------------------------------- token store

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string, user: User): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* private-mode browsers: the session simply does not survive a reload */
  }
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- core

function authHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const token = getToken();
  if (token) h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function readError(res: Response): Promise<{ message: string; body: unknown }> {
  const text = await res.text().catch(() => '');
  if (!text) return { message: `${res.status} ${res.statusText}`, body: null };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // FastAPI puts the message in `detail`; it may itself be a list of validation errors.
    const detail = parsed.detail ?? parsed.message ?? parsed.error;
    if (typeof detail === 'string') return { message: detail, body: parsed };
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as Record<string, unknown>;
      const msg = typeof first?.msg === 'string' ? first.msg : JSON.stringify(detail);
      return { message: msg, body: parsed };
    }
    return { message: `${res.status} ${res.statusText}`, body: parsed };
  } catch {
    return { message: text.slice(0, 300), body: text };
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: authHeaders(init.headers) });

  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const { message, body } = await readError(res);
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, unknown> | URLSearchParams | undefined): string {
  if (!params) return '';
  const sp = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
      else sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ----------------------------------------------------- authenticated blobs

/**
 * Fetch an image route with the bearer token and return an object URL.
 *
 * The caller MUST revoke the URL when it is done (see `useAuthedObjectUrl`). Images cannot be
 * loaded with a bare `src` because every file route is role-checked and expects the header.
 */
export async function fetchObjectUrl(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const { message } = await readError(res);
    throw new ApiError(res.status, message);
  }
  return URL.createObjectURL(await res.blob());
}

/**
 * Download an export. Same auth path as everything else, then a synthetic anchor click so the
 * browser saves it under the server-supplied filename where one is given.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const { message } = await readError(res);
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;

  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the save before the blob disappears.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------------ auth

export const api = {
  async login(email: string, password: string): Promise<LoginResponse> {
    // The token endpoint is form-encoded (OAuth2 password flow), unlike the rest of the API.
    const body = new URLSearchParams({ username: email, password });
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const { message, body: errBody } = await readError(res);
      throw new ApiError(
        res.status,
        res.status === 401 ? 'Email or password not recognised.' : message,
        errBody,
      );
    }
    return (await res.json()) as LoginResponse;
  },

  me: () => request<User>('/auth/me'),
  listUsers: () => request<User[]>('/auth/users'),
  createUser: (payload: { email: string; full_name: string; password: string; role: string }) =>
    request<User>('/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateUser: (id: string, payload: { role?: string; is_active?: boolean }) =>
    request<User>(`/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  // --------------------------------------------------------- batches/cases

  listBatches: (params?: { q?: string; from?: string; to?: string }) =>
    request<Batch[]>(`/batches${qs(params)}`),
  createBatch: (payload: { name: string; note?: string }) =>
    request<Batch>('/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  getBatch: (id: string) => request<Batch>(`/batches/${id}`),

  listCases: (params?: { batch_id?: string; patient_ref?: string; encounter_ref?: string }) =>
    request<Case[]>(`/cases${qs(params)}`),
  createCase: (payload: {
    batch_id: string;
    patient_ref: string;
    encounter_ref: string;
    checklist_id?: string | null;
  }) =>
    request<Case>('/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** Records who confirmed the patient/encounter reference. References are never auto-merged. */
  confirmCase: (id: string) => request<Case>(`/cases/${id}/confirm`, { method: 'PATCH' }),

  getCompleteness: (caseId: string) => request<CompletenessResponse>(`/cases/${caseId}/completeness`),
  recomputeCompleteness: (caseId: string) =>
    request<CompletenessResponse>(`/cases/${caseId}/completeness/recompute`, { method: 'POST' }),

  // ------------------------------------------------------------ documents

  listDocuments: (params: URLSearchParams) =>
    request<Paged<DocumentSummary>>(`/documents${qs(params)}`),
  getDocument: (id: string) => request<DocumentSummary & { pages?: PageSummary[] }>(`/documents/${id}`),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),

  /**
   * Upload one file at a time so the UI can show per-file progress and a per-file result.
   * XMLHttpRequest rather than fetch: fetch still has no upload progress event.
   */
  uploadDocument(
    file: File,
    fields: { batch_id: string; case_id?: string | null },
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadResultRow> {
    return new Promise<UploadResultRow>((resolve, reject) => {
      const form = new FormData();
      form.append('files', file, file.name);
      form.append('batch_id', fields.batch_id);
      if (fields.case_id) form.append('case_id', fields.case_id);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/documents/upload`);
      const token = getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };

      xhr.onload = () => {
        if (xhr.status === 401) {
          clearSession();
          window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
          reject(new ApiError(401, 'Your session has expired. Please sign in again.'));
          return;
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          /* fall through to the status-code message below */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          const body = parsed as { results?: UploadResultRow[] } | UploadResultRow | null;
          const row =
            body && 'results' in (body as object) && Array.isArray((body as { results: UploadResultRow[] }).results)
              ? (body as { results: UploadResultRow[] }).results[0]
              : (body as UploadResultRow | null);
          resolve(
            row ?? { document_id: null, status: 'completed', message: 'Uploaded.', filename: file.name },
          );
          return;
        }
        // A rejection (bad type, oversize, too many pages, encrypted, corrupt) may arrive as a
        // 4xx with the reason in `detail`. Surface that text verbatim — it is what the clerk acts on.
        const detail = (parsed as { detail?: unknown } | null)?.detail;
        const message =
          typeof detail === 'string' && detail
            ? detail
            : `Upload failed (HTTP ${xhr.status}). The file was not accepted.`;
        resolve({ document_id: null, status: 'rejected', message, filename: file.name });
      };

      xhr.onerror = () =>
        resolve({
          document_id: null,
          status: 'rejected',
          message: 'Network error — the file did not reach the server. Nothing was stored.',
          filename: file.name,
        });
      xhr.onabort = () =>
        resolve({
          document_id: null,
          status: 'rejected',
          message: 'Upload cancelled before it finished.',
          filename: file.name,
        });

      signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(form);
    });
  },

  // ---------------------------------------------------------------- pages

  listPages: (params: URLSearchParams) => request<Paged<PageSummary>>(`/pages${qs(params)}`),
  getPage: (pageVersionId: string) => request<PageDetail>(`/pages/${pageVersionId}`),

  reviewPage: (
    pageVersionId: string,
    payload: { action: PageReviewAction; comment?: string; payload?: Record<string, unknown> },
  ) =>
    request<PageDetail>(`/pages/${pageVersionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  reprocessPage: (pageVersionId: string, kind: 'quality' | 'handwriting' | 'diagnosis') =>
    request<Job>(`/pages/${pageVersionId}/reprocess${qs({ kind })}`, { method: 'POST' }),

  replacePage: (pageVersionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<PageDetail>(`/pages/${pageVersionId}/replace`, { method: 'POST', body: form });
  },

  // ------------------------------------------------------------ diagnoses

  listDiagnoses: (params: URLSearchParams) =>
    request<Paged<DiagnosisExtraction & { page?: unknown }>>(`/diagnoses${qs(params)}`),
  getDiagnosis: (id: string) => request<DiagnosisDetail>(`/diagnoses/${id}`),
  reviewDiagnosis: (
    id: string,
    payload: {
      action: DiagnosisReviewAction;
      corrected_text?: string;
      corrected_qualifier?: Qualifier;
      comment?: string;
    },
  ) =>
    request<DiagnosisDetail>(`/diagnoses/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  // --------------------------------------------------------------- other

  getDashboard: (params: URLSearchParams) => request<DashboardResponse>(`/dashboard${qs(params)}`),

  listJobs: (params?: { state?: string; kind?: string; document_id?: string }) =>
    request<Paged<Job> | Job[]>(`/jobs${qs(params)}`),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),

  getThresholds: () => request<ThresholdsResponse>('/settings/thresholds'),
  putThresholds: (thresholds: Record<string, number>) =>
    request<ThresholdsResponse>('/settings/thresholds', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thresholds }),
    }),
  getCapabilities: () => request<CapabilitiesResponse | Record<string, Capability>>('/settings/capabilities'),

  listChecklists: () => request<Checklist[]>('/checklists'),
};

/** Report endpoints, kept separate because they are downloads rather than JSON. */
export const reports = {
  csv: (params: URLSearchParams) => downloadFile(`/reports/pages.csv${qs(params)}`, 'pages.csv'),
  xlsx: (params: URLSearchParams) => downloadFile(`/reports/pages.xlsx${qs(params)}`, 'pages.xlsx'),
  pdf: (params: URLSearchParams) => downloadFile(`/reports/pages.pdf${qs(params)}`, 'pages.pdf'),
  rescanChecklist: (params: URLSearchParams) =>
    downloadFile(`/reports/rescan-checklist.pdf${qs(params)}`, 'rescan-checklist.pdf'),
  flaggedZip: (params: URLSearchParams, annotated: boolean) => {
    const sp = new URLSearchParams(params);
    sp.set('annotated', String(annotated));
    return downloadFile(`/reports/flagged.zip${qs(sp)}`, 'flagged-pages.zip');
  },
};

// ------------------------------------------------------------ image paths

export const imagePath = {
  thumb: (pageVersionId: string) => `/pages/${pageVersionId}/thumb`,
  preview: (pageVersionId: string) => `/pages/${pageVersionId}/preview`,
  original: (pageVersionId: string) => `/pages/${pageVersionId}/image`,
  /** `show` selects which overlay families the server burns in. */
  annotated: (pageVersionId: string, show: string[]) =>
    `/pages/${pageVersionId}/annotated${show.length ? `?show=${show.join(',')}` : ''}`,
};
