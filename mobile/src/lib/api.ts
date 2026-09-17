/**
 * The one client for the backend. Every screen goes through here, so authentication, error text and
 * the server address are handled in one place.
 *
 * The server address comes from EXPO_PUBLIC_API_BASE, defaulting to the live deployment. Unlike the
 * web app (same origin, `/api`), a phone app always needs the full URL.
 */

import type {
  Case,
  DocumentSummary,
  IntakeFormValues,
  IntakeLookupResponse,
  IntakeOptions,
  IntakeResponse,
  LoginResponse,
  PageDetail,
  PageReviewAction,
  PageReviewResult,
  PageSummary,
  Paged,
  PickedFile,
  User,
} from './types';

export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? 'https://ipdscan.subharti.org/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(next: string | null) {
  token = next;
}
export function getToken() {
  return token;
}
/** Called once by the auth provider, so an expired session anywhere sends the user to sign in. */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function messageFrom(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail[0] && typeof detail[0].msg === 'string') return detail[0].msg;
  } catch {
    /* not JSON */
  }
  return status === 0 ? 'No connection to the server.' : `Something went wrong (HTTP ${status}).`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...authHeaders(), ...(init.headers as Record<string, string>) },
    });
  } catch {
    throw new ApiError(0, 'No internet connection. Check your network and try again.');
  }
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, await res.text().catch(() => '')));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null | string[]>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const values = Array.isArray(v) ? v : [v];
    for (const one of values) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(one))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Multipart upload with progress. fetch cannot report upload progress, so this uses XHR — which
 * React Native supports, including `{ uri, name, type }` file parts.
 */
function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    const headers = authHeaders();
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        onUnauthorized?.();
        reject(new ApiError(401, 'Your session has expired. Please sign in again.'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError(xhr.status, 'Unexpected response from the server.'));
        }
        return;
      }
      reject(new ApiError(xhr.status, messageFrom(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error — nothing was saved. Check the connection and try again.'));
    xhr.send(form);
  });
}

function filePart(file: PickedFile) {
  // React Native's FormData accepts this object shape for a file on disk.
  return { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as unknown as Blob;
}

export const api = {
  async login(identifier: string, password: string): Promise<LoginResponse> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: `username=${encodeURIComponent(identifier.trim())}&password=${encodeURIComponent(password)}`,
      });
    } catch {
      throw new ApiError(0, 'No internet connection. Check your network and try again.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, res.status === 401 ? 'Incorrect username or password.' : messageFrom(res.status, text));
    }
    return (await res.json()) as LoginResponse;
  },

  me: () => request<User>('/auth/me'),

  // ---- patient records
  listCases: (p: { search?: string; created_from?: string; created_to?: string; limit: number; offset: number }) => {
    // The search box matches either identifier: MR number first, falling back to IPD when it
    // looks like an admission number.
    const s = p.search?.trim();
    const byIpd = s ? /^ip/i.test(s) : false;
    return request<Paged<Case> & { grand_total: number }>(
      `/cases/paged${qs({
        patient_ref: s && !byIpd ? s : undefined,
        encounter_ref: s && byIpd ? s : undefined,
        created_from: p.created_from,
        created_to: p.created_to,
        limit: p.limit,
        offset: p.offset,
      })}`,
    );
  },
  getCase: (id: string) => request<Case>(`/cases/${id}`),
  caseDocuments: (caseId: string) => request<Paged<DocumentSummary>>(`/documents${qs({ case_id: caseId, limit: 200 })}`),
  casePages: (caseId: string) => request<Paged<PageSummary>>(`/pages${qs({ case_id: caseId, limit: 500 })}`),

  // ---- intake
  intakeOptions: () => request<IntakeOptions>('/intake/options'),
  lookupMr: (mr: string) => request<IntakeLookupResponse>(`/intake/lookup${qs({ mr_number: mr })}`),
  submitIntake(values: IntakeFormValues, files: PickedFile[], onProgress?: (f: number) => void) {
    const form = new FormData();
    for (const [k, v] of Object.entries(values)) form.append(k, v ?? '');
    for (const f of files) form.append('files', filePart(f));
    return upload<IntakeResponse>('/intake', form, onProgress);
  },

  // ---- review
  reviewDocuments: (p: { search?: string; from?: string; to?: string; limit: number; offset: number }) =>
    request<Paged<DocumentSummary>>(
      `/documents${qs({ needs_review: true, q: p.search?.trim(), from: p.from, to: p.to, limit: p.limit, offset: p.offset })}`,
    ),
  getDocument: (id: string) => request<DocumentSummary>(`/documents/${id}`),
  documentPages: (documentId: string) => request<Paged<PageSummary>>(`/pages${qs({ document_id: documentId, limit: 500 })}`),
  rescanPages: (p: { search?: string; from?: string; to?: string }) =>
    request<Paged<PageSummary>>(
      `/pages${qs({ review_state: 'rescan_requested', q: p.search?.trim(), from: p.from, to: p.to, limit: 1000 })}`,
    ),

  getPage: (id: string) => request<PageDetail>(`/pages/${id}`),
  reviewPage: (id: string, action: PageReviewAction, comment = '') =>
    request<PageReviewResult>(`/pages/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, comment }),
    }),
  replacePage(id: string, file: PickedFile, onProgress?: (f: number) => void) {
    const form = new FormData();
    form.append('file', filePart(file));
    return upload<{ page_version_id: string; version_no: number }>(`/pages/${id}/replace`, form, onProgress);
  },
};

export const imageUrl = {
  thumb: (id: string) => `${API_BASE}/pages/${id}/thumb`,
  preview: (id: string) => `${API_BASE}/pages/${id}/preview`,
};
