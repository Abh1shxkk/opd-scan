/**
 * The single source of truth for how a status is worded and coloured.
 *
 * Every rule that the specification calls out as easy to get wrong lives here rather than in a
 * screen, so it can only be wrong in one place:
 *
 *  - a handwriting check that `failed` or is `unconfigured` reads "Handwriting not checked",
 *    NEVER "No handwriting". The two mean opposite things to a records clerk.
 *  - `blank`, `failed` and `unchecked` pages have their own tone and are never given the
 *    "acceptable" colour, so a glance at a list cannot read them as passed.
 *  - every tone is paired with a `label` and an `icon` glyph, so colour is never the only carrier
 *    of meaning (WCAG 1.4.1).
 *  - a confidence that the API did not supply returns `null` and the caller renders nothing.
 */

import type {
  CompletenessStatus,
  DiagnosisStatus,
  HandwritingStatus,
  IngestStatus,
  JobState,
  PageClass,
  PrescriptionStatus,
  Qualifier,
  ReviewState,
  Severity,
} from './types';

/** Tone drives the pill palette only. The label always carries the meaning. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export interface StatusView {
  label: string;
  tone: Tone;
  /** A text glyph shown before the label so the status survives greyscale and colour blindness. */
  icon: string;
  /** Optional second line explaining a non-obvious state. */
  detail?: string;
}

// ------------------------------------------------------------- page class

const PAGE_CLASS: Record<PageClass, StatusView> = {
  acceptable: { label: 'Acceptable', tone: 'ok', icon: '✓' },
  review: { label: 'Needs review', tone: 'warn', icon: '!' },
  rescan: { label: 'Rescan required', tone: 'bad', icon: '✕' },
  // Blank is NOT a defect and NOT acceptable: a blank facing page in a bound case file is often
  // deliberate, so it gets a neutral tone of its own and a wording that invites a human check.
  blank: {
    label: 'Blank page',
    tone: 'neutral',
    icon: '□',
    detail: 'Its own class — neither a defect nor an accepted page.',
  },
  // A page that could not be measured is never "acceptable".
  failed: {
    label: 'Quality check failed',
    tone: 'bad',
    icon: '⚠',
    detail: 'The page could not be measured, so nothing is known about its quality.',
  },
  unchecked: {
    label: 'Not checked',
    tone: 'neutral',
    icon: '–',
    detail: 'No quality result has been recorded for this page yet.',
  },
};

export function pageClassView(c: PageClass | null | undefined): StatusView {
  if (!c) return PAGE_CLASS.unchecked;
  return PAGE_CLASS[c] ?? PAGE_CLASS.unchecked;
}

/** Display order for the quality tiles. `acceptable` first, then the classes it must not absorb. */
export const PAGE_CLASS_ORDER: PageClass[] = [
  'acceptable',
  'review',
  'rescan',
  'blank',
  'failed',
  'unchecked',
];

/**
 * Classes that count as "the scan passed". Exactly one entry, on purpose: this helper exists so
 * that no screen ever writes `acceptable + blank` or `acceptable + unchecked` into one figure.
 */
export const PASSED_CLASSES: PageClass[] = ['acceptable'];

/** Classes that mean "a human still has to look at this page". */
export const NEEDS_ATTENTION_CLASSES: PageClass[] = ['review', 'rescan', 'failed'];

// ----------------------------------------------------------- handwriting

const HANDWRITING: Record<HandwritingStatus, StatusView> = {
  detected: { label: 'Handwriting detected', tone: 'info', icon: '✍' },
  // The only status that may say there is none.
  none_detected: { label: 'No handwriting detected', tone: 'neutral', icon: '–' },
  failed: {
    label: 'Handwriting not checked',
    tone: 'warn',
    icon: '⚠',
    detail: 'The handwriting check failed on this page. Nothing is known either way.',
  },
  unconfigured: {
    label: 'Handwriting not checked',
    tone: 'warn',
    icon: '⚙',
    detail: 'No handwriting provider is configured, so this page was never examined.',
  },
  pending: {
    label: 'Handwriting check pending',
    tone: 'neutral',
    icon: '⋯',
    detail: 'Queued — not examined yet.',
  },
};

