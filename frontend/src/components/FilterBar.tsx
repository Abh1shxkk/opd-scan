/**
 * The shared filter form.
 *
 * The same component drives the document list, the review queue, the diagnosis queue and the
 * reports screen, because docs/API.md requires exports to accept the identical query string and
 * produce identical totals. One form, one `Filters` object, one serialiser (`lib/filters.ts`).
 *
 * Note what is *not* here: there is no "has handwriting" option inside the defect filter. Handwriting
 * is a separate axis with its own control, because it is not a scan-quality defect.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DEFECT_CODES, DEFECT_LABELS } from '../lib/defects';
import { countActive, describeFilters, toggleMulti, type Filters } from '../lib/filters';
import {
  DIAGNOSIS_ORDER,
  diagnosisView,
  HANDWRITING_ORDER,
  handwritingView,
  PAGE_CLASS_ORDER,
  pageClassView,
  REVIEW_STATES,
  reviewStateView,
} from '../lib/status';
import type { DiagnosisStatus, HandwritingStatus, PageClass, ReviewState } from '../lib/types';
import { Button, CheckboxGroup, Select, TextInput } from './ui';

export function FilterBar({
  value,
  onChange,
  onReset,
  resultSummary,
}: {
  value: Filters;
  onChange: (next: Filters) => void;
  onReset?: () => void;
  /** e.g. "128 pages match" — announced politely so filter changes are heard, not just seen. */
  resultSummary?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = countActive(value);

  // Text inputs are debounced locally so typing a patient reference does not fire a request per
  // keystroke (and does not rewrite the URL per keystroke either).
  const [q, setQ] = useState(value.q);
  const [patient, setPatient] = useState(value.patient_ref);
  const [encounter, setEncounter] = useState(value.encounter_ref);

  useEffect(() => setQ(value.q), [value.q]);
  useEffect(() => setPatient(value.patient_ref), [value.patient_ref]);
  useEffect(() => setEncounter(value.encounter_ref), [value.encounter_ref]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (q !== value.q || patient !== value.patient_ref || encounter !== value.encounter_ref) {
        onChange({ ...value, q, patient_ref: patient, encounter_ref: encounter });
      }
    }, 350);
    return () => window.clearTimeout(id);
    // `value`/`onChange` are intentionally omitted: this effect exists only to flush local text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, patient, encounter]);

  const batches = useQuery({
    queryKey: ['batches'],
    queryFn: () => api.listBatches(),
    staleTime: 60_000,
  });

  return (
    <section
      aria-label="Filters"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput
          label="Search"
          placeholder="Filename, reference, comment…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select
          label="Batch"
          value={value.batch_id}
          onChange={(e) => onChange({ ...value, batch_id: e.target.value })}
        >
          <option value="">All batches</option>
          {(batches.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <TextInput
          label="Patient reference"
          placeholder="e.g. IP140922101"
          value={patient}
          onChange={(e) => setPatient(e.target.value)}
        />
        <TextInput
          label="Encounter reference"
          value={encounter}
          onChange={(e) => setEncounter(e.target.value)}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput
          label="Uploaded from"
          type="date"
          value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
        <TextInput
          label="Uploaded to"
          type="date"
          value={value.to}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
        <Select
          label="Review state"
          value={value.review_state}
          onChange={(e) => onChange({ ...value, review_state: e.target.value as ReviewState | '' })}
        >
          <option value="">Any review state</option>
          {REVIEW_STATES.map((s) => (
            <option key={s} value={s}>
              {reviewStateView(s).label}
            </option>
          ))}
        </Select>
        <div className="flex items-end gap-2">
          <Button
            variant="secondary"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="filter-advanced"
          >
            {expanded ? 'Hide' : 'Show'} status filters
            {active > 0 ? (
              <span className="ml-1 rounded-full bg-sky-700 px-1.5 text-xs text-white dark:bg-sky-600">
                {active}
              </span>
            ) : null}
          </Button>
          {onReset ? (
            <Button variant="ghost" onClick={onReset} disabled={active === 0}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <div id="filter-advanced" hidden={!expanded} className="mt-4 grid gap-5 border-t border-slate-200 pt-4 dark:border-slate-800 lg:grid-cols-4">
        <CheckboxGroup<PageClass>
          legend="Page class"
          options={PAGE_CLASS_ORDER.map((c) => ({ value: c, label: pageClassView(c).label }))}
          selected={value.page_class}
          onToggle={(v) => onChange(toggleMulti(value, 'page_class', v))}
        />
        <CheckboxGroup<HandwritingStatus>
          legend="Handwriting"
          options={HANDWRITING_ORDER.map((s) => ({ value: s, label: handwritingView(s).label }))}
          selected={value.handwriting}
          onToggle={(v) => onChange(toggleMulti(value, 'handwriting', v))}
        />
        <CheckboxGroup<DiagnosisStatus>
          legend="Diagnosis status"
          options={DIAGNOSIS_ORDER.map((s) => ({ value: s, label: diagnosisView(s).label }))}
          selected={value.diagnosis_status}
          onToggle={(v) => onChange(toggleMulti(value, 'diagnosis_status', v))}
        />
        <CheckboxGroup
          legend="Scan defect"
          options={DEFECT_CODES.map((c) => ({ value: c, label: DEFECT_LABELS[c] }))}
          selected={value.defect_code}
          onToggle={(v) => onChange(toggleMulti(value, 'defect_code', v))}
        />
      </div>

      {resultSummary ? (
        <p aria-live="polite" className="mt-3 text-sm text-slate-700 dark:text-slate-300">
          {resultSummary}
        </p>
      ) : null}
    </section>
  );
}

/** A compact read-only restatement of the filters, used beside export buttons. */
export function FilterSummary({ value }: { value: Filters }) {
  const parts = describeFilters(value);
  if (parts.length === 0) {
    return (
      <p className="text-sm text-slate-700 dark:text-slate-300">
        No filters set — this covers every active page version you are permitted to see.
      </p>
    );
  }
  return (
    <p className="text-sm text-slate-700 dark:text-slate-300">
      Filtered by: <span className="font-medium text-slate-900 dark:text-slate-100">{parts.join(' · ')}</span>
    </p>
  );
}
