/**
 * Reports and exports.
 *
 * The filter form here is the SAME component and the SAME state shape as the document list, and
 * every download URL is built from `toSearchParams(filters)` — the identical query string the list
 * itself sends. docs/API.md requires exports to produce identical totals to the view, and the only
 * dependable way to guarantee that in a UI is to give the two exactly one source of truth.
 *
 * The row count for the current filters is fetched and displayed next to the buttons, so the user
 * can see what they are about to download before they download it.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, reports } from '../lib/api';
import { toQueryString, toSearchParams } from '../lib/filters';
import { FilterBar, FilterSummary } from '../components/FilterBar';
import { Panel } from '../components/StatTile';
import { useToast } from '../components/Toast';
import { Button, ErrorState } from '../components/ui';
import { useUrlFilters } from '../hooks/useUrlFilters';

type ExportId = 'csv' | 'xlsx' | 'pdf' | 'rescan' | 'flagged';

const EXPORTS: Array<{ id: ExportId; label: string; detail: string }> = [
  {
    id: 'csv',
    label: 'Pages (CSV)',
    detail:
      'One row per active page version. Includes the raw AI diagnosis text and the reviewed text as separate columns.',
  },
  { id: 'xlsx', label: 'Pages (Excel)', detail: 'The same rows and columns as the CSV, as a workbook.' },
  { id: 'pdf', label: 'Pages (PDF)', detail: 'A printable version of the same rows.' },
  {
    id: 'rescan',
    label: 'Rescan checklist (PDF)',
    detail:
      'Only pages classed “Rescan required” or with an accepted rescan request — the list to hand to whoever re-scans.',
  },
  {
    id: 'flagged',
    label: 'Flagged pages (ZIP)',
    detail: 'The page images for the flagged pages in this view.',
  },
];

export default function ReportsPage() {
  const { filters, setFilters, reset, params } = useUrlFilters();
  const toast = useToast();
  const [annotated, setAnnotated] = useState(true);
  const [busy, setBusy] = useState<ExportId | null>(null);
  const [status, setStatus] = useState('');

  // The same endpoint the document list uses, so the count shown is the count exported.
  const countQuery = useQuery({
    queryKey: ['pages', params.toString()],
    queryFn: () => api.listPages(params),
  });

  async function run(id: ExportId) {
    setBusy(id);
    setStatus(`Preparing the ${EXPORTS.find((e) => e.id === id)?.label} export…`);
    const sp = toSearchParams(filters);
    try {
      if (id === 'csv') await reports.csv(sp);
      else if (id === 'xlsx') await reports.xlsx(sp);
      else if (id === 'pdf') await reports.pdf(sp);
      else if (id === 'rescan') await reports.rescanChecklist(sp);
      else await reports.flaggedZip(sp, annotated);
      setStatus('Export downloaded.');
      toast.push('Export downloaded.', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The export failed.';
      setStatus(`Export failed. ${msg}`);
      toast.push(msg, 'error');
    } finally {
      setBusy(null);
    }
  }

  const total = countQuery.data?.total;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Reports</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Exports use exactly the filters set below — the same query string the{' '}
          <Link to={`/documents${toQueryString(filters)}`} className="font-medium text-sky-800 underline dark:text-sky-300">
            document list
          </Link>{' '}
          uses, so the totals match what you see there.
        </p>
      </header>

      <FilterBar value={filters} onChange={setFilters} onReset={reset} />

      <Panel
        title="What will be exported"
        description="Check this matches what you expect before downloading."
      >
        <FilterSummary value={filters} />
        <p className="mt-2 text-sm text-slate-900 dark:text-slate-100">
          {countQuery.isLoading ? (
            'Counting matching pages…'
          ) : countQuery.isError ? (
            <span className="text-red-900 dark:text-red-200">The row count could not be loaded.</span>
          ) : (
            <>
              <strong className="tabular-nums">{(total ?? 0).toLocaleString()}</strong> active page version
              {total === 1 ? '' : 's'} will be included. Superseded versions are never exported.
            </>
          )}
        </p>
        {countQuery.isError ? <ErrorState error={countQuery.error} retry={() => countQuery.refetch()} /> : null}
      </Panel>

      <Panel title="Downloads">
        <ul className="space-y-3">
          {EXPORTS.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="min-w-[16rem] flex-1">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{e.label}</p>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{e.detail}</p>
                {e.id === 'flagged' ? (
                  <label className="mt-2 flex items-center gap-2 text-sm text-slate-900 dark:text-slate-100">
                    <input
                      type="checkbox"
                      checked={annotated}
                      onChange={(ev) => setAnnotated(ev.target.checked)}
                      className="h-4 w-4 rounded border-slate-500 text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                    />
                    Burn the overlays into the exported images
                  </label>
                ) : null}
              </div>
              <Button variant="secondary" disabled={busy !== null} onClick={() => run(e.id)}>
                {busy === e.id ? 'Preparing…' : 'Download'}
              </Button>
            </li>
          ))}
        </ul>

        <p aria-live="polite" className="mt-3 text-sm text-slate-700 dark:text-slate-300">
          {status}
        </p>
      </Panel>

      <Panel title="Column notes">
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-800 dark:text-slate-200">
          <li>
            <code className="font-mono text-xs">diagnosis_text</code> is the raw AI transcription and{' '}
            <code className="font-mono text-xs">diagnosis_text_reviewed</code> is what a human confirmed.
            They are separate columns; the raw text is never overwritten.
          </li>
          <li>
            <code className="font-mono text-xs">ai_vs_reviewed</code> says whether a human has looked at
            the extraction at all. An empty reviewed column means unreviewed AI output, not agreement.
          </li>
          <li>
            <code className="font-mono text-xs">handwriting_status</code> is its own column and is never
            part of <code className="font-mono text-xs">defect_codes</code> — handwriting is not a scan
            defect.
          </li>
          <li>
            <code className="font-mono text-xs">scan_status</code> distinguishes blank, failed and
            unchecked pages from acceptable ones. None of the three is counted as acceptable.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
