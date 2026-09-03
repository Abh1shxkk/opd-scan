/**
 * A headline figure. Optionally a link, so a tile can carry the user straight to the filtered
 * list that produced it — the same filter object, so the numbers agree.
 */

import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

const ICON_TONE: Record<'plain' | 'attention' | 'muted', string> = {
  plain: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400',
  attention: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  muted: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export function StatTile({
  label,
  value,
  hint,
  to,
  tone = 'plain',
  icon: Icon,
  children,
}: {
  label: string;
  value: number | string;
  hint?: string;
  to?: string;
  tone?: 'plain' | 'attention' | 'muted';
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  const ringClass = tone === 'attention' ? 'ring-1 ring-amber-300 dark:ring-amber-700' : '';

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</dt>
        {Icon ? (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${ICON_TONE[tone]}`}
            aria-hidden="true"
          >
            <Icon size={17} strokeWidth={2} />
          </span>
        ) : null}
      </div>
      <dd className="mt-2 text-[1.75rem] font-semibold leading-none tabular-nums text-slate-900 dark:text-slate-50">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </dd>
      {hint ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
      {children}
    </>
  );

  const base = `block rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${ringClass}`;

  if (to) {
    return (
      <Link
        to={to}
        className={`${base} transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600`}
      >
        <dl>{body}</dl>
      </Link>
    );
  }
  return (
    <div className={base}>
      <dl>{body}</dl>
    </div>
  );
}

/** A titled card used for the dashboard breakdown panels. */
export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
