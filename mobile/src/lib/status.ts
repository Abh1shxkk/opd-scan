/**
 * Status wording and colour, shared by every screen. Same rules as the web app (lib/status.ts):
 * a flagged page a reviewer accepted reads as acceptable; a failed page stays failed.
 */

import type { Palette } from '@/constants/theme';
import type { PageClass, ReviewState } from './types';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';

export interface StatusView {
  label: string;
  tone: Tone;
}

const CLASS: Record<PageClass, StatusView> = {
  acceptable: { label: 'Acceptable', tone: 'ok' },
  review: { label: 'Needs review', tone: 'warn' },
  rescan: { label: 'Rescan required', tone: 'bad' },
  blank: { label: 'Blank page', tone: 'neutral' },
  failed: { label: 'Check failed', tone: 'bad' },
  unchecked: { label: 'Not checked', tone: 'neutral' },
};

const FLAGGED: PageClass[] = ['review', 'rescan'];

export function pageStatus(c: PageClass | null | undefined, review?: ReviewState | null): StatusView {
  const klass = c ?? 'unchecked';
  if (review === 'accepted' && FLAGGED.includes(klass)) return { label: 'Accepted', tone: 'ok' };
  if (review === 'rescan_requested') return { label: 'Rescan requested', tone: 'bad' };
  return CLASS[klass] ?? CLASS.unchecked;
}

export function isOpenForReview(c: PageClass, review: ReviewState) {
  return FLAGGED.includes(c) && review === 'pending';
}

export function toneColors(tone: Tone, c: Palette): { fg: string; bg: string } {
  switch (tone) {
    case 'ok':
      return { fg: c.ok, bg: c.okBg };
    case 'warn':
      return { fg: c.warn, bg: c.warnBg };
    case 'bad':
      return { fg: c.bad, bg: c.badBg };
    case 'info':
      return { fg: c.primary, bg: c.surfaceAlt };
    default:
      return { fg: c.textSecondary, bg: c.neutralBg };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, day] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return value;
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

/** YYYY-MM-DD in local time. */
export function toDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The UTC instants a local calendar day starts and ends — how every date filter talks to the API. */
export function dayWindow(day: string | null): { from?: string; to?: string } {
  if (!day) return {};
  return {
    from: new Date(`${day}T00:00:00`).toISOString(),
    to: new Date(`${day}T23:59:59.999`).toISOString(),
  };
}
