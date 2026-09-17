/**
 * Pages a reviewer has asked to be rescanned.
 *
 * This screen is the missing half of the rescan workflow. Requesting a rescan used to record the
 * request and then go nowhere visible — the only output was a printable checklist, and the endpoint
 * that attaches the new scan was wired to nothing. So a request could be made but never answered
 * inside the product.
 *
 * Each row therefore carries the action that closes it: upload the rescan, and the page moves on.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, pageClassView } from '../lib/status';
import type { PageSummary } from '../lib/types';
import { PageThumb } from '../components/PageThumb';
import { Pager, PAGE_SIZE } from '../components/Pager';
import { ReplacePageDialog } from '../components/ReplacePageDialog';
import { Panel } from '../components/Sheet';
import { StatusPill } from '../components/StatusPill';
import { Button, ErrorState, Spinner } from '../components/ui';
import {
  EMPTY_WORK_FILTER,
  FileSplit,
  groupByFile,
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

  const rows = q.data?.items ?? [];
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
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <header className="rule-double pb-2">
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">
          Awaiting rescan
        </h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Pages a reviewer has asked to be scanned again, file by file. Pick a file to see which of
          its pages are waiting, then upload the new scan — the current version is kept in history.
        </p>
      </header>

      <WorkFilters
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setPage(1);
        }}
        searchLabel="File name, MR or IPD"
      />

      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {!q.isLoading && !q.isError ? (
        rows.length === 0 ? (
          <Panel title="Nothing waiting">
            <p className="text-[13px] text-ink-2">
              No page matching these filters is waiting to be rescanned. Pages appear here when a
              reviewer marks one as needing a rescan.
            </p>
          </Panel>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              <span className="font-semibold text-ink">{rows.length}</span> page
              {rows.length === 1 ? '' : 's'} waiting across{' '}
              <span className="font-semibold text-ink">{groups.length}</span> file
              {groups.length === 1 ? '' : 's'}.
            </p>
            <Pager page={page} total={groups.length} count={pageGroups.length} onPage={setPage} />
            <FileSplit
              groups={pageGroups}
              selectedId={selected}
              onSelect={setSelected}
              countLabel={(n) => `${n} page${n === 1 ? '' : 's'} waiting`}
              detail={(g) => (
                <Panel
                  title={g.filename}
                  description={`${g.items.length} page${g.items.length === 1 ? '' : 's'} waiting for a rescan${
                    g.patientRef ? ` · MR ${g.patientRef}` : ''
                  }`}
                >
                  <ul className="divide-y divide-rule">
                    {g.items.map((p) => (
                      <li key={p.page_version_id} className="flex flex-wrap items-start gap-3 py-3">
                        <PageThumb pageVersionId={p.page_version_id} ordinal={p.ordinal} as="div" />
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/pages/${p.page_version_id}`}
                            className="text-[14px] font-medium text-chart underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                          >
                            Page {p.ordinal}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {/* The engine's own verdict; the reviewer asked for a rescan regardless. */}
                            <StatusPill view={pageClassView(p.page_class)} size="sm" />
                            <span className="text-[11px] text-ink-2">scan verdict</span>
                          </div>
                          <p className="mt-1 text-[11px] text-ink-2">
                            Uploaded {formatDateTime(p.uploaded_at)}
                          </p>
                        </div>
                        {can('uploader') ? (
                          <Button variant="primary" onClick={() => setReplacing(p)}>
                            Upload new scan
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            />
          </>
        )
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
