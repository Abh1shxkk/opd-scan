/**
 * Dashboard.
 *
 * Three things this screen is careful about, all of them counting rules from docs/PLAN.md §3:
 *
 *  - "Acceptable" is one number and only one number. `blank`, `failed` and `unchecked` are listed
 *    separately with their own tones and are never added into it, so nobody can read a headline
 *    figure as "this many pages passed" when a third of them were never measured.
 *  - Handwriting is a separate axis, not a defect. It has its own panel and never appears in the
 *    defect breakdown.
 *  - The categories overlap, so there is an explicit overlap panel. Showing "42 defects, 30
 *    handwriting" side by side implies a partition of 72 pages; the API supplies
 *    defect_and_handwriting precisely so the UI does not have to imply anything.
 *
 * Every count is a distinct ACTIVE page version — superseded versions are not in these figures.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileStack, Files, CircleCheck, ClipboardCheck } from 'lucide-react';
import { api } from '../lib/api';
import { defectLabel } from '../lib/defects';
import { toQueryString } from '../lib/filters';
import {
  capabilityLabel,
  DIAGNOSIS_ORDER,
  diagnosisView,
  HANDWRITING_ORDER,
  handwritingView,
  PAGE_CLASS_ORDER,
  pageClassView,
} from '../lib/status';
import type { DashboardResponse } from '../lib/types';
import { FilterBar } from '../components/FilterBar';
import { Panel, StatTile } from '../components/StatTile';
import { StatusCountRow, StatusPill } from '../components/StatusPill';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { useUrlFilters } from '../hooks/useUrlFilters';
import type { Filters } from '../lib/filters';

export default function DashboardPage() {
  const { filters, setFilters, reset, params } = useUrlFilters();

  const q = useQuery({
    queryKey: ['dashboard', params.toString()],
    queryFn: () => api.getDashboard(params),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Every figure below counts <strong>distinct active page versions</strong>. Superseded versions
          appear only in a page’s version history.
        </p>
      </header>

      <FilterBar value={filters} onChange={setFilters} onReset={reset} />

      {q.isLoading ? <Spinner label="Loading dashboard…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}
      {q.data ? <DashboardBody data={q.data} filters={filters} /> : null}
    </div>
  );
}

/** Link to the document list carrying the current filters plus one extra constraint. */
function listLink(filters: Filters, patch: Partial<Filters>): string {
  return `/documents${toQueryString({ ...filters, ...patch })}`;
}

