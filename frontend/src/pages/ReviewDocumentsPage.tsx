/**
 * The review queue, a file at a time.
 *
 * Pick a file on the left; the right shows which of its pages still need a decision, as thumbnails
 * that open straight into the viewer. "Outstanding" uses the same definition as the dashboard's
 * awaiting-review figure and the `review_state=pending` page filter, so they can never disagree.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/status';
import type { DocumentSummary } from '../lib/types';
import { Pager, pageParams, useClampPage } from '../components/Pager';
import { PageThumb } from '../components/PageThumb';
import {
  DetailHeader,
  EMPTY_WORK_FILTER,
  FileSplit,
  FilterChip,
  QueueHeader,
  toUploadWindow,
  WorkFilters,
  type WorkFilterValue,
} from '../components/WorkFilters';
import { EmptyState, ErrorState, Spinner } from '../components/ui';

export default function ReviewDocumentsPage() {
  const [filter, setFilter] = useState<WorkFilterValue>(EMPTY_WORK_FILTER);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const docs = useQuery({
    queryKey: ['review-documents', filter, onlyOpen, page],
    queryFn: () => {
      const params = new URLSearchParams(pageParams(page));
      if (filter.search.trim()) params.set('q', filter.search.trim());
      const w = toUploadWindow(filter);
      if (w.from) params.set('from', w.from);
      if (w.to) params.set('to', w.to);
      if (onlyOpen) params.set('needs_review', 'true');
      return api.listDocuments(params);
    },
  });

  const rows = docs.data?.items ?? [];
  useClampPage(page, docs.data?.total, setPage);
  const outstanding = rows.reduce((n, d) => n + (d.awaiting_review ?? 0), 0);

  return (
    <div className="space-y-4">
      <QueueHeader
        title="Review queue"
        subtitle={
          docs.data ? (
            <>
              <strong className="font-semibold text-ink">{outstanding}</strong> page
              {outstanding === 1 ? '' : 's'} waiting for a decision in{' '}
              <strong className="font-semibold text-ink">{docs.data.total}</strong> file
              {docs.data.total === 1 ? '' : 's'}.
            </>
          ) : (
            'Pages the quality check flagged, waiting for a reviewer.'
          )
        }
      />

      <WorkFilters
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setPage(1);
        }}
      >
        <FilterChip
          active={onlyOpen}
          onClick={() => {
            setOnlyOpen((v) => !v);
            setPage(1);
          }}
        >
          Only files with open pages
        </FilterChip>
      </WorkFilters>

      {docs.isLoading ? <Spinner label="Loading the queue…" /> : null}
      {docs.isError ? <ErrorState error={docs.error} retry={() => docs.refetch()} /> : null}

      {docs.data && rows.length === 0 ? (
        <EmptyState title={onlyOpen ? 'All caught up — nothing is waiting for review.' : 'No files match.'} />
      ) : null}

      {rows.length > 0 ? (
        <>
          <FileSplit
            groups={rows.map((d) => ({
              documentId: d.id,
              filename: d.original_filename,
              patientRef: d.patient_ref,
              uploadedAt: d.uploaded_at,
              items: [d],
              count: d.awaiting_review ?? 0,
            }))}
            selectedId={selected}
            onSelect={setSelected}
            countLabel={(n) => `${n} page${n === 1 ? '' : 's'} open`}
            detail={(g) => <FileDetail doc={g.items[0]} />}
          />
          <Pager page={page} total={docs.data?.total} count={rows.length} onPage={setPage} />
        </>
      ) : null}
    </div>
  );
}

function FileDetail({ doc }: { doc: DocumentSummary }) {
  const active = doc.pages_active ?? 0;
  const open = doc.awaiting_review ?? 0;
  const done = Math.max(0, active - open);
  const pct = active > 0 ? Math.round((done / active) * 100) : 100;

  return (
    <div className="border border-rule bg-paper">
      <DetailHeader
        title={doc.original_filename}
        subtitle={
          <>
            {doc.patient_ref ? `MR ${doc.patient_ref} · ` : ''}
            {doc.encounter_ref ? `IPD ${doc.encounter_ref} · ` : ''}
            {active} pages · uploaded {formatDateTime(doc.uploaded_at)}
          </>
        }
        action={
          <Link
            to={`/review/${doc.id}`}
            className="inline-flex h-10 items-center gap-2 border border-chart bg-chart px-4 text-[14px] font-semibold text-paper transition-colors duration-150 hover:bg-chart/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <ClipboardCheck size={16} aria-hidden="true" />
            Review file
          </Link>
        }
      />

      <div className="border-b border-rule px-4 py-3">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-ink">
            <strong className="font-semibold">{open}</strong> open
          </span>
          <span className="tabular-nums text-ink-2">{pct}% reviewed</span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-paper-3" aria-hidden="true">
          <div className="h-full rounded-full bg-chart transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <OpenPages documentId={doc.id} />
    </div>
  );
}

/** The pages in one file still waiting for a decision, so the reviewer sees them before opening it. */
function OpenPages({ documentId }: { documentId: string }) {
  const pages = useQuery({
    queryKey: ['review-open-pages', documentId],
    queryFn: () => {
      const sp = new URLSearchParams({ document_id: documentId, review_state: 'pending', limit: '500' });
      sp.append('page_class', 'review');
      sp.append('page_class', 'rescan');
      return api.listPages(sp);
    },
  });
  const items = pages.data?.items ?? [];

  return (
    <div className="p-4">
      <p className="mb-3 text-[13px] font-medium text-ink-2">Pages waiting for a decision</p>
      {pages.isLoading ? <Spinner label="Loading pages…" /> : null}
      {pages.isError ? <ErrorState error={pages.error} retry={() => pages.refetch()} /> : null}
      {pages.data && items.length === 0 ? (
        <p className="text-[14px] text-ink-2">Nothing in this file is waiting. ✓</p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
        {items.map((p) => (
          <li key={p.page_version_id}>
            <Link
              to={`/pages/${p.page_version_id}`}
              className="block transition-transform duration-150 hover:-translate-y-0.5"
              aria-label={`Open page ${p.ordinal}`}
            >
              <PageThumb
                as="div"
                pageVersionId={p.page_version_id}
                ordinal={p.ordinal}
                printedLabel={p.printed_page_label}
                pageClass={p.page_class}
                reviewState={p.review_state}
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