export function handwritingView(s: HandwritingStatus | null | undefined): StatusView {
  if (!s) return HANDWRITING.pending;
  return HANDWRITING[s] ?? HANDWRITING.pending;
}

export const HANDWRITING_ORDER: HandwritingStatus[] = [
  'detected',
  'none_detected',
  'failed',
  'unconfigured',
  'pending',
];

/** True only for statuses that positively establish the absence of handwriting. */
export function handwritingWasChecked(s: HandwritingStatus | null | undefined): boolean {
  return s === 'detected' || s === 'none_detected';
}

const HANDWRITING_CATEGORY: Record<string, string> = {
  note: 'Handwritten note',
  signature: 'Signature',
  stamp: 'Stamp',
  tick: 'Tick / mark',
  correction: 'Correction',
  uncertain: 'Uncertain category',
};

export function handwritingCategoryLabel(c: string): string {
  return HANDWRITING_CATEGORY[c] ?? c;
}

const SCRIPT_HINT: Record<string, string> = {
  latin: 'Latin script',
  devanagari: 'Devanagari script',
  mixed: 'Mixed script',
  unknown: 'Script not determined',
};

export function scriptHintLabel(s: string): string {
  return SCRIPT_HINT[s] ?? s;
}

// ------------------------------------------------------------- diagnosis

const DIAGNOSIS: Record<DiagnosisStatus, StatusView> = {
  extracted_pending_review: {
    label: 'Extracted — awaiting review',
    tone: 'warn',
    icon: '⋯',
    detail: 'An AI transcription that no clinician has confirmed yet.',
  },
  not_found: {
    label: 'No diagnosis found',
    tone: 'neutral',
    icon: '–',
    detail: 'No diagnosis label was read on this page. This is not a failure.',
  },
  unreadable: {
    label: 'Not readable',
    tone: 'bad',
    icon: '✕',
    detail: 'The transcription was not confidently readable, so no text is presented. Read the image.',
  },
  uncertain: {
    label: 'Uncertain transcription',
    tone: 'warn',
    icon: '?',
    detail: 'Low provider confidence. Confirm against the image before use.',
  },
  processing_failed: {
    label: 'Extraction failed',
    tone: 'bad',
    icon: '⚠',
    detail: 'The extraction did not complete. Nothing was read from this page.',
  },
  unconfigured: {
    label: 'Extraction not configured',
    tone: 'warn',
    icon: '⚙',
    detail: 'No diagnosis provider is configured, so this page was never examined.',
  },
  pending: { label: 'Extraction pending', tone: 'neutral', icon: '⋯' },
};

// ----------------------------------------------------------- prescription

const PRESCRIPTION: Record<PrescriptionStatus, StatusView> = {
  extracted_pending_review: {
    label: 'Read — awaiting confirmation',
    tone: 'warn',
    icon: '⋯',
    detail: 'An AI reading of the prescription that no doctor or pharmacist has confirmed yet.',
  },
  not_a_prescription: {
    label: 'No prescription found',
    tone: 'neutral',
    icon: '–',
    detail: 'This page does not appear to carry a medicine list.',
  },
  unreadable: {
    label: 'Not readable',
    tone: 'bad',
    icon: '✕',
    detail: 'The handwriting was not confidently readable, so no medicines are presented. Read the image.',
  },
  processing_failed: {
    label: 'Analysis failed',
    tone: 'bad',
    icon: '⚠',
    detail: 'The analysis did not complete. Nothing was read from this page.',
  },
  unconfigured: {
    label: 'Not configured',
    tone: 'warn',
    icon: '⚙',
    detail: 'No prescription-reading provider is configured, so this page was never examined.',
  },
  pending: { label: 'Not yet analysed', tone: 'neutral', icon: '⋯' },
};

export function prescriptionView(s: PrescriptionStatus | null | undefined): StatusView {
  if (!s) return PRESCRIPTION.pending;
  return PRESCRIPTION[s] ?? PRESCRIPTION.pending;
}

