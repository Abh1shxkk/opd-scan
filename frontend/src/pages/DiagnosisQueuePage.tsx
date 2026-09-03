/**
 * Diagnosis review queue.
 *
 * Every row makes two things unmissable before the reviewer opens it: whether a human has looked
 * at the extraction yet, and what clinical qualifier the record carried. A "ruled out" entry that
 * reads like a plain diagnosis in a list is a patient-safety problem, not a formatting one.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { diagnosisView, formatConfidence, formatDateTime, qualifierView } from '../lib/status';
import type { DiagnosisExtraction } from '../lib/types';
import { FilterBar } from '../components/FilterBar';
import { StatusPill } from '../components/StatusPill';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { UnreviewedBadge } from '../components/UnreviewedBadge';

export default function DiagnosisQueuePage() {
  const { filters, setFilters, reset, params } = useUrlFilters();
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);

  const queryParams = useMemo(() => {
    const sp = new URLSearchParams(params);
    if (onlyUnreviewed) sp.set('reviewed', 'false');
    return sp;
  }, [params, onlyUnreviewed]);

  const q = useQuery({
    queryKey: ['diagnoses', queryParams.toString()],
    queryFn: () => api.listDiagnoses(queryParams),
  });

  const rows = (q.data?.items ?? []) as DiagnosisExtraction[];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Diagnosis review</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Transcriptions taken from a diagnosis label written on the page. Nothing here is inferred from
          symptoms, medicines or procedures.
        </p>
      </header>

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={reset}
        resultSummary={q.isLoading ? 'Loading…' : `${rows.length} extraction${rows.length === 1 ? '' : 's'} listed.`}
      />

      <label className="flex items-center gap-2 text-sm text-slate-900 dark:text-slate-100">
        <input
          type="checkbox"
          checked={onlyUnreviewed}
          onChange={(e) => setOnlyUnreviewed(e.target.checked)}
          className="h-4 w-4 rounded border-slate-500 text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        />
        Show only extractions that no one has reviewed
      </label>

      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {q.data && rows.length === 0 ? (
        <EmptyState title="No extractions match these filters." />
      ) : null}

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((d) => {
            const conf = formatConfidence(d.confidence);
            return (
              <li
                key={d.id}
                className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {/* Qualifier first: it changes what the text means. */}
                  <StatusPill view={qualifierView(d.qualifier)} />
                  <StatusPill view={diagnosisView(d.status)} size="sm" />
                  {!d.is_reviewed ? <UnreviewedBadge /> : null}
                  {conf ? (
                    <span className="text-xs text-slate-600 dark:text-slate-400">confidence {conf}</span>
                  ) : null}
                </div>

                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                  Label on the page: “{d.anchor_label || 'unlabelled'}” · extracted{' '}
                  {formatDateTime(d.extracted_at)}
                </p>

                {/* The raw transcription is what the model actually read; it is shown, not the tidied
                    version, so a list scan is never one step removed from the source. */}
                <p className="mt-1 font-mono text-sm text-slate-900 dark:text-slate-100">
                  {d.raw_text || <span className="italic text-slate-600 dark:text-slate-400">No text was transcribed.</span>}
                </p>

                {d.ambiguous_abbreviations && d.ambiguous_abbreviations.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                    <span aria-hidden="true">⚠ </span>
                    Left unexpanded: {d.ambiguous_abbreviations.join(', ')}
                  </p>
                ) : null}

                <Link
                  to={`/diagnoses/${d.id}`}
                  className="mt-2 inline-block text-sm font-medium text-sky-800 underline dark:text-sky-300"
                >
                  Review against the page image
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
