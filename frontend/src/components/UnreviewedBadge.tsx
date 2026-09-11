/**
 * The badge that must appear on any AI output no human has confirmed.
 *
 * It is one component rather than an inline span in five screens so that the wording cannot drift,
 * and so it cannot be quietly dropped from one of them.
 */

import { Ban, Check, TriangleAlert } from 'lucide-react';

export function UnreviewedBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-note/50 bg-note/[0.07] font-semibold text-ink ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-[13px]'
      }`}
    >
      <TriangleAlert size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-note" />
      AI extraction — not reviewed
    </span>
  );
}

/** The counterpart, once a reviewer has acted on it. */
export function ReviewedBadge({ action }: { action: 'confirm' | 'correct' | 'reject' }) {
  const text =
    action === 'confirm'
      ? 'Confirmed by a reviewer'
      : action === 'correct'
        ? 'Corrected by a reviewer'
        : 'Rejected by a reviewer';
  const tone =
    action === 'reject'
      ? 'border-plot/50 bg-plot/[0.07] text-ink '
      : 'border-band/50 bg-band/[0.07] text-ink ';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[13px] font-semibold ${tone}`}
    >
      {action === 'reject' ? (
        <Ban size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
      ) : (
        <Check size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
      )}
      {text}
    </span>
  );
}
