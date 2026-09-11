/**
 * Dashboard.
 *
 * Three things this screen is careful about, all of them counting rules from docs/PLAN.md §3:
 *
 * - "Acceptable" is one number and only one number. `blank`, `failed` and `unchecked` are listed
 * separately with their own tones and are never added into it, so nobody can read a headline
 * figure as "this many pages passed" when a third of them were never measured.
 * - Handwriting is a separate axis, not a defect. It has its own panel and never appears in the
 * defect breakdown.
 * - The categories overlap, so there is an explicit overlap panel. Showing "42 defects, 30
 * handwriting" side by side implies a partition of 72 pages; the API supplies
 * defect_and_handwriting precisely so the UI does not have to imply anything.
 *
 * Every count is a distinct ACTIVE page version — superseded versions are not in these figures.
 *
 * How those rules are drawn, rather than written: a class that was never measured is hatched
 * wherever it appears, its headline figure included, so the eye separates "measured and fine" from
 * "nothing is known" before it reads a single word. The paragraphs that used to carry the
 * distinctions are still here, but as margin notes beside the figures they qualify rather than as
 * a wall of prose above them.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Settings2 } from 'lucide-react';
import { api } from '../lib/api';
import { defectLabel } from '../lib/defects';
import { isEmpty, toQueryString } from '../lib/filters';
import {
  capabilityLabel,
  formatDateTime,
  DIAGNOSIS_ORDER,
  diagnosisView,
  HANDWRITING_ORDER,
  handwritingView,
  PAGE_CLASS_ORDER,
  pageClassView,
} from '../lib/status';
import type { DashboardResponse } from '../lib/types';
import { FilterBar } from '../components/FilterBar';
import { ChartHead, MarginNote, Panel } from '../components/Sheet';
import { BandPlot, Reading } from '../components/BandPlot';
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
  const pages = q.data?.totals?.pages_active ?? null;
  return (
    <div className="space-y-3">
      <ChartHead
        title="Dashboard"
        meta={[
          { label: 'Counting', value: 'Distinct active page versions' },
          {
            label: 'Active page versions',
            value:
              pages === null ? (
                <span className="text-ink-2">Not yet read</span>
              ) : (
                <span className="tabular-nums">{pages.toLocaleString()}</span>
              ),
          },
          { label: 'View', value: describeFilters(filters) },
          {
            label: 'Generated',
            value: q.dataUpdatedAt ? (
              <span className="tabular-nums">{formatDateTime(new Date(q.dataUpdatedAt).toISOString())}</span>
            ) : (
              <span className="text-ink-2">—</span>
            ),
          },
        ]}
      />
      <FilterBar value={filters} onChange={setFilters} onReset={reset} />
      {q.isLoading ? <Spinner label="Loading dashboard…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}
      {q.data ? <DashboardBody data={q.data} filters={filters} /> : null}
    </div>
  );
}

/**
 * What is actually narrowing this view.
 *
 * "Filtered" on its own tells a reader nothing about which figures they are looking at, so the
 * head names the constraints rather than announcing that some exist.
 */
