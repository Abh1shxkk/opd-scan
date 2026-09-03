/**
 * The shared filter state, and its round trip to a query string.
 *
 * docs/API.md: "Exports must accept the identical query string and produce identical totals."
 * That is why there is exactly one serialiser here and every screen — dashboard, document list,
 * review queue, diagnosis queue and every export button — builds its request from it. A filtered
 * view is therefore shareable by URL and an export can never silently cover a different set of
 * pages from the table the user is looking at.
 */

import type {
  DiagnosisStatus,
  HandwritingStatus,
  PageClass,
  ReviewState,
} from './types';

export interface Filters {
  batch_id: string;
  case_id: string;
  patient_ref: string;
  encounter_ref: string;
  /** Inclusive date bounds, `YYYY-MM-DD`, matching the API's `from`/`to`. */
  from: string;
  to: string;
  page_class: PageClass[];
  defect_code: string[];
  handwriting: HandwritingStatus[];
  diagnosis_status: DiagnosisStatus[];
  review_state: ReviewState | '';
  uploader_id: string;
  q: string;
}

export const EMPTY_FILTERS: Filters = {
  batch_id: '',
  case_id: '',
  patient_ref: '',
  encounter_ref: '',
  from: '',
  to: '',
  page_class: [],
  defect_code: [],
  handwriting: [],
  diagnosis_status: [],
  review_state: '',
  uploader_id: '',
  q: '',
};

/** Keys the API accepts as repeated parameters. */
const MULTI_KEYS = ['page_class', 'defect_code', 'handwriting', 'diagnosis_status'] as const;
type MultiKey = (typeof MULTI_KEYS)[number];

const SCALAR_KEYS = [
  'batch_id',
  'case_id',
  'patient_ref',
  'encounter_ref',
  'from',
  'to',
  'review_state',
  'uploader_id',
  'q',
] as const;
type ScalarKey = (typeof SCALAR_KEYS)[number];

/**
 * Every query-string key the filter model owns, in both the plain and bracketed spellings. A key
 * outside this set belongs to a screen (e.g. `view`, `page`) and must survive a filter change.
 */
export const FILTER_KEYS: ReadonlySet<string> = new Set<string>([
  ...SCALAR_KEYS,
  ...MULTI_KEYS,
  ...MULTI_KEYS.map((k) => `${k}[]`),
]);

/** Parse a URLSearchParams (from the browser address bar) into filter state. */
export function parseFilters(search: URLSearchParams): Filters {
  const f: Filters = { ...EMPTY_FILTERS, page_class: [], defect_code: [], handwriting: [], diagnosis_status: [] };
  for (const key of SCALAR_KEYS) {
    const v = search.get(key);
    if (v) (f as unknown as Record<string, string>)[key] = v;
  }
  for (const key of MULTI_KEYS) {
    // Accept both repeated params (?page_class=a&page_class=b) and the bracketed form the API
    // documents (page_class[]), so a link pasted from either place still works.
    const values = [...search.getAll(key), ...search.getAll(`${key}[]`)].filter(Boolean);
    (f as unknown as Record<string, string[]>)[key] = dedupe(values);
  }
  return f;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Serialise filter state for the API. Empty values are omitted entirely so that an unset filter
 * and a filter set to "" produce the same request — and therefore the same export.
 */
export function toSearchParams(f: Filters, extra?: Record<string, string | number | undefined>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const key of SCALAR_KEYS) {
    const v = (f as unknown as Record<string, string>)[key];
    if (v) sp.set(key, v);
  }
  for (const key of MULTI_KEYS) {
    for (const v of (f as unknown as Record<string, string[]>)[key] ?? []) sp.append(key, v);
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  return sp;
}

/** The URL the address bar should carry — identical to the API query string, minus paging. */
export function toQueryString(f: Filters): string {
  const s = toSearchParams(f).toString();
  return s ? `?${s}` : '';
}

export function isEmpty(f: Filters): boolean {
  return countActive(f) === 0;
}

export function countActive(f: Filters): number {
  let n = 0;
  for (const key of SCALAR_KEYS) if ((f as unknown as Record<string, string>)[key]) n += 1;
  for (const key of MULTI_KEYS) n += ((f as unknown as Record<string, string[]>)[key] ?? []).length;
  return n;
}

/** Toggle one value of a multi-select filter. */
export function toggleMulti(f: Filters, key: MultiKey, value: string): Filters {
  const current = (f as unknown as Record<string, string[]>)[key] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...f, [key]: next } as Filters;
}

export function setScalar(f: Filters, key: ScalarKey, value: string): Filters {
  return { ...f, [key]: value } as Filters;
}

/**
 * A short human summary of the active filters, shown next to export buttons so it is obvious
 * that "download" means "download exactly this".
 */
export function describeFilters(f: Filters): string[] {
  const parts: string[] = [];
  if (f.batch_id) parts.push('one batch');
  if (f.case_id) parts.push('one case');
  if (f.patient_ref) parts.push(`patient ${f.patient_ref}`);
  if (f.encounter_ref) parts.push(`encounter ${f.encounter_ref}`);
  if (f.from && f.to) parts.push(`${f.from} to ${f.to}`);
  else if (f.from) parts.push(`from ${f.from}`);
  else if (f.to) parts.push(`up to ${f.to}`);
  if (f.page_class.length) parts.push(`page class: ${f.page_class.join(', ')}`);
  if (f.defect_code.length) parts.push(`defect: ${f.defect_code.join(', ')}`);
  if (f.handwriting.length) parts.push(`handwriting: ${f.handwriting.join(', ')}`);
  if (f.diagnosis_status.length) parts.push(`diagnosis: ${f.diagnosis_status.join(', ')}`);
  if (f.review_state) parts.push(`review: ${f.review_state}`);
  if (f.q) parts.push(`search “${f.q}”`);
  return parts;
}