export const MEDICINE_CONFIDENCE_LABEL: Record<string, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export function diagnosisView(s: DiagnosisStatus | null | undefined): StatusView {
  if (!s) return DIAGNOSIS.pending;
  return DIAGNOSIS[s] ?? DIAGNOSIS.pending;
}

export const DIAGNOSIS_ORDER: DiagnosisStatus[] = [
  'extracted_pending_review',
  'not_found',
  'unreadable',
  'uncertain',
  'processing_failed',
  'unconfigured',
  'pending',
];

// ------------------------------------------------------------- qualifier

/**
 * The clinical qualifier is shown prominently and never dropped. A suspected, ruled-out or
 * historical diagnosis must not read as a confirmed current one.
 */
const QUALIFIER: Record<Qualifier, StatusView> = {
  final: { label: 'Final', tone: 'ok', icon: '●', detail: 'Recorded as a final diagnosis.' },
  provisional: {
    label: 'Provisional',
    tone: 'warn',
    icon: '◐',
    detail: 'Recorded as provisional — not a confirmed diagnosis.',
  },
  suspected: {
    label: 'Suspected',
    tone: 'warn',
    icon: '?',
    detail: 'Recorded as suspected — not a confirmed diagnosis.',
  },
  differential: {
    label: 'Differential',
    tone: 'info',
    icon: '⇄',
    detail: 'One of several possibilities being considered.',
  },
  ruled_out: {
    label: 'Ruled out',
    tone: 'bad',
    icon: '⊘',
    detail: 'Explicitly ruled out. This condition was NOT diagnosed.',
  },
  negated: {
    label: 'Negated',
    tone: 'bad',
    icon: '⊘',
    detail: 'Written in the negative. This condition was NOT diagnosed.',
  },
  past_history: {
    label: 'Past history',
    tone: 'info',
    icon: '⏱',
    detail: 'A historical condition, not the diagnosis for this encounter.',
  },
  unspecified: {
    label: 'Qualifier unspecified',
    tone: 'neutral',
    icon: '–',
    detail: 'The record does not say whether this is final, provisional or otherwise.',
  },
};

export function qualifierView(q: Qualifier | null | undefined): StatusView {
  if (!q) return QUALIFIER.unspecified;
  return QUALIFIER[q] ?? QUALIFIER.unspecified;
}

export const QUALIFIERS: Qualifier[] = [
  'final',
  'provisional',
  'suspected',
  'differential',
  'ruled_out',
  'negated',
  'past_history',
  'unspecified',
];

// ---------------------------------------------------------------- misc

const SEVERITY: Record<Severity, StatusView> = {
  low: { label: 'Low severity', tone: 'neutral', icon: '·' },
  medium: { label: 'Medium severity', tone: 'warn', icon: '!' },
  high: { label: 'High severity', tone: 'bad', icon: '!!' },
};

export function severityView(s: Severity): StatusView {
  return SEVERITY[s] ?? SEVERITY.medium;
}

const REVIEW_STATE: Record<ReviewState, StatusView> = {
  pending: { label: 'Awaiting review', tone: 'warn', icon: '⋯' },
  accepted: { label: 'Accepted', tone: 'ok', icon: '✓' },
  rescan_requested: { label: 'Rescan requested', tone: 'bad', icon: '↻' },
};

export function reviewStateView(s: ReviewState | null | undefined): StatusView {
  if (!s) return REVIEW_STATE.pending;
  return REVIEW_STATE[s] ?? REVIEW_STATE.pending;
}

export const REVIEW_STATES: ReviewState[] = ['pending', 'accepted', 'rescan_requested'];

const INGEST: Record<IngestStatus, StatusView> = {
  pending: { label: 'Queued', tone: 'neutral', icon: '⋯' },
  running: { label: 'Processing', tone: 'info', icon: '↻' },
  completed: { label: 'Ingested', tone: 'ok', icon: '✓' },
  failed: { label: 'Ingest failed', tone: 'bad', icon: '⚠' },
  rejected: { label: 'Rejected', tone: 'bad', icon: '✕' },
  password_protected: { label: 'Password protected', tone: 'bad', icon: '🔒' },
  corrupted: { label: 'Corrupted file', tone: 'bad', icon: '✕' },
};

