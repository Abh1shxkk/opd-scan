/**
 * Diagnosis review, file by file.
 *
 * Each card leads with what matters — the diagnosis as written — and says only what changes how it
 * should be read: a qualifier that is not a plain final diagnosis ("ruled out", "suspected"), a
 * transcription the machine was not sure of, and abbreviations left unexpanded. A "ruled out"
 * entry that reads like a plain diagnosis in a list is a patient-safety problem, so the qualifier is
 * always shown when there is one.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { diagnosisView, formatConfidence, qualifierView } from '../lib/status';
import type { DiagnosisExtraction, PageRef } from '../lib/types';
import { StatusPill } from '../components/StatusPill';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { Pager, PAGE_SIZE, useClampPage } from '../components/Pager';
import {
  DetailHeader,
  EMPTY_WORK_FILTER,
  FileSplit,
  FilterChip,
  groupByFile,
  QueueHeader,
  toUploadWindow,
  WorkFilters,
  type WorkFilterValue,
} from '../components/WorkFilters';

type Row = DiagnosisExtraction & { page?: PageRef & { document_id?: string; patient_ref?: string | null } };

export default function DiagnosisQueuePage() {
  const [filter, setFilter] = useState<WorkFilterValue>(EMPTY_WORK_FILTER);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  // Most pages carry no diagnosis label at all. Those results are kept (so "nothing written" is
  // distinguishable from "never checked") but they are not work for a reviewer.
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

  const rows = useMemo(() => (q.data?.items ?? []) as Row[], [q.data]);
  const groups = useMemo(
    () =>
      groupByFile(rows, (d) => ({
        documentId: d.page?.document_id ?? 'unknown',
        filename: d.page?.document_filename ?? 'Unknown file',
        patientRef: d.page?.patient_ref ?? null,
      })),
    [rows],
  );
  useClampPage(page, groups.length, setPage);
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <QueueHeader
        title="Diagnosis review"
        subtitle={
          q.data ? (
            <>
              <strong className="font-semibold text-ink">{rows.length}</strong> diagnos
              {rows.length === 1 ? 'is' : 'es'}
              {onlyUnreviewed ? ' to check' : ''} in{' '}
              <strong className="font-semibold text-ink">{groups.length}</strong> file
              {groups.length === 1 ? '' : 's'}. Read from the diagnosis written on the page — never guessed.
            </>
          ) : (
            'Diagnoses read from the diagnosis written on each page.'
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
          active={onlyUnreviewed}
          onClick={() => {
            setOnlyUnreviewed((v) => !v);
            setPage(1);
          }}
        >
          Not reviewed yet
        </FilterChip>
        <FilterChip
          active={showNotFound}
          onClick={() => {
            setShowNotFound((v) => !v);
            setPage(1);
          }}
        >
          Include pages with no diagnosis
        </FilterChip>
      </WorkFilters>

      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {q.data && rows.length === 0 ? (
        <EmptyState title={onlyUnreviewed ? 'All caught up — every diagnosis has been reviewed.' : 'No diagnoses match.'} />
      ) : null}

      {rows.length > 0 ? (
        <>
          <FileSplit
            groups={pageGroups}
            selectedId={selected}
            onSelect={setSelected}
            countLabel={(n) => `${n} diagnos${n === 1 ? 'is' : 'es'}`}
            detail={(g) => (
              <div className="border border-rule bg-paper">
                <DetailHeader
                  title={g.filename}
                  subtitle={`${g.patientRef ? `MR ${g.patientRef} · ` : ''}${g.items.length} diagnos${
                    g.items.length === 1 ? 'is' : 'es'
                  }`}
                />
                <ul className="divide-y divide-rule">
                  {[...g.items]
                    .sort((a, b) => (a.page?.ordinal ?? 0) - (b.page?.ordinal ?? 0))
                    .map((d) => (
                      <DiagnosisRow key={d.id} d={d} />
                    ))}
                </ul>
              </div>
            )}
          />
          <Pager page={page} total={groups.length} count={pageGroups.length} onPage={setPage} />
        </>
      ) : null}
    </div>
  );
}

function DiagnosisRow({ d }: { d: Row }) {
  const conf = formatConfidence(d.confidence);
  const text = d.corrected_text || d.cleaned_text || d.raw_text;
  // Only the signals that change how the text should be read are shown as tags.
  const showQualifier = d.qualifier && d.qualifier !== 'unspecified' && d.qualifier !== 'final';
  const showStatus = d.status !== 'extracted_pending_review';

  return (
    <li>
      <Link
        to={`/diagnoses/${d.id}`}
        className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-paper-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper-3 text-[12px] font-semibold tabular-nums text-ink">
          {d.page ? `P${d.page.ordinal}` : '—'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink">
            {text || <span className="italic text-ink-2">Nothing could be read</span>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2">
            <span>{d.anchor_label ? `Under “${d.anchor_label}”` : 'No label'}</span>
            {conf ? <span>· {conf} sure</span> : null}
            {d.corrected_text ? <span className="font-medium text-chart">· Corrected</span> : null}
            {d.is_reviewed && !d.corrected_text ? <span className="font-medium text-chart">· Reviewed</span> : null}
            {showQualifier ? <StatusPill view={qualifierView(d.qualifier)} size="sm" /> : null}
            {showStatus ? <StatusPill view={diagnosisView(d.status)} size="sm" /> : null}
            {d.ambiguous_abbreviations && d.ambiguous_abbreviations.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-note">
                <TriangleAlert size={12} aria-hidden="true" />
                {d.ambiguous_abbreviations.join(', ')} not expanded
              </span>
            ) : null}
          </span>
        </span>

        <span className="hidden shrink-0 items-center gap-1 text-[13px] font-semibold text-chart sm:inline-flex">
          Review
          <ChevronRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </li>
  );
}
