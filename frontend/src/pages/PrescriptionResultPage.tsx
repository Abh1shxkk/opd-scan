/**
 * The reading for one prescription upload, page by page.
 *
 * Deliberately mirrors PageViewerPage's layout: a horizontal strip of page thumbnails up top, the
 * selected page's image on the left and its reading on the right below that — so the shape is
 * familiar to anyone who has already used the scan-QC page viewer.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, imagePath } from '../lib/api';
import { formatDuration } from '../lib/status';
import { PageThumb } from '../components/PageThumb';
import { PrescriptionPageDetails } from '../components/PrescriptionResultPanel';
import { Panel } from '../components/StatTile';
import { ErrorState, Spinner } from '../components/ui';
import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';

export default function PrescriptionResultPage() {
  const { documentId = '' } = useParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['prescription-analysis', documentId],
    queryFn: () => api.getPrescriptionAnalysis(documentId),
    enabled: Boolean(documentId),
  });

  if (q.isLoading) return <Spinner label="Loading analysis…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return null;

  const result = q.data;
  const pages = result.pages;
  const active = pages.find((p) => p.page_version_id === selectedId) ?? pages[0];

  return (
    <div className="space-y-4">
      <header>
        <Link
          to="/prescriptions"
          className="text-sm font-medium text-sky-800 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-sky-300"
        >
          ← Prescription analyzer
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">{result.original_filename}</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          {result.page_count} page{result.page_count === 1 ? '' : 's'}
          {result.analysis_seconds != null ? <> · analysed in {formatDuration(result.analysis_seconds)}</> : null}.
          AI-assisted reading — not a diagnosis and not medical advice.
        </p>
      </header>

      {!active ? (
        <Panel title="No pages">
          <p className="text-sm text-slate-700 dark:text-slate-300">This upload has no readable pages.</p>
        </Panel>
      ) : (
        <>
          {pages.length > 1 ? (
            <nav aria-label="Pages in this document" className="overflow-x-auto">
              <ul className="flex gap-1 pb-2">
                {pages.map((p) => (
                  <li key={p.page_version_id}>
                    <PageThumb
                      pageVersionId={p.page_version_id}
                      ordinal={p.ordinal}
                      selected={p.page_version_id === active.page_version_id}
                      onClick={() => setSelectedId(p.page_version_id)}
                    />
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <section className="flex min-h-[24rem] items-center justify-center rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <PrescriptionPageImage pageVersionId={active.page_version_id} />
            </section>

            <Panel title={pages.length > 1 ? `Page ${active.ordinal}` : 'Result'}>
              <PrescriptionPageDetails page={active} multi={false} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function PrescriptionPageImage({ pageVersionId }: { pageVersionId: string }) {
  const { url, loading, error } = useAuthedObjectUrl(imagePath.preview(pageVersionId));

  if (url) {
    return <img src={url} alt="Prescription page" className="max-h-[75vh] max-w-full rounded-lg object-contain" />;
  }
  if (loading) {
    return <Spinner label="Loading page…" />;
  }
  return <p className="text-sm text-red-800 dark:text-red-300">{error ? 'Image unavailable' : 'No image'}</p>;
}
