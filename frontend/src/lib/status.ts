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
 *  - every tone is paired with a `label` and a drawn `icon`, so colour is never the only carrier
 *    of meaning (WCAG 1.4.1).
 *  - `unmeasured` separates "we did not establish anything" from "we established there is
 *    nothing", and the interface hatches the first group so the two cannot be confused.
 *  - a confidence that the API did not supply returns `null` and the caller renders nothing.
 */

import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  Ban,
  Check,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  Clock,
  Copy,
  Dot,
  Ellipsis,
  Lock,
  Minus,
  OctagonAlert,
  PenLine,
  RefreshCw,
  Settings2,
  Square,
  TriangleAlert,
} from 'lucide-react';

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

/** Tone drives the status ink only. The label always carries the meaning. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export interface StatusView {
  label: string;
  tone: Tone;
  /** A drawn mark shown before the label so the status survives greyscale and colour blindness. */
  icon: LucideIcon;
  /** Optional second line explaining a non-obvious state. */
  detail?: string;
  /**
   * A short, visible reason shown beside the label.
   *
   * Two statuses deliberately share the label "Handwriting not checked" — a failed check and an
   * unconfigured provider — because that wording is fixed product truth. The qualifier is what
   * separates them on screen. It is rendered, not hidden in a `title`: a tooltip does not exist on
   * a touch device, and intake and ward staff work on tablets.
   */
  qualifier?: string;
  /**
   * True when this status means "nothing was established" rather than "nothing is there".
   *
   * The distinction is the whole point of this file: a failed check, an unconfigured provider and
   * a queued page all report an *absence of knowledge*, while `none_detected`, `not_found` and
   * `not_a_prescription` report a *finding*. The interface draws the first group with hatching —
   * the chart convention for a region that was never measured — so the two can never be read as
   * the same thing at a glance.
   */
  unmeasured?: boolean;
}

// ------------------------------------------------------------- page class

const PAGE_CLASS: Record<PageClass, StatusView> = {
  acceptable: { label: 'Acceptable', tone: 'ok', icon: Check },
  review: { label: 'Needs review', tone: 'warn', icon: CircleAlert },
  rescan: { label: 'Rescan required', tone: 'bad', icon: CircleX },
  // Blank is NOT a defect and NOT acceptable: a blank facing page in a bound case file is often
  // deliberate, so it gets a neutral tone of its own and a wording that invites a human check.
  blank: {
    label: 'Blank page',
    tone: 'neutral',
    icon: Square,
    detail: 'Its own class — neither a defect nor an accepted page.',
  },
  // A page that could not be measured is never "acceptable".
  failed: {
    label: 'Quality check failed',
    tone: 'bad',
    icon: TriangleAlert,
    detail: 'The page could not be measured, so nothing is known about its quality.',
    qualifier: 'could not be measured',
    unmeasured: true,
  },
  unchecked: {
    label: 'Not checked',
    tone: 'neutral',
    icon: Minus,
    detail: 'No quality result has been recorded for this page yet.',
    qualifier: 'not yet run',
    unmeasured: true,
  },
};

/**
 * The engine's verdict on a page, optionally qualified by what a human then decided about it.
 *
 * The two are independent and both are true: the class is a permanent record of the scan as
 * captured, and accepting a page never rewrites it. Shown side by side and unexplained, though,
 * "Rescan required" next to "Accepted" reads as a contradiction — and it was read that way
 * repeatedly. Rather than repeating a paragraph of explanation on every screen that shows both,
 * the pill carries it: "Rescan required · accepted by reviewer" is one statement, not two
 * competing ones.
 *
 * `reviewState` is optional so callers that show the class alone are unaffected.
 */
/**
 * Two of the class labels are instructions rather than observations: "Rescan required" and "Needs
 * review" both tell the reader to do something. Once a reviewer has looked and decided otherwise,
 * the instruction is stale — it is ordering work that has been explicitly overruled, and no amount
 * of explanatory text beside it stops "Rescan required" next to "Accepted" reading as a
 * contradiction. So when the page has been accepted, the label states what was found instead of
 * what to do about it.
 *
 * The verdict itself is unchanged; only its wording moves from imperative to observation.
 */
const OVERRULED_LABEL: Partial<Record<PageClass, string>> = {
  rescan: 'Serious scan defects',
  review: 'Scan defects found',
};

