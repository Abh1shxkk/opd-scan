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
import { Pager, pageParams } from '../components/Pager';
import { ReplacePageDialog } from '../components/ReplacePageDialog';
import { Panel } from '../components/Sheet';
import { StatusPill } from '../components/StatusPill';
import { Button, ErrorState, Spinner } from '../components/ui';

export default function RescanQueuePage() {
  const { can } = useAuth();
  const [replacing, setReplacing] = useState<PageSummary | null>(null);
  const [page, setPage] = useState(1);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('review_state', 'rescan_requested');
    const { limit, offset } = pageParams(page);
    sp.set('limit', limit);
    sp.set('offset', offset);
    return sp;
  }, [page]);

  const q = useQuery({
    queryKey: ['rescan-queue', params.toString()],
    queryFn: () => api.listPages(params),
  });

  const rows = q.data?.items ?? [];

  return (
    <div className="space-y-4">
      <header className="rule-double pb-2">
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">
          Awaiting rescan
        </h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Pages a reviewer has asked to be scanned again. Upload the new scan here — the current
          version is kept in history and stops being counted.
        </p>
      </header>

      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {!q.isLoading && !q.isError ? (
        <Panel
          title={`${q.data?.total ?? rows.length} page${(q.data?.total ?? rows.length) === 1 ? '' : 's'} waiting`}
          description={
            rows.length > 0
              ? 'Oldest request first. A page leaves this list once its replacement is uploaded.'
              : undefined
          }
        >
          {rows.length === 0 ? (
            <p className="text-[13px] text-ink-2">
              Nothing is waiting to be rescanned. Pages appear here when a reviewer requests one
              from the review queue or the page viewer.
            </p>
          ) : (
            <>
            <Pager page={page} total={q.data?.total} count={rows.length} onPage={setPage} />
            <ul className="divide-y divide-rule">
              {rows.map((p) => (
                <li key={p.page_version_id} className="flex items-start gap-3 py-3">
                  <PageThumb pageVersionId={p.page_version_id} ordinal={p.ordinal} as="div" />

                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/pages/${p.page_version_id}`}
                      className="text-[13px] font-medium text-chart underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      Page {p.ordinal} of {p.document_filename}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <StatusPill view={pageClassView(p.page_class)} size="sm" />
                      {p.patient_ref ? (
                        <span className="text-[11px] text-ink-2">MR {p.patient_ref}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11px] text-ink-2">
                      Uploaded {formatDateTime(p.uploaded_at)}
                    </p>
                  </div>

                  {can('uploader') ? (
                    <Button variant="primary" onClick={() => setReplacing(p)}>
                      Upload rescan
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            </>
          )}
        </Panel>
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
