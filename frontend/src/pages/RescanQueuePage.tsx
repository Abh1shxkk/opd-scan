/**
 * Pages a reviewer has asked to be rescanned, file by file.
 *
 * Each row carries the action that closes it: upload the new scan and the page leaves the list.
 * The current version is kept in history.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/status';
import type { PageSummary } from '../lib/types';
import { PageThumb } from '../components/PageThumb';
import { Pager, PAGE_SIZE, useClampPage } from '../components/Pager';
import { ReplacePageDialog } from '../components/ReplacePageDialog';
import { ErrorState, EmptyState, Spinner } from '../components/ui';
import {
  DetailHeader,
  EMPTY_WORK_FILTER,
  FileSplit,
  groupByFile,
  QueueHeader,
  toUploadWindow,
  WorkFilters,
  type WorkFilterValue,
} from '../components/WorkFilters';

export default function RescanQueuePage() {
  const { can } = useAuth();
  const [replacing, setReplacing] = useState<PageSummary | null>(null);
  const [filter, setFilter] = useState<WorkFilterValue>(EMPTY_WORK_FILTER);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('review_state', 'rescan_requested');
    // Grouped by file on this screen, so pages are fetched in one go and the files are paged.
    sp.set('limit', '1000');
    if (filter.search.trim()) sp.set('q', filter.search.trim());
    const w = toUploadWindow(filter);
    if (w.from) sp.set('from', w.from);
    if (w.to) sp.set('to', w.to);
    return sp;
  }, [filter]);

  const q = useQuery({
    queryKey: ['rescan-queue', params.toString()],
    queryFn: () => api.listPages(params),
  });

  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const groups = useMemo(
    () =>
      groupByFile(rows, (p) => ({
        documentId: p.document_id,
        filename: p.document_filename,
        patientRef: p.patient_ref,
        uploadedAt: p.uploaded_at,
      })),
    [rows],
  );
  useClampPage(page, groups.length, setPage);
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <QueueHeader
        title="Awaiting rescan"
        subtitle={
          q.data ? (
            <>
              <strong className="font-semibold text-ink">{rows.length}</strong> page
              {rows.length === 1 ? '' : 's'} to scan again in{' '}
              <strong className="font-semibold text-ink">{groups.length}</strong> file
              {groups.length === 1 ? '' : 's'}.
            </>
          ) : (
            'Pages a reviewer has asked to be scanned again.'
          )
        }
      />

      <WorkFilters
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setPage(1);
        }}
      />

      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {q.data && rows.length === 0 ? (
        <EmptyState title="Nothing to rescan." >
          Pages appear here when a reviewer marks one as needing a rescan.
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <>
          <FileSplit
            groups={pageGroups}
            selectedId={selected}
            onSelect={setSelected}
            countLabel={(n) => `${n} page${n === 1 ? '' : 's'} to rescan`}
            detail={(g) => (
              <div className="border border-rule bg-paper">
                <DetailHeader
                  title={g.filename}
                  subtitle={`${g.patientRef ? `MR ${g.patientRef} · ` : ''}${g.items.length} page${
                    g.items.length === 1 ? '' : 's'
                  } to scan again`}
                />
                <ul className="divide-y divide-rule">
                  {g.items.map((p) => (
                    <li key={p.page_version_id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                      <Link
                        to={`/pages/${p.page_version_id}`}
                        className="block w-28 shrink-0"
                        aria-label={`Open page ${p.ordinal}`}
                      >
                        <PageThumb pageVersionId={p.page_version_id} ordinal={p.ordinal} as="div" />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/pages/${p.page_version_id}`}
                          className="text-[15px] font-semibold text-ink hover:text-chart hover:underline"
                        >
                          Page {p.ordinal}
                        </Link>
                        <p className="mt-0.5 text-[13px] text-ink-2">
                          Uploaded {formatDateTime(p.uploaded_at)}
                        </p>
                      </div>
                      {can('uploader') ? (
                        <button
                          type="button"
                          onClick={() => setReplacing(p)}
                          className="inline-flex h-10 items-center gap-2 border border-chart bg-chart px-4 text-[14px] font-semibold text-paper transition-colors duration-150 hover:bg-chart/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          <Upload size={16} aria-hidden="true" />
                          Upload new scan
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          />
          <Pager page={page} total={groups.length} count={pageGroups.length} onPage={setPage} />
        </>
      ) : null}

      {replacing ? (
        <ReplacePageDialog
          pageVersionId={replacing.page_version_id}
          pageLabel={`Page ${replacing.ordinal} of ${replacing.document_filename}`}
          open
          onClose={() => setReplacing(null)}
          // Staying on this list is right here: the replaced page drops off it, and the user is
          // most likely working through a stack of rescans rather than inspecting one page.
          onReplaced={() => setReplacing(null)}
        />
      ) : null}
    </div>
  );
}