function describeFilters(f: Filters): string {
  if (isEmpty(f)) return 'All records';
  const parts: string[] = [];
  if (f.q) parts.push(`search “${f.q}”`);
  if (f.batch_id) parts.push('batch');
  if (f.patient_ref) parts.push(`patient ${f.patient_ref}`);
  if (f.encounter_ref) parts.push(`encounter ${f.encounter_ref}`);
  if (f.from || f.to) parts.push(`uploaded ${f.from || '…'} to ${f.to || '…'}`);
  if (f.review_state) parts.push(`review state ${f.review_state.replace(/_/g, ' ')}`);
  if (f.page_class.length) parts.push(`${f.page_class.length} page class${f.page_class.length > 1 ? 'es' : ''}`);
  if (f.defect_code.length) parts.push(`${f.defect_code.length} defect${f.defect_code.length > 1 ? 's' : ''}`);
  if (f.handwriting.length) parts.push(`${f.handwriting.length} handwriting state${f.handwriting.length > 1 ? 's' : ''}`);
  if (f.diagnosis_status.length)
    parts.push(`${f.diagnosis_status.length} diagnosis state${f.diagnosis_status.length > 1 ? 's' : ''}`);
  return parts.join(' · ');
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
  const jobsFailed = t.processing?.failed ?? 0;
  const unconfigured = Object.entries(data.capabilities ?? {}).filter(
    ([, c]) => c?.status === 'unconfigured',
  );
  const ready = Object.entries(data.capabilities ?? {}).filter(([, c]) => c?.status === 'ready');
  return (
    <div className="space-y-3">
      {/* ------------------------------------------------------------ headline */}
      {/*
        One continuous ruled table, not a row of tiles. Every figure that belongs to a population
        is plotted against it, so "46 acceptable" is read as a share of 213 rather than as a number
        floating on its own; the two that ARE the population carry no band, because there is
        nothing truthful to plot them against.
      */}
      <Panel
        title="Totals"
        description="Counts for the current view. Acceptable is this class alone — blank, failed and unchecked are counted separately below."
        flush
      >
        <div className="divide-y divide-rule">
          <Reading
            label="Files"
            value={(t.files ?? 0).toLocaleString()}
            to={listLink(filters, {})}
          />
          <Reading
            label="Active pages"
            value={pages.toLocaleString()}
            note="The population every share below is measured against."
            to={listLink(filters, {})}
          />
          <Reading
            label="Acceptable pages"
            value={acceptable.toLocaleString()}
            band={<BandPlot value={acceptable} max={pages || 1} tone="ok" width="w-20 sm:w-32" />}
            to={listLink(filters, { page_class: ['acceptable'] })}
          />
          <Reading
            label="Awaiting review"
            value={(t.awaiting_review ?? 0).toLocaleString()}
            band={
              <BandPlot
                value={t.awaiting_review ?? 0}
                max={pages || 1}
                tone="warn"
                width="w-20 sm:w-32"
              />
            }
            to={`/review${toQueryString({ ...filters, review_state: 'pending' })}`}
          />
          <Reading
            label="Never measured"
            value={notMeasured.toLocaleString()}
            unmeasured
            band={
              <BandPlot
                value={notMeasured}
                max={pages || 1}
                unmeasured
                width="w-20 sm:w-32"
              />
            }
            note="Quality check failed or has not run. Nothing is known about these pages, and they are not counted as acceptable."
            to={listLink(filters, { page_class: ['failed', 'unchecked'] })}
          />
        </div>
      </Panel>

      {/* --------------------------------------------------------- processing */}
      <Panel title="Processing" description="Work the queue still owes this view." flush>
        <div className="divide-y divide-rule">
          <Reading label="Jobs queued" value={(t.processing?.queued ?? 0).toLocaleString()} />
          <Reading label="Jobs running" value={(t.processing?.running ?? 0).toLocaleString()} />
          <Reading
            label="Jobs failed"
            value={jobsFailed.toLocaleString()}
            unmeasured={jobsFailed > 0}
            note={jobsFailed > 0 ? 'A failed job leaves its page unmeasured, not clean.' : undefined}
          />
        </div>
      </Panel>

      {/* ------------------------------------------------------- distributions */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel
          title="Scan quality"
          description="Each page falls in exactly one class. Blank, failed and unchecked are never folded into acceptable."
          flush
        >
          <ul className="divide-y divide-rule">
            {PAGE_CLASS_ORDER.map((c) => (
              <li key={c}>
                <Link to={listLink(filters, { page_class: [c] })} className="block">
                  <StatusCountRow
                    view={pageClassView(c)}
                    count={t.quality?.[c] ?? 0}
                    total={pages}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title="Handwriting"
          description="A separate axis. Handwriting is not a scan-quality defect and is never counted as one."
          flush
        >
          <ul className="divide-y divide-rule">
            {HANDWRITING_ORDER.map((s) => (
              <li key={s}>
                <Link to={listLink(filters, { handwriting: [s] })} className="block">
                  <StatusCountRow
                    view={handwritingView(s)}
                    count={t.handwriting?.[s] ?? 0}
                    total={pages}
                  />
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-rule p-2.5">
            <MarginNote>
              “Not checked” means the check failed or no provider is configured. It does{' '}
              <strong className="font-semibold text-ink">not</strong> mean the page has no
              handwriting — that is the hatched rows above.
            </MarginNote>
          </div>
        </Panel>
        <Panel
          title="Diagnosis extraction"
          description="Status of the AI transcription per page."
          flush
        >
          <ul className="divide-y divide-rule">
            {DIAGNOSIS_ORDER.map((s) => (
              <li key={s}>
                <Link to={listLink(filters, { diagnosis_status: [s] })} className="block">
                  <StatusCountRow
                    view={diagnosisView(s)}
                    count={t.diagnosis?.[s] ?? 0}
                    total={pages}
                  />
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
        flush
      >
        {(data.defects ?? []).length === 0 ? (
          <div className="p-3">
            <EmptyState title="No scan defects recorded in this view." />
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {[...data.defects]
              .sort((a, b) => b.pages - a.pages)
              .map((d) => {
                const max = Math.max(...data.defects.map((x) => x.pages), 1);
                const pct = Math.round((d.pages / max) * 100);
                return (
                  <li key={d.code}>
                    <Link
                      to={listLink(filters, { defect_code: [d.code] })}
                      className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2.5 px-2 py-1.5 text-[13px] transition-colors duration-150 ease-chart hover:bg-chart/[0.07]"
                    >
                      <span className="truncate text-ink">{defectLabel(d.code, d.label)}</span>
                      <span className="shrink-0 tabular-nums font-semibold text-ink">
                        {d.pages.toLocaleString()}
                        <span className="ml-1 font-normal text-ink-2">
                          page{d.pages === 1 ? '' : 's'}
                        </span>
                      </span>
                      {/* Plotted against the most frequent defect, so the list is comparable at a
 glance. The number beside it remains the authority. */}
                      <span
                        aria-hidden="true"
                        className="chart-grid relative h-2.5 w-16 shrink-0 border border-rule bg-paper sm:w-28"
                      >
                        <span
                          className="absolute inset-y-0 left-0 bg-chart"
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
          <p className="text-[13px] text-ink-2">
            Every configured capability is reporting as ready.
          </p>
        ) : (
          <ul className="space-y-2">
            {unconfigured.map(([key, cap]) => (
              <li key={key} className="hatch border-b border-rule bg-note/[0.07] px-2.5 py-2 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{capabilityLabel(key)}</span>
                  <StatusPill
                    view={{
                      label: 'Not configured',
                      tone: 'warn',
                      icon: Settings2,
                      unmeasured: true,
                    }}
                    size="sm"
                  />
                </div>
                {/* setup_required is the actionable instruction from the backend — shown verbatim. */}
                {cap.setup_required ? (
                  <p className="mt-1 text-[12px] text-ink">{cap.setup_required}</p>
                ) : null}
                <p className="mt-1 text-[11px] text-ink-2">
                  Pages that needed this capability are recorded as “not checked”, not as clean.
                </p>
              </li>
            ))}
          </ul>
        )}
        {ready.length > 0 ? (
          <dl className="mt-3 grid gap-x-6 gap-y-1 border-t border-rule pt-2.5 sm:grid-cols-2">
            {ready.map(([key, cap]) => (
              <div key={key} className="flex items-baseline justify-between gap-3 text-[12px]">
                <dt className="truncate text-ink">{capabilityLabel(key)}</dt>
                <dd className="shrink-0 font-label uppercase tracking-label text-band">
                  {cap.provider ? cap.provider : 'Ready'}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
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
      <div className="grid border-y border-rule sm:grid-cols-3">
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
      <MarginNote>
        {union.toLocaleString()} distinct page{union === 1 ? '' : 's'} fall into at least one of the
        two categories. Adding the two category totals together would double-count the{' '}
        {o.defect_and_handwriting.toLocaleString()} page
        {o.defect_and_handwriting === 1 ? '' : 's'} in the middle column.
      </MarginNote>
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
      className={`block px-2.5 py-2 transition-colors duration-150 ease-chart hover:bg-chart/[0.07] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-rule sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-t-0 ${
        emphasise ? 'bg-paper-2' : ''
      }`}
    >
      <p className="field-label">{title}</p>
      <p className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[20px] font-semibold leading-none tracking-tight tabular-nums text-ink">
          {count.toLocaleString()}
        </span>
        <span className="text-[11px] tabular-nums text-ink-2">
          {total > 0 ? `${pct}% of the union` : ''}
        </span>
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-ink-2">{detail}</p>
    </Link>
  );
}
