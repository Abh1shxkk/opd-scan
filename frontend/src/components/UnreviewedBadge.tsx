/**
 * The badge that must appear on any AI output no human has confirmed.
 *
 * It is one component rather than an inline span in five screens so that the wording cannot drift,
 * and so it cannot be quietly dropped from one of them.
 */

export function UnreviewedBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-amber-600 bg-amber-100 font-semibold text-amber-950 dark:border-amber-400 dark:bg-amber-900 dark:text-amber-50 ${
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm'
      }`}
    >
      <span aria-hidden="true">⚠</span>
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
      ? 'border-red-600 bg-red-100 text-red-950 dark:border-red-400 dark:bg-red-950 dark:text-red-50'
      : 'border-emerald-600 bg-emerald-100 text-emerald-950 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-50';

  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-sm font-semibold ${tone}`}>
      <span aria-hidden="true">{action === 'reject' ? '⊘' : '✓'}</span>
      {text}
    </span>
  );
}
