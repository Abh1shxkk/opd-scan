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
import type { DiagnosisExtraction, PageRef } from '../lib/types';
import { StatusPill } from '../components/StatusPill';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { Pager, PAGE_SIZE } from '../components/Pager';
import { UnreviewedBadge } from '../components/UnreviewedBadge';
import {
  EMPTY_WORK_FILTER,
  FileSplit,
  groupByFile,
  toUploadWindow,
  WorkFilters,
  type WorkFilterValue,
} from '../components/WorkFilters';
import { TriangleAlert } from 'lucide-react';

type Row = DiagnosisExtraction & { page?: PageRef & { document_id?: string; patient_ref?: string | null } };

export default function DiagnosisQueuePage() {
  const [filter, setFilter] = useState<WorkFilterValue>(EMPTY_WORK_FILTER);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  // Most pages carry no diagnosis label at all. Those results are kept (so "nothing written" is
  // distinguishable from "never checked") but they are not work, and listing them buried the real
  // diagnoses under dozens of "No diagnosis found" cards that looked like the feature was broken.
  const [showNotFound, setShowNotFound] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const queryParams = useMemo(() => {
    const sp = new URLSearchParams({ limit: '1000' });
    if (onlyUnreviewed) sp.set('reviewed', 'false');
    if (!showNotFound) sp.set('hide_not_found', 'true');
    if (filter.search.trim()) sp.set('q', filter.search.trim());
    const w = toUploadWindow(filter);
    if (w.from) sp.set('from', w.from);
    if (w.to) sp.set('to', w.to);
    return sp;
  }, [filter, onlyUnreviewed, showNotFound]);

  const q = useQuery({
    queryKey: ['diagnoses', queryParams.toString()],
    queryFn: () => api.listDiagnoses(queryParams),
  });

  const rows = (q.data?.items ?? []) as Row[];
  const groups = useMemo(
    () =>
      groupByFile(rows, (d) => ({
        documentId: d.page?.document_id ?? 'unknown',
        filename: d.page?.document_filename ?? 'Unknown file',
        patientRef: d.page?.patient_ref ?? null,
      })),
    [rows],
  );
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const resetPage = () => setPage(1);

  return (
    <div className="space-y-4">
      <header className="rule-double pb-2">
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">Diagnosis review</h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Diagnoses transcribed from a diagnosis label written on the page, file by file. Nothing here
          is inferred from symptoms, medicines or procedures.
        </p>
      </header>

      <WorkFilters
        value={filter}
        onChange={(next) => {
          setFilter(next);
          resetPage();
        }}
        searchLabel="File name, MR or IPD"
      >
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={onlyUnreviewed}
            onChange={(e) => {
              setOnlyUnreviewed(e.target.checked);
              resetPage();
            }}
            className="h-4 w-4 rounded border-rule-2 text-chart"
          />
          Only not yet reviewed
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={showNotFound}
            onChange={(e) => {
              setShowNotFound(e.target.checked);
              resetPage();
            }}
            className="h-4 w-4 rounded border-rule-2 text-chart"
          />
          Also show pages where no diagnosis was written
        </label>
      </WorkFilters>

      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {q.data && rows.length === 0 ? (
        <EmptyState title="No diagnoses match these filters.">
          {onlyUnreviewed ? 'Every diagnosis found in this view has been reviewed.' : null}
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <>
          <p className="text-[13px] text-ink-2">
            <span className="font-semibold text-ink">{rows.length}</span> diagnos
            {rows.length === 1 ? 'is' : 'es'} across{' '}
            <span className="font-semibold text-ink">{groups.length}</span> file
            {groups.length === 1 ? '' : 's'}.
          </p>
          <Pager page={page} total={groups.length} count={pageGroups.length} onPage={setPage} />
          <FileSplit
            groups={pageGroups}
            selectedId={selected}
            onSelect={setSelected}
            countLabel={(n) => `${n} diagnos${n === 1 ? 'is' : 'es'}`}
            detail={(g) => (
              <ul className="space-y-2">
                {g.items.map((d) => {
                  const conf = formatConfidence(d.confidence);
                  return (
              <li
                    key={d.id}
                    className="sheet p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Qualifier first: it changes what the text means. */}
                      <StatusPill view={qualifierView(d.qualifier)} />
                      <StatusPill view={diagnosisView(d.status)} size="sm" />
                      {!d.is_reviewed ? <UnreviewedBadge /> : null}
                      {conf ? (
                        <span className="text-[11px] text-ink-2">confidence {conf}</span>
                      ) : null}
                    </div>

                    <p className="mt-2 text-[11px] text-ink-2">
                  {d.page ? `Page ${d.page.ordinal} · ` : ''}
                      Label on the page: “{d.anchor_label || 'unlabelled'}” · extracted{' '}
                      {formatDateTime(d.extracted_at)}
                    </p>

                    {/* The raw transcription is what the model actually read; it is shown, not the tidied
                        version, so a list scan is never one step removed from the source. Once a
                        reviewer has corrected it, though, the correction is what the record says — and
                        a queue that kept showing the superseded reading would send the next person to
                        re-do work that is already done. Both are shown, correction first. */}
                    {d.corrected_text ? (
                      <>
                        <p className="mt-1 font-mono text-[13px] text-ink">{d.corrected_text}</p>
                        <p className="mt-0.5 text-[11px] text-ink-2">
                          Corrected{d.corrected_by_name ? ` by ${d.corrected_by_name}` : ''} · as read:{' '}
                          <span className="font-mono line-through">{d.raw_text || '—'}</span>
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 font-mono text-[13px] text-ink">
                        {d.raw_text || <span className="italic text-ink-2">No text was transcribed.</span>}
                      </p>
                    )}

                    {d.ambiguous_abbreviations && d.ambiguous_abbreviations.length > 0 ? (
                      <p className="mt-1 text-[11px] text-ink">
                        <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
                        Left unexpanded: {d.ambiguous_abbreviations.join(', ')}
                      </p>
                    ) : null}

                    <Link
                      to={`/diagnoses/${d.id}`}
                      className="mt-2 inline-block text-[13px] font-medium text-chart underline"
                    >
                      Review against the page image
                    </Link>
                  </li>
                  );
                })}
              </ul>
            )}
          />
        </>
      ) : null}
    </div>
  );
}
