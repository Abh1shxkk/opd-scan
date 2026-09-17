/**
 * One file's pages, together.
 *
 * Every page of a single PDF laid out as it was scanned, each carrying its own verdict, so a
 * reviewer sees the shape of the whole file — three bad pages in a row usually means the scanner
 * slipped, not that three pages are individually wrong — before deciding any one of them.
 *
 * The decision itself still happens on the page viewer, one page at a time, with the image beside
 * its findings. This screen chooses the order; it does not shortcut the judgement.
 */

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { effectivePageClass, formatDateTime, isOpenForReview, PAGE_CLASS_ORDER, pageClassView } from '../lib/status';
import type { PageClass, PageSummary } from '../lib/types';
import { ChartHead, MarginNote, Panel } from '../components/Sheet';
import { PageThumb } from '../components/PageThumb';
import { StatusPill } from '../components/StatusPill';
import { Button, EmptyState, ErrorState, Spinner } from '../components/ui';

type Lens = 'all' | 'open' | PageClass;

export default function ReviewDocumentPage() {
  const { documentId = '' } = useParams();
  const [lens, setLens] = useState<Lens>('all');

  const doc = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId),
    enabled: Boolean(documentId),
  });

  const pages = useQuery({
    queryKey: ['document-pages', documentId],
    queryFn: () =>
      api.listPages(new URLSearchParams({ document_id: documentId, limit: '500' })),
    enabled: Boolean(documentId),
  });

  const all = pages.data?.items ?? [];

  const counts = useMemo(() => {
    const out: Partial<Record<PageClass, number>> = {};
    // Counted after the reviewer's decision: an accepted page is acceptable here, as it is on the
    // queue row for this file and on the dashboard.
    for (const p of all) {
      const c = effectivePageClass(p.page_class as PageClass, p.review_state);
      out[c] = (out[c] ?? 0) + 1;
    }
    return out;
  }, [all]);

  const openPages = useMemo(
    () => all.filter((p) => isOpenForReview(p.page_class as PageClass, p.review_state)),
    [all],
  );

  const shown = useMemo(() => {
    if (lens === 'all') return all;
    if (lens === 'open') return openPages;
    return all.filter((p) => effectivePageClass(p.page_class as PageClass, p.review_state) === lens);
  }, [all, lens, openPages]);

  if (doc.isError) return <ErrorState error={doc.error} retry={() => doc.refetch()} />;
  if (doc.isLoading) return <Spinner label="Loading the file…" />;
  if (!doc.data) return null;

  const d = doc.data;

  return (
    <div className="space-y-3">
      <ChartHead
        title={d.original_filename}
        description="Every page of this file, with the verdict the quality engine gave it. Open a page to decide it beside its findings."
        meta={[
          {
            label: 'Patient',
            value: d.patient_ref ? (
              <span className="tabular-nums">{d.patient_ref}</span>
            ) : (
              <span className="text-ink-2">Not linked to a record</span>
            ),
          },
          {
            label: 'IPD number',
            value: d.encounter_ref ? (
              <span className="tabular-nums">{d.encounter_ref}</span>
            ) : (
              <span className="text-ink-2">—</span>
            ),
          },
          { label: 'Pages', value: <span className="tabular-nums">{all.length}</span> },
          { label: 'Uploaded', value: formatDateTime(d.uploaded_at) },
        ]}
        actions={
          <>
            <Link
              to="/review"
              className="inline-flex min-h-[30px] items-center gap-1.5 border border-rule-2 bg-paper-2 px-3 font-label text-[12px] font-semibold uppercase tracking-label text-ink transition-colors duration-150 ease-chart hover:bg-paper-3"
            >
              <ArrowLeft size={13} strokeWidth={2.5} aria-hidden="true" />
              Queue
            </Link>
            {d.case_id ? (
              <Link
                to={`/patients/${d.case_id}`}
                className="inline-flex min-h-[30px] items-center gap-1.5 border border-rule-2 bg-paper-2 px-3 font-label text-[12px] font-semibold uppercase tracking-label text-ink transition-colors duration-150 ease-chart hover:bg-paper-3"
              >
                <FileText size={13} strokeWidth={2.5} aria-hidden="true" />
                Patient record
              </Link>
            ) : null}
          </>
        }
      />

      <Panel
        title="Show"
        description="Narrows which pages are laid out below. It never changes the verdicts themselves."
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Lens active={lens === 'all'} onClick={() => setLens('all')}>
            All {all.length}
          </Lens>
          <Lens active={lens === 'open'} onClick={() => setLens('open')} tone="warn">
            Needs a decision {openPages.length}
          </Lens>
          {PAGE_CLASS_ORDER.filter((c) => (counts[c] ?? 0) > 0).map((c) => (
            <Lens key={c} active={lens === c} onClick={() => setLens(c)}>
              <span className="inline-flex items-center gap-1">
                <StatusPill view={pageClassView(c)} size="sm" />
                <span className="tabular-nums">{counts[c]}</span>
              </span>
            </Lens>
          ))}
        </div>
      </Panel>

      <Panel
        title="Pages"
        description="In the order they were scanned. A run of bad pages usually means the scanner slipped, not that each page is separately wrong."
        flush
      >
        {pages.isLoading ? (
          <div className="p-3">
            <Spinner label="Loading pages…" />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-3">
            <EmptyState title="No pages match this view.">
              {all.length > 0 ? 'Try "All" above.' : 'This file has no rendered pages yet.'}
            </EmptyState>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 p-3">
            {shown.map((p: PageSummary) => (
              <Link
                key={p.page_version_id}
                to={`/pages/${p.page_version_id}`}
                className="block"
                aria-label={`Open page ${p.ordinal}`}
              >
                <PageThumb
                  as="div"
                  pageVersionId={p.page_version_id}
                  ordinal={p.ordinal}
                  printedLabel={p.printed_page_label}
                  pageClass={p.page_class as PageClass}
                  reviewState={p.review_state}
                />
              </Link>
            ))}
          </div>
        )}
      </Panel>

      {d.ingest_error ? <MarginNote tone="warn">{d.ingest_error}</MarginNote> : null}
    </div>
  );
}

function Lens({
  active,
  onClick,
  children,
  tone = 'plain',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'plain' | 'warn';
}) {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      onClick={onClick}
      aria-pressed={active}
      className={tone === 'warn' && !active ? 'border-note/50 text-note' : ''}
    >
      {children}
    </Button>
  );
}