export function ingestView(s: IngestStatus | 'accepted' | 'rejected' | null | undefined): StatusView {
  if (!s) return INGEST.pending;
  if (s === 'accepted') return { label: 'Accepted', tone: 'ok', icon: '✓' };
  return INGEST[s as IngestStatus] ?? INGEST.pending;
}

const JOB: Record<JobState, StatusView> = {
  queued: { label: 'Queued', tone: 'neutral', icon: '⋯' },
  running: { label: 'Running', tone: 'info', icon: '↻' },
  succeeded: { label: 'Succeeded', tone: 'ok', icon: '✓' },
  failed: { label: 'Failed', tone: 'bad', icon: '⚠' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: '⊘' },
};

export function jobView(s: JobState): StatusView {
  return JOB[s] ?? JOB.queued;
}

// ------------------------------------------------------------ completeness

const COMPLETENESS: Record<CompletenessStatus, StatusView> = {
  verified: { label: 'Complete', tone: 'ok', icon: '✓' },
  incomplete: { label: 'Incomplete', tone: 'bad', icon: '✕' },
  // Required exact wording: no checklist means nothing was verified, not that anything is wrong.
  not_verified: {
    label: 'Completeness not verified',
    tone: 'neutral',
    icon: '–',
    detail: 'No checklist is attached to this case, so completeness was never assessed.',
  },
};

export function completenessView(s: CompletenessStatus | null | undefined): StatusView {
  if (!s) return COMPLETENESS.not_verified;
  return COMPLETENESS[s] ?? COMPLETENESS.not_verified;
}

// ------------------------------------------------------------ confidence

/**
 * Format a confidence the API supplied. Returns `null` when there is none — callers must render
 * nothing at all in that case. A missing confidence is never shown as 0%, "n/a %", or a guess.
 */
export function formatConfidence(c: number | null | undefined): string | null {
  if (c === null || c === undefined || Number.isNaN(c)) return null;
  // Backend confidences are 0..1.
  return `${Math.round(c * 100)}%`;
}

/** Quality score is also 0..1 and also optional. */
export function formatScore(s: number | null | undefined): string | null {
  if (s === null || s === undefined || Number.isNaN(s)) return null;
  return s.toFixed(2);
}

// ------------------------------------------------------------ formatting

/**
 * The backend always stores and computes timestamps in UTC, but SQLite drops the timezone info on
 * read, so the API can serialise a UTC instant with no offset (e.g. "2026-09-03T06:09:25"). A bare
 * ISO string is parsed by `Date` as LOCAL time, silently skipping the UTC→local conversion — so an
 * offset-less timestamp is coerced to UTC here before parsing.
 */
function asUtcDate(iso: string): Date {
  const hasOffset = /Z$|[+-]\d\d:?\d\d$/.test(iso);
  return new Date(hasOffset ? iso : `${iso}Z`);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = asUtcDate(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

const COLOUR_MODE: Record<string, string> = {
  colour: 'Colour',
  grey: 'Greyscale',
  bitonal: '1-bit (bitonal)',
};

export function colourModeLabel(m: string | null | undefined): string {
  if (!m) return '—';
  return COLOUR_MODE[m] ?? m;
}

const CAPTURE_PROFILE: Record<string, string> = {
  flatbed: 'Flatbed scan',
  photo: 'Camera photograph',
  unknown: 'Capture type unknown',
};

export function captureProfileLabel(p: string | null | undefined): string {
  if (!p) return '—';
  return CAPTURE_PROFILE[p] ?? p;
}

const CAPABILITY_LABEL: Record<string, string> = {
  ocr: 'OCR',
  quality_provider_signals: 'Provider quality signals',
  handwriting: 'Handwriting detection',
  handwriting_devanagari: 'Handwritten Devanagari (Hindi)',
  diagnosis: 'Diagnosis extraction',
  prescription: 'Prescription understanding',
  local_quality_engine: 'Local quality engine (OpenCV)',
};

export function capabilityLabel(key: string): string {
  return CAPABILITY_LABEL[key] ?? key.replace(/_/g, ' ');
}
