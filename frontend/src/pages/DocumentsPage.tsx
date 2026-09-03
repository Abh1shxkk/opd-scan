/**
 * Document / page list.
 *
 * The filter state lives in the URL (see `useUrlFilters`), so this view is shareable and — the part
 * that matters operationally — the Reports screen builds its download URLs from the same query
 * string, which is what docs/API.md requires when it says exports must produce identical totals.
 *
 * Two tabs over one filter set: pages (the unit everything is counted in) and the documents they
 * came from. Only ACTIVE page versions are listed; superseded versions live in a page's history.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { defectLabel } from '../lib/defects';
import { toQueryString } from '../lib/filters';
import {
  diagnosisView,
  formatBytes,
  formatDateTime,
  handwritingView,
  ingestView,
  pageClassView,
  reviewStateView,
} from '../lib/status';
import type { DocumentSummary, PageSummary } from '../lib/types';
import { CompletenessPanel } from '../components/CompletenessPanel';
import { FilterBar } from '../components/FilterBar';
import { StatusPill } from '../components/StatusPill';
import { Button, EmptyState, ErrorState, Spinner } from '../components/ui';
import { useUrlFilters } from '../hooks/useUrlFilters';

type Tab = 'pages' | 'documents';

export default function DocumentsPage() {
  const { filters, setFilters, reset, params, page, setPage } = useUrlFilters();
  const [search, setSearch] = useSearchParams();
  const tab: Tab = search.get('view') === 'documents' ? 'documents' : 'pages';

  function setTab(next: Tab) {
    const sp = new URLSearchParams(search);
    if (next === 'documents') sp.set('view', 'documents');
    else sp.delete('view');
    setSearch(sp, { replace: true });
  }

  const pagesQuery = useQuery({
    queryKey: ['pages', params.toString()],
    queryFn: () => api.listPages(params),
    enabled: tab === 'pages',
  });

  const docsQuery = useQuery({
    queryKey: ['documents', params.toString()],
    queryFn: () => api.listDocuments(params),
    enabled: tab === 'documents',
  });

  const active = tab === 'pages' ? pagesQuery : docsQuery;
  const total = active.data?.total ?? 0;
  const pageSize = active.data?.page_size ?? 50;
  const lastPage = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Documents</h1>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            The filters below are carried in the address bar. Copy the link to share this exact view, or
            open <Link to={`/reports${toQueryString(filters)}`} className="font-medium text-sky-800 underline dark:text-sky-300">Reports</Link>{' '}
            to export precisely these rows.
          </p>
        </div>
        <div role="tablist" aria-label="List view" className="flex gap-1 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {(['pages', 'documents'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
                tab === t
                  ? 'bg-sky-700 text-white dark:bg-sky-600'
                  : 'text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              {t === 'pages' ? 'Pages' : 'Documents'}
            </button>
          ))}
        </div>
      </header>

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={reset}
        resultSummary={
          active.isLoading
            ? 'Loading…'
            : `${total.toLocaleString()} ${tab === 'pages' ? 'active page version' : 'document'}${total === 1 ? '' : 's'} match these filters.`
        }
      />

      {/* Completeness is a property of a patient encounter, so it is only meaningful once the view
          has been narrowed to one case. */}
      {filters.case_id ? <CompletenessPanel caseId={filters.case_id} /> : null}

      {active.isLoading ? <Spinner /> : null}
      {active.isError ? <ErrorState error={active.error} retry={() => active.refetch()} /> : null}

      {tab === 'pages' && pagesQuery.data ? <PagesTable rows={pagesQuery.data.items} /> : null}
      {tab === 'documents' && docsQuery.data ? <DocumentsTable rows={docsQuery.data.items} /> : null}

      {total > pageSize ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Previous
          </Button>
          <p className="text-sm text-slate-700 dark:text-slate-300" aria-live="polite">
            Page {page} of {lastPage}
          </p>
          <Button variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
            Next →
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

/** One accordion group per source document, in the order its pages first appear. */
function groupByDocument(rows: PageSummary[]): Array<{ document_id: string; filename: string; pages: PageSummary[] }> {
  const order: string[] = [];
  const groups = new Map<string, { document_id: string; filename: string; pages: PageSummary[] }>();
  for (const p of rows) {
    let g = groups.get(p.document_id);
    if (!g) {
      g = { document_id: p.document_id, filename: p.document_filename, pages: [] };
      groups.set(p.document_id, g);
      order.push(p.document_id);
    }
    g.pages.push(p);
  }
  return order.map((id) => groups.get(id)!);
}

function PagesTable({ rows }: { rows: PageSummary[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No pages match these filters.">
        Widen the date range or clear a status filter.
      </EmptyState>
    );
  }

  const groups = groupByDocument(rows);

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const first = g.pages[0];
        return (
          <details
            key={g.document_id}
            open={groups.length === 1}
            className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600">
              <div className="min-w-0">
                <span className="block truncate font-medium text-slate-900 dark:text-slate-100" title={g.filename}>
                  {g.filename}
                </span>
                <span className="block text-xs text-slate-600 dark:text-slate-400">
                  {first.uploaded_at ? `Uploaded ${formatDateTime(first.uploaded_at)} · ` : ''}
                  {first.patient_ref ? `Patient ${first.patient_ref} · ` : ''}
                  {first.encounter_ref ? `Encounter ${first.encounter_ref} · ` : ''}
                  {first.batch_name ? `${first.batch_name} · ` : ''}
                  {g.pages.length} page{g.pages.length === 1 ? '' : 's'}
                </span>
              </div>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
              >
                <path d="M5 7l5 5 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
              <table className="table-base">
                <caption className="sr-only">Pages in {g.filename}</caption>
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col">Scan quality</th>
                    <th scope="col">Scan defects</th>
                    <th scope="col">Handwriting</th>
                    <th scope="col">Diagnosis</th>
                    <th scope="col">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {g.pages.map((p) => (
                    <tr key={p.page_version_id}>
                      <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                        <Link
                          to={`/pages/${p.page_version_id}`}
                          className="font-medium text-sky-800 underline dark:text-sky-300"
                        >
                          Page {p.ordinal}
                          {p.printed_page_label ? ` ${p.printed_page_label}` : ''}
                        </Link>
                        {/* Version number is shown because only active versions are listed; v3 means
                            two earlier attempts exist in this page's history. */}
                        <span className="block text-xs text-slate-600 dark:text-slate-400">
                          Version {p.version_no}
                          {p.version_no > 1 ? ' (active)' : ''}
                        </span>
                      </th>
                      <td className="align-top">
                        <StatusPill view={pageClassView(p.page_class)} size="sm" />
                      </td>
                      <td className="align-top">
                        {/* Handwriting is never listed here — it is not a scan-quality defect. */}
                        {p.defect_codes && p.defect_codes.length > 0 ? (
                          <ul className="space-y-0.5">
                            {p.defect_codes.map((c) => (
                              <li key={c} className="text-xs text-slate-800 dark:text-slate-200">
                                {defectLabel(c)}
                              </li>
                            ))}
                          </ul>
                        ) : p.page_class === 'unchecked' || p.page_class === 'failed' ? (
                          <span className="text-xs text-slate-600 dark:text-slate-400">Not measured</span>
                        ) : (
                          <span className="text-xs text-slate-600 dark:text-slate-400">None</span>
                        )}
                      </td>
                      <td className="align-top">
                        <StatusPill view={handwritingView(p.handwriting_status)} size="sm" />
                        {p.handwriting_status === 'detected' && p.handwriting_region_count ? (
                          <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">
                            {p.handwriting_region_count} region{p.handwriting_region_count === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </td>
                      <td className="align-top">
                        <StatusPill view={diagnosisView(p.diagnosis_status)} size="sm" />
                      </td>
                      <td className="align-top">
                        <StatusPill view={reviewStateView(p.review_state)} size="sm" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function DocumentsTable({ rows }: { rows: DocumentSummary[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No documents match these filters." />;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <table className="table-base">
        <caption className="sr-only">Documents matching the current filters</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Record</th>
            <th scope="col">Pages</th>
            <th scope="col">Size</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Ingest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                <span className="block max-w-xs truncate font-medium text-slate-900 dark:text-slate-100" title={d.original_filename}>
                  {d.original_filename}
                </span>
                {d.batch_name ? (
                  <span className="block text-xs text-slate-600 dark:text-slate-400">{d.batch_name}</span>
                ) : null}
              </th>
              <td className="align-top">
                <span className="block text-xs">{d.patient_ref || '—'}</span>
                <span className="block text-xs text-slate-600 dark:text-slate-400">
                  {d.encounter_ref || '—'}
                </span>
              </td>
              <td className="align-top tabular-nums">{d.page_count}</td>
              <td className="align-top tabular-nums">{formatBytes(d.byte_size)}</td>
              <td className="align-top">{formatDateTime(d.uploaded_at)}</td>
              <td className="align-top">
                <StatusPill view={ingestView(d.ingest_status)} size="sm" />
                {d.ingest_error ? (
                  <p className="mt-1 max-w-sm text-xs text-red-900 dark:text-red-200">{d.ingest_error}</p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
