/**
 * A status badge. Colour is decorative: the glyph and the label carry the meaning, so the pill
 * still reads correctly in greyscale, at any colour-vision profile, and to a screen reader.
 *
 * All wording comes from `lib/status.ts` — a screen never passes a hand-written label for a status
 * that has a canonical one, which is what keeps "Handwriting not checked" from drifting into
 * "No handwriting".
 */

import type { StatusView, Tone } from '../lib/status';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-100 text-emerald-900 ring-emerald-700/30 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-400/40',
  warn: 'bg-amber-100 text-amber-950 ring-amber-800/30 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-400/40',
  bad: 'bg-red-100 text-red-950 ring-red-800/30 dark:bg-red-950 dark:text-red-100 dark:ring-red-400/40',
  info: 'bg-sky-100 text-sky-950 ring-sky-800/30 dark:bg-sky-950 dark:text-sky-100 dark:ring-sky-400/40',
  neutral:
    'bg-slate-200 text-slate-900 ring-slate-600/30 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-400/40',
};

const SIZE_CLASS = {
  sm: 'text-xs px-1.5 py-0.5 gap-1',
  md: 'text-sm px-2 py-0.5 gap-1.5',
};

export function StatusPill({
  view,
  size = 'md',
  showDetail = false,
  className = '',
}: {
  view: StatusView;
  size?: keyof typeof SIZE_CLASS;
  /** Render the explanatory sentence beneath the pill (used in detail panes, not in tables). */
  showDetail?: boolean;
  className?: string;
}) {
  return (
    <span className={className}>
      <span
        className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${TONE_CLASS[view.tone]} ${SIZE_CLASS[size]}`}
        // The detail is the accessible explanation when it is not rendered visually.
        title={!showDetail && view.detail ? view.detail : undefined}
      >
        <span aria-hidden="true" className="font-bold leading-none">
          {view.icon}
        </span>
        <span>{view.label}</span>
      </span>
      {showDetail && view.detail ? (
        <span className="mt-1 block text-xs text-slate-700 dark:text-slate-300">{view.detail}</span>
      ) : null}
    </span>
  );
}

/** A count paired with a status, e.g. in the dashboard breakdowns. */
export function StatusCountRow({
  view,
  count,
  total,
  onClick,
}: {
  view: StatusView;
  count: number;
  total: number;
  onClick?: () => void;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const inner = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <StatusPill view={view} size="sm" />
      </span>
      <span className="tabular-nums font-semibold">{count.toLocaleString()}</span>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-600 dark:text-slate-400">
        {total > 0 ? `${pct}%` : '—'}
      </span>
    </>
  );

  if (!onClick) {
    return <div className="flex items-center gap-3 px-2 py-1.5 text-sm">{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:hover:bg-slate-800"
    >
      {inner}
    </button>
  );
}
