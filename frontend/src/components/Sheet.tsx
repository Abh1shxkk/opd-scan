/**
 * The containers of the Case Sheet.
 *
 * There is exactly one container in this application — a bordered block of chart stock — and it
 * never nests inside another one. Everything else is a rule: a hairline for a grid line, a heavier
 * rule for a section, a double rule to close a head. No cards, no shadows, no floating tiles.
 *
 * `Panel` keeps its original name because a dozen screens already import it; what changed is what
 * it draws.
 */
import { ScanLine, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

/** A bordered block of chart stock. */
export function Sheet({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`sheet ${className}`}>{children}</section>;
}

/**
 * A titled section of the sheet.
 *
 * `flush` removes the body padding for content that should meet the rule — tables, ruled lists,
 * and anything else that is itself a grid.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`sheet ${className}`}>
      <div className="sheet-head flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-label text-[13px] font-semibold uppercase leading-tight tracking-label text-ink">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-[68ch] text-[12px] leading-snug text-ink-2">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className={flush ? '' : 'p-3'}>{children}</div>
    </section>
  );
}

/**
 * The identification block at the head of every screen.
 *
 * A case sheet names itself before it says anything: what this is, and the conditions the readings
 * below were taken under. `meta` carries those conditions — the active view, when it was
 * generated, what is being counted — as ruled header fields rather than as prose, which is how the
 * screen states its own scope without spending a paragraph on it.
 */
export function ChartHead({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: ReactNode;
  meta?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}) {
  return (
    <header className="rule-double pb-2">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-[70ch] text-[13px] leading-snug text-ink-2">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {meta && meta.length > 0 ? (
        <div className="mt-2.5 flex flex-col border border-rule-2 bg-rule sm:flex-row">
          {/*
            The masthead cell of the sheet. The bordered mark is the neutral placeholder the
            hospital's own logo replaces once its assets are supplied (PRODUCT.md, Brand
            Commitments) — it is deliberately not a hospital name, because none has been given.
          */}
          <div className="flex shrink-0 items-center gap-2 bg-paper-2 px-2.5 py-1.5">
            <span
              className="grid h-7 w-7 shrink-0 place-items-center border border-ink bg-paper text-ink"
              aria-hidden="true"
            >
              <ScanLine size={15} strokeWidth={2.25} />
            </span>
            <span className="font-label text-[11px] font-bold uppercase leading-none tracking-label text-ink">
              OPD Scan QC
            </span>
          </div>

          {/* The identification fields, in two ruled rows. The 1px gaps are the rules. */}
          <dl className="grid min-w-0 flex-1 gap-px sm:grid-cols-2">
            {meta.map((m) => (
              <div key={m.label} className="min-w-0 bg-paper-2 px-2.5 py-1.5">
                <dt className="field-label">{m.label}</dt>
                <dd className="mt-1 text-[13px] leading-snug text-ink">{m.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </header>
  );
}

/**
 * A note printed in the margin of the sheet.
 *
 * The place the careful distinctions live — that a failed check is not a clean page, that adding
 * two overlapping totals double-counts. `tone` marks the ones that are warnings rather than
 * explanations.
 */
export function MarginNote({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'warn';
  children: ReactNode;
}) {
  return (
    <p
      role="note"
      className={`flex gap-2 border-l border-rule-2 py-1 pl-2.5 text-[12px] leading-snug ${
        tone === 'warn' ? 'bg-note/[0.07] text-ink' : 'text-ink-2'
      }`}
    >
      {tone === 'warn' ? (
        <TriangleAlert
          size={13}
          strokeWidth={2.5}
          aria-hidden="true"
          className="mt-[1px] shrink-0 text-note"
        />
      ) : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
