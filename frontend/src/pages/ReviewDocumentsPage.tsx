/**
 * The review queue, a file at a time.
 *
 * It used to interleave pages from every document in one list — page 7 of one patient's discharge
 * summary above page 2 of another's case sheet — which asks a reviewer to change patient, file and
 * context on every single row. Paper was never handled that way. This lists the files that still
 * have something outstanding; opening one shows all of its pages together.
 *
 * "Outstanding" uses the same definition as the dashboard's awaiting-review figure and the
 * `review_state=pending` page filter, so the three can never disagree about what is left.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { Pager, pageParams } from '../components/Pager';
import { formatDateTime, pageClassView, PAGE_CLASS_ORDER } from '../lib/status';
import type { DocumentSummary, PageClass } from '../lib/types';
import { BandPlot } from '../components/BandPlot';
import { ChartHead, MarginNote, Panel } from '../components/Sheet';
import { StatusPill } from '../components/StatusPill';
import { Button, EmptyState, ErrorState, Spinner, TextInput } from '../components/ui';

export default function ReviewDocumentsPage() {
  const [q, setQ] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [page, setPage] = useState(1);

  const docs = useQuery({
    queryKey: ['review-documents', q, onlyOpen, page],
    queryFn: () => {
      const params = new URLSearchParams(pageParams(page));
      if (q.trim()) params.set('q', q.trim());
      if (onlyOpen) params.set('needs_review', 'true');
      return api.listDocuments(params);
    },
  });

  const rows = docs.data?.items ?? [];
  const outstanding = rows.reduce((n, d) => n + (d.awaiting_review ?? 0), 0);

  return (
    <div className="space-y-3">
      <ChartHead
        title="Review queue"
        description="Files with pages a reviewer has not yet accepted or sent for rescan. Open a file to work through its pages together."
        meta={[
          { label: 'Files listed', value: <span className="tabular-nums">{rows.length}</span> },
          {
            label: 'Pages outstanding',
            value: <span className="tabular-nums">{outstanding.toLocaleString()}</span>,
          },
          {
            label: 'Showing',
            value: onlyOpen ? 'Files with work outstanding' : 'All files',
          },
          {
            label: 'Counted as outstanding',
            value: 'Needs review or rescan, not yet closed',
          },
        ]}
      />

      <Panel
        title="Filter"
        description="A page that could not be measured is not counted here — it is unmeasured, not un-reviewed."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextInput
            label="File name"
            value={q}
            placeholder="e.g. case-sheet, discharge"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <div className="flex items-end">
            <Button
              variant={onlyOpen ? 'primary' : 'secondary'}
              onClick={() => {
                setOnlyOpen((v) => !v);
                setPage(1);
              }}
              aria-pressed={onlyOpen}
            >
              {onlyOpen ? 'Outstanding only' : 'All files'}
            </Button>
          </div>
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setQ('');
                setPage(1);
              }}
              disabled={!q}
            >
              Clear
            </Button>
          </div>
        </div>
      </Panel>

      <Pager page={page} total={docs.data?.total} count={rows.length} onPage={setPage} />

      {docs.isLoading ? <Spinner label="Loading the queue…" /> : null}
      {docs.isError ? <ErrorState error={docs.error} retry={() => docs.refetch()} /> : null}

      {docs.data ? (
        <Panel title="Files" flush>
          {rows.length === 0 ? (
            <div className="p-3">
              <EmptyState
                title={onlyOpen ? 'Nothing is waiting for a decision.' : 'No files match this view.'}
              >
                {onlyOpen ? 'Every page in every file has been accepted or sent for rescan.' : null}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {rows.map((d) => (
                <li key={d.id}>
                  <DocumentRow doc={d} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <MarginNote>
        Working a file at a time keeps one patient, one document and one set of scanner conditions
        in front of you at once. A page is still opened and decided individually — this only
        changes the order they are put in.
      </MarginNote>
    </div>
  );
}

function DocumentRow({ doc }: { doc: DocumentSummary }) {
  const active = doc.pages_active ?? 0;
  const open = doc.awaiting_review ?? 0;
  const counts = doc.page_class_counts ?? {};
  const present = PAGE_CLASS_ORDER.filter((c) => (counts[c] ?? 0) > 0);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-2.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px]">
          <FileText size={13} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-ink-2" />
          <span className="truncate font-medium text-ink">{doc.original_filename}</span>
        </p>

        <p className="mt-1 text-[11px] text-ink-2">
          {doc.patient_ref ? (
            <>
              Patient <span className="tabular-nums">{doc.patient_ref}</span>
              {doc.encounter_ref ? (
                <>
                  {' · '}IPD <span className="tabular-nums">{doc.encounter_ref}</span>
                </>
              ) : null}
              {' · '}
            </>
          ) : null}
          {active} page{active === 1 ? '' : 's'} · uploaded {formatDateTime(doc.uploaded_at)}
        </p>

        {present.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {present.map((c) => (
              <span key={c} className="flex items-center gap-1">
                <StatusPill view={pageClassView(c as PageClass)} size="sm" />
                <span className="tabular-nums text-[11px] text-ink-2">{counts[c]}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="w-28 text-right">
          <p className="text-[13px] tabular-nums text-ink">
            {open} of {active} open
          </p>
          {/* Plotted against the file's own page count, so "12 open" reads differently in a
              3-page consent form and a 113-page case sheet. */}
          <BandPlot
            className="mt-1"
            value={open}
            max={active || 1}
            tone={open > 0 ? 'warn' : 'ok'}
            height="h-1.5"
          />
        </div>

        <Link
          to={`/review/${doc.id}`}
          className="inline-flex min-h-[30px] items-center gap-1.5 border border-chart bg-chart px-3 font-label text-[12px] font-semibold uppercase tracking-label text-paper transition-colors duration-150 ease-chart hover:bg-chart/90"
        >
          <ClipboardCheck size={13} strokeWidth={2.5} aria-hidden="true" />
          Review file
        </Link>
      </div>
    </div>
  );
}