function DashboardBody({ data, filters }: { data: DashboardResponse; filters: Filters }) {
  const t = data.totals;
  const pages = t.pages_active || 0;

  // Deliberately NOT `acceptable + blank`: the accepted figure is the acceptable class alone.
  const acceptable = t.quality?.acceptable ?? 0;
  const notMeasured = (t.quality?.failed ?? 0) + (t.quality?.unchecked ?? 0);

  const unconfigured = Object.entries(data.capabilities ?? {}).filter(
    ([, c]) => c?.status === 'unconfigured',
  );

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------ headline */}
      <section aria-label="Totals" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Files"
          value={t.files ?? 0}
          hint="Documents uploaded in this view"
          to={listLink(filters, {})}
          icon={Files}
        />
        <StatTile
          label="Active pages"
          value={pages}
          hint="Active page versions only"
          to={listLink(filters, {})}
          icon={FileStack}
        />
        <StatTile
          label="Acceptable pages"
          value={acceptable}
          hint="This class only — blank, failed and unchecked pages are counted separately below"
          to={listLink(filters, { page_class: ['acceptable'] })}
          icon={CircleCheck}
        />
        <StatTile
          label="Awaiting review"
          value={t.awaiting_review ?? 0}
          tone={(t.awaiting_review ?? 0) > 0 ? 'attention' : 'plain'}
          hint="Pages a reviewer has not yet accepted or sent for rescan"
          to={`/review${toQueryString({ ...filters, review_state: 'pending' })}`}
          icon={ClipboardCheck}
        />
      </section>

      {notMeasured > 0 ? (
        <p
          role="note"
          className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50"
        >
          <span aria-hidden="true">⚠ </span>
          <strong>{notMeasured.toLocaleString()}</strong> page
          {notMeasured === 1 ? ' was' : 's were'} never successfully measured (quality check failed or
          not yet run). Nothing is known about their quality — they are not counted as acceptable.
        </p>
      ) : null}

      {/* --------------------------------------------------------- processing */}
      <section aria-label="Processing" className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Jobs queued" value={t.processing?.queued ?? 0} tone="muted" />
        <StatTile label="Jobs running" value={t.processing?.running ?? 0} tone="muted" />
        <StatTile
          label="Jobs failed"
          value={t.processing?.failed ?? 0}
          tone={(t.processing?.failed ?? 0) > 0 ? 'attention' : 'muted'}
          hint={(t.processing?.failed ?? 0) > 0 ? 'A failed job leaves its page unmeasured, not clean' : undefined}
        />
      </section>

      {/* ------------------------------------------------------- distributions */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Scan quality"
          description="Each page falls in exactly one class. Blank, failed and unchecked are never folded into acceptable."
        >
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {PAGE_CLASS_ORDER.map((c) => (
              <li key={c}>
                <Link
                  to={listLink(filters, { page_class: [c] })}
                  className="block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                >
                  <StatusCountRow view={pageClassView(c)} count={t.quality?.[c] ?? 0} total={pages} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Handwriting"
          description="A separate axis. Handwriting is not a scan-quality defect and is never counted as one."
        >
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {HANDWRITING_ORDER.map((s) => (
              <li key={s}>
                <Link
                  to={listLink(filters, { handwriting: [s] })}
                  className="block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                >
                  <StatusCountRow view={handwritingView(s)} count={t.handwriting?.[s] ?? 0} total={pages} />
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            “Not checked” means the check failed or no provider is configured — it does <strong>not</strong>{' '}
            mean the page has no handwriting.
          </p>
        </Panel>

        <Panel title="Diagnosis extraction" description="Status of the AI transcription per page.">
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {DIAGNOSIS_ORDER.map((s) => (
              <li key={s}>
                <Link
                  to={listLink(filters, { diagnosis_status: [s] })}
                  className="block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                >
                  <StatusCountRow view={diagnosisView(s)} count={t.diagnosis?.[s] ?? 0} total={pages} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* --------------------------------------------------------- overlap */}
      <OverlapPanel data={data} filters={filters} />

      {/* --------------------------------------------------------- defects */}
      <Panel
        title="Scan defects by frequency"
        description="A page can carry several defects, so these figures sum to more than the number of affected pages. Handwriting is not in this list."
      >
        {(data.defects ?? []).length === 0 ? (
          <EmptyState title="No scan defects recorded in this view." />
        ) : (
          <ul className="space-y-1">
            {[...data.defects]
              .sort((a, b) => b.pages - a.pages)
              .map((d) => {
                const max = Math.max(...data.defects.map((x) => x.pages), 1);
                const pct = Math.round((d.pages / max) * 100);
                return (
                  <li key={d.code}>
                    <Link
                      to={listLink(filters, { defect_code: [d.code] })}
                      className="block rounded px-2 py-1.5 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:hover:bg-slate-800"
                    >
                      <span className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="text-slate-900 dark:text-slate-100">
                          {defectLabel(d.code, d.label)}
                        </span>
                        <span className="shrink-0 tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                          {d.pages.toLocaleString()}
                          <span className="ml-1 font-normal text-slate-600 dark:text-slate-400">
                            page{d.pages === 1 ? '' : 's'}
                          </span>
                        </span>
                      </span>
                      {/* The bar is redundant with the number beside it — decoration, not data. */}
                      <span
                        aria-hidden="true"
                        className="mt-1 block h-1.5 rounded-full bg-slate-200 dark:bg-slate-800"
                      >
                        <span
                          className="block h-1.5 rounded-full bg-sky-700 dark:bg-sky-500"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        )}
      </Panel>

      {/* ---------------------------------------------------- capabilities */}
      <Panel
        title="Provider capabilities"
        description="What this deployment can actually do. An unconfigured capability withholds results — it never reports a clean page."
      >
        {unconfigured.length === 0 ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            <span aria-hidden="true">✓ </span>
            Every configured capability is reporting as ready.
          </p>
        ) : (
          <ul className="space-y-3">
            {unconfigured.map(([key, cap]) => (
              <li
                key={key}
                className="rounded-lg border border-amber-400 bg-amber-50 p-3 dark:border-amber-600 dark:bg-amber-950"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-amber-950 dark:text-amber-50">
                    {capabilityLabel(key)}
                  </span>
                  <StatusPill
                    view={{ label: 'Not configured', tone: 'warn', icon: '⚙' }}
                    size="sm"
                  />
                </div>
                {/* setup_required is the actionable instruction from the backend — shown verbatim. */}
                {cap.setup_required ? (
                  <p className="mt-1 text-sm text-amber-950 dark:text-amber-50">{cap.setup_required}</p>
                ) : null}
                <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                  Pages that needed this capability are recorded as “not checked”, not as clean.
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          {Object.entries(data.capabilities ?? {})
            .filter(([, c]) => c?.status === 'ready')
            .map(([key, cap]) => (
              <p key={key} className="text-sm text-slate-700 dark:text-slate-300">
                <span aria-hidden="true">✓ </span>
                {capabilityLabel(key)}
                {cap.provider ? (
                  <span className="text-slate-600 dark:text-slate-400"> — {cap.provider}</span>
                ) : null}
              </p>
            ))}
        </div>
      </Panel>
    </div>
  );
}

/**
 * The overlap panel.
 *
 * Defect counts and handwriting counts describe the same pages from two different angles. Without
 * the overlap figure a reader naturally assumes the two groups are disjoint, and then over-counts
 * the work outstanding.
 */
function OverlapPanel({ data, filters }: { data: DashboardResponse; filters: Filters }) {
  const o = data.overlaps ?? { defect_and_handwriting: 0, defect_only: 0, handwriting_only: 0 };
  const union = o.defect_and_handwriting + o.defect_only + o.handwriting_only;

  return (
    <Panel
      title="Scan defects and handwriting overlap"
      description="These two categories are not exclusive. A page can carry a scan defect and handwriting at the same time, and appears in both counts."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <OverlapCell
          title="Scan defect only"
          count={o.defect_only}
          total={union}
          detail="A quality finding, no handwriting detected."
          to={`/documents${toQueryString({ ...filters, handwriting: ['none_detected'], page_class: ['review', 'rescan'] })}`}
        />
        <OverlapCell
          title="Both"
          count={o.defect_and_handwriting}
          total={union}
          detail="A quality finding AND handwriting on the same page. Counted once in each category above."
          emphasise
          to={`/documents${toQueryString({ ...filters, handwriting: ['detected'], page_class: ['review', 'rescan'] })}`}
        />
        <OverlapCell
          title="Handwriting only"
          count={o.handwriting_only}
          total={union}
          detail="Handwriting detected, no scan-quality finding. Not a defect."
          to={`/documents${toQueryString({ ...filters, handwriting: ['detected'], page_class: ['acceptable'] })}`}
        />
      </div>
      <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
        {union.toLocaleString()} distinct page{union === 1 ? '' : 's'} fall into at least one of the two
        categories. Adding the two category totals together would double-count the{' '}
        {o.defect_and_handwriting.toLocaleString()} page
        {o.defect_and_handwriting === 1 ? '' : 's'} in the middle column.
      </p>
    </Panel>
  );
}

function OverlapCell({
  title,
  count,
  total,
  detail,
  to,
  emphasise = false,
}: {
  title: string;
  count: number;
  total: number;
  detail: string;
  to: string;
  emphasise?: boolean;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <Link
      to={to}
      className={`block rounded-lg border p-3 hover:border-sky-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:hover:border-sky-400 ${
        emphasise
          ? 'border-violet-400 bg-violet-50 dark:border-violet-600 dark:bg-violet-950'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{title}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
        {count.toLocaleString()}
        <span className="ml-2 text-sm font-normal text-slate-600 dark:text-slate-400">
          {total > 0 ? `${pct}% of the union` : ''}
        </span>
      </p>
      <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">{detail}</p>
    </Link>
  );
}