export function pageClassView(
  c: PageClass | null | undefined,
  reviewState?: ReviewState | null,
): StatusView {
  const base = (c ? PAGE_CLASS[c] : undefined) ?? PAGE_CLASS.unchecked;
  if (reviewState === 'accepted' && c && NEEDS_ATTENTION_CLASSES.includes(c)) {
    return { ...base, label: OVERRULED_LABEL[c] ?? base.label, qualifier: 'accepted by reviewer' };
  }
  return base;
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
  detected: { label: 'Handwriting detected', tone: 'info', icon: PenLine },
  // The only status that may say there is none.
  none_detected: { label: 'No handwriting detected', tone: 'neutral', icon: Minus },
  failed: {
    label: 'Handwriting not checked',
    tone: 'warn',
    icon: TriangleAlert,
    detail: 'The handwriting check failed on this page. Nothing is known either way.',
    qualifier: 'check failed',
    unmeasured: true,
  },
  unconfigured: {
    label: 'Handwriting not checked',
    tone: 'warn',
    icon: Settings2,
    detail: 'No handwriting provider is configured, so this page was never examined.',
    qualifier: 'no provider configured',
    unmeasured: true,
  },
  pending: {
    label: 'Handwriting check pending',
    tone: 'neutral',
    icon: Ellipsis,
    detail: 'Queued — not examined yet.',
    qualifier: 'queued',
    unmeasured: true,
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
    icon: Ellipsis,
    detail: 'An AI transcription that no clinician has confirmed yet.',
  },
  not_found: {
    label: 'No diagnosis found',
    tone: 'neutral',
    icon: Minus,
    detail: 'No diagnosis label was read on this page. This is not a failure.',
  },
  unreadable: {
    label: 'Not readable',
    tone: 'bad',
    icon: CircleX,
    detail: 'The transcription was not confidently readable, so no text is presented. Read the image.',
    qualifier: 'not legible',
    unmeasured: true,
  },
  uncertain: {
    label: 'Uncertain transcription',
    tone: 'warn',
    icon: CircleQuestionMark,
    detail: 'Low provider confidence. Confirm against the image before use.',
  },
  processing_failed: {
    label: 'Extraction failed',
    tone: 'bad',
    icon: TriangleAlert,
    detail: 'The extraction did not complete. Nothing was read from this page.',
    qualifier: 'extraction failed',
    unmeasured: true,
  },
  unconfigured: {
    label: 'Extraction not configured',
    tone: 'warn',
    icon: Settings2,
    detail: 'No diagnosis provider is configured, so this page was never examined.',
    qualifier: 'no provider configured',
    unmeasured: true,
  },
  pending: {
    label: 'Extraction pending',
    tone: 'neutral',
    icon: Ellipsis,
    qualifier: 'queued',
    unmeasured: true,
  },
};

// ----------------------------------------------------------- prescription

const PRESCRIPTION: Record<PrescriptionStatus, StatusView> = {
  extracted_pending_review: {
    label: 'Read — awaiting confirmation',
    tone: 'warn',
    icon: Ellipsis,
    detail: 'An AI reading of the prescription that no doctor or pharmacist has confirmed yet.',
  },
  not_a_prescription: {
    label: 'No prescription found',
    tone: 'neutral',
    icon: Minus,
    detail: 'This page does not appear to carry a medicine list.',
  },
  unreadable: {
    label: 'Not readable',
    tone: 'bad',
    icon: CircleX,
    detail: 'The handwriting was not confidently readable, so no medicines are presented. Read the image.',
    qualifier: 'not legible',
    unmeasured: true,
  },
  processing_failed: {
    label: 'Analysis failed',
    tone: 'bad',
    icon: TriangleAlert,
    detail: 'The analysis did not complete. Nothing was read from this page.',
    qualifier: 'analysis failed',
    unmeasured: true,
  },
  unconfigured: {
    label: 'Not configured',
    tone: 'warn',
    icon: Settings2,
    detail: 'No prescription-reading provider is configured, so this page was never examined.',
    qualifier: 'no provider configured',
    unmeasured: true,
  },
  pending: {
    label: 'Not yet analysed',
    tone: 'neutral',
    icon: Ellipsis,
    qualifier: 'queued',
    unmeasured: true,
  },
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

const MEDICINE_CONFIDENCE: Record<string, StatusView> = {
  high: { label: 'High confidence', tone: 'ok', icon: Check },
  medium: { label: 'Medium confidence', tone: 'warn', icon: CircleAlert },
  low: { label: 'Low confidence', tone: 'bad', icon: TriangleAlert },
};

/**
 * How confident the model is that it read this medicine correctly.
 *
 * A real StatusView rather than a bare colour + label: this file's own rule is that colour is never
 * the only carrier of meaning, and "low confidence" on a drug name is exactly the status that must
 * survive a greyscale print or a colour-vision deficiency. An unrecognised value is treated as low,
 * never as high — the safe direction to round in.
 */
export function medicineConfidenceView(c: string | null | undefined): StatusView {
  if (!c) return MEDICINE_CONFIDENCE.low;
  return MEDICINE_CONFIDENCE[c] ?? MEDICINE_CONFIDENCE.low;
}

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
  final: { label: 'Final', tone: 'ok', icon: CircleDot, detail: 'Recorded as a final diagnosis.' },
  provisional: {
    label: 'Provisional',
    tone: 'warn',
    icon: CircleDashed,
    detail: 'Recorded as provisional — not a confirmed diagnosis.',
  },
  suspected: {
    label: 'Suspected',
    tone: 'warn',
    icon: CircleQuestionMark,
    detail: 'Recorded as suspected — not a confirmed diagnosis.',
  },
  differential: {
    label: 'Differential',
    tone: 'info',
    icon: ArrowLeftRight,
    detail: 'One of several possibilities being considered.',
  },
  ruled_out: {
    label: 'Ruled out',
    tone: 'bad',
    icon: Ban,
    detail: 'Explicitly ruled out. This condition was NOT diagnosed.',
  },
  negated: {
    label: 'Negated',
    tone: 'bad',
    icon: Ban,
    detail: 'Written in the negative. This condition was NOT diagnosed.',
  },
  past_history: {
    label: 'Past history',
    tone: 'info',
    icon: Clock,
    detail: 'A historical condition, not the diagnosis for this encounter.',
  },
  unspecified: {
    label: 'Qualifier unspecified',
    tone: 'neutral',
    icon: Minus,
    detail: 'The record does not say whether this is final, provisional or otherwise.',
    qualifier: 'not stated on the page',
    unmeasured: true,
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
  low: { label: 'Low severity', tone: 'neutral', icon: Dot },
  medium: { label: 'Medium severity', tone: 'warn', icon: CircleAlert },
  high: { label: 'High severity', tone: 'bad', icon: OctagonAlert },
};

export function severityView(s: Severity): StatusView {
  return SEVERITY[s] ?? SEVERITY.medium;
}

const REVIEW_STATE: Record<ReviewState, StatusView> = {
  pending: { label: 'Awaiting review', tone: 'warn', icon: Ellipsis },
  accepted: { label: 'Accepted', tone: 'ok', icon: Check },
  rescan_requested: { label: 'Rescan requested', tone: 'bad', icon: RefreshCw },
};

export function reviewStateView(s: ReviewState | null | undefined): StatusView {
  if (!s) return REVIEW_STATE.pending;
  return REVIEW_STATE[s] ?? REVIEW_STATE.pending;
}

export const REVIEW_STATES: ReviewState[] = ['pending', 'accepted', 'rescan_requested'];

const INGEST: Record<IngestStatus, StatusView> = {
  pending: { label: 'Queued', tone: 'neutral', icon: Ellipsis },
  running: { label: 'Processing', tone: 'info', icon: RefreshCw },
  completed: { label: 'Ingested', tone: 'ok', icon: Check },
  failed: { label: 'Ingest failed', tone: 'bad', icon: TriangleAlert },
  rejected: { label: 'Rejected', tone: 'bad', icon: CircleX },
  password_protected: { label: 'Password protected', tone: 'bad', icon: Lock },
  corrupted: { label: 'Corrupted file', tone: 'bad', icon: CircleX },
};

export function ingestView(
  s: IngestStatus | 'accepted' | 'rejected' | 'duplicate' | null | undefined,
): StatusView {
  if (!s) return INGEST.pending;
  if (s === 'accepted') return { label: 'Accepted', tone: 'ok', icon: Check };
  // A duplicate is its own outcome and gets its own wording: the file was recognised and
  // deliberately not stored again. Reading it as "Queued" would tell a clerk to wait for
  // processing that is never going to happen, and reading it as "Accepted" would claim a second
  // copy exists when it does not.
  if (s === 'duplicate') {
    return {
      label: 'Already uploaded',
      tone: 'warn',
      icon: Copy,
      detail: 'An identical file was already stored, so this one was not added again.',
    };
  }
  return INGEST[s as IngestStatus] ?? INGEST.pending;
}

const JOB: Record<JobState, StatusView> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Ellipsis },
  running: { label: 'Running', tone: 'info', icon: RefreshCw },
  succeeded: { label: 'Succeeded', tone: 'ok', icon: Check },
  failed: { label: 'Failed', tone: 'bad', icon: TriangleAlert },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export function jobView(s: JobState): StatusView {
  return JOB[s] ?? JOB.queued;
}

// ------------------------------------------------------------ completeness

const COMPLETENESS: Record<CompletenessStatus, StatusView> = {
  verified: { label: 'Complete', tone: 'ok', icon: Check },
  incomplete: { label: 'Incomplete', tone: 'bad', icon: CircleX },
  // Required exact wording: no checklist means nothing was verified, not that anything is wrong.
  not_verified: {
    label: 'Completeness not verified',
    tone: 'neutral',
    icon: Minus,
    detail: 'No checklist is attached to this case, so completeness was never assessed.',
    qualifier: 'no checklist attached',
    unmeasured: true,
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
