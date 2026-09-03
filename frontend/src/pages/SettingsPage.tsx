/**
 * Settings — administrator only.
 *
 * Quality thresholds are grouped by defect family (see `lib/defects.ts`) with the blurb explaining
 * what each family actually measures, because the numbers are meaningless without it: an operator
 * who lowers `sharpness_min` because "blur sounds bad" will flood the rescan queue.
 *
 * The capability panel repeats the backend's own `setup_required` text verbatim rather than
 * paraphrasing it — the instruction to set an environment variable has to be exact.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DEFECT_FAMILIES } from '../lib/defects';
import { capabilityLabel } from '../lib/status';
import type { Capability, CapabilitiesResponse, CapabilityMap } from '../lib/types';
import { Panel } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { Button, DetailRow, ErrorState, Spinner } from '../components/ui';

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Settings</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Administrator only. Threshold changes affect pages analysed from now on; already-analysed pages
          keep the result they were given, along with the hash of the thresholds used.
        </p>
      </header>

      <ThresholdsEditor />
      <CapabilitiesPanel />
    </div>
  );
}

// ------------------------------------------------------------- thresholds

function ThresholdsEditor() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const q = useQuery({ queryKey: ['thresholds'], queryFn: () => api.getThresholds() });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  // Values are held as strings while editing so a half-typed "0." does not become NaN.
  useEffect(() => {
    if (!q.data?.thresholds) return;
    setDraft(Object.fromEntries(Object.entries(q.data.thresholds).map(([k, v]) => [k, String(v)])));
    setDirty(false);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const numeric: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) {
        const n = Number(v);
        if (!Number.isNaN(n)) numeric[k] = n;
      }
      return api.putThresholds(numeric);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['thresholds'] });
      setDirty(false);
      toast.push('Thresholds saved.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Thresholds could not be saved.', 'error'),
  });

  if (q.isLoading) return <Spinner label="Loading thresholds…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const defaults = q.data?.defaults ?? {};
  // Keys the backend sent that are not in any known family still have to be editable.
  const known = new Set(DEFECT_FAMILIES.flatMap((f) => f.keys));
  const extras = Object.keys(draft).filter((k) => !known.has(k));

  function set(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  return (
    <Panel
      title="Quality thresholds"
      description="What the local OpenCV analyser treats as a defect. Every value can be retuned without touching the image-processing code."
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!dirty}
            onClick={() => {
              if (q.data?.thresholds) {
                setDraft(Object.fromEntries(Object.entries(q.data.thresholds).map(([k, v]) => [k, String(v)])));
                setDirty(false);
              }
            }}
          >
            Discard changes
          </Button>
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save thresholds'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {DEFECT_FAMILIES.map((family) => {
          const keys = family.keys.filter((k) => k in draft);
          if (keys.length === 0) return null;
          return (
            <fieldset key={family.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <legend className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                {family.title}
              </legend>
              <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">{family.blurb}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {keys.map((key) => (
                  <ThresholdField
                    key={key}
                    name={key}
                    value={draft[key] ?? ''}
                    defaultValue={defaults[key]}
                    onChange={(v) => set(key, v)}
                  />
                ))}
              </div>
            </fieldset>
          );
        })}

        {extras.length > 0 ? (
          <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-50">Other</legend>
            <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">
              Settings this build of the interface does not have a description for. They are still editable.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {extras.map((key) => (
                <ThresholdField
                  key={key}
                  name={key}
                  value={draft[key] ?? ''}
                  defaultValue={defaults[key]}
                  onChange={(v) => set(key, v)}
                />
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>

      {dirty ? (
        <p aria-live="polite" className="mt-3 text-sm text-amber-900 dark:text-amber-200">
          <span aria-hidden="true">⚠ </span>
          Unsaved changes.
        </p>
      ) : null}
    </Panel>
  );
}

function ThresholdField({
  name,
  value,
  defaultValue,
  onChange,
}: {
  name: string;
  value: string;
  defaultValue?: number;
  onChange: (v: string) => void;
}) {
  const id = `threshold-${name}`;
  const changed = defaultValue !== undefined && Number(value) !== defaultValue;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono text-xs text-slate-800 dark:text-slate-200">
        {name}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm tabular-nums text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-50"
      />
      {defaultValue !== undefined ? (
        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
          Default {defaultValue}
          {changed ? <span className="ml-1 font-medium text-amber-800 dark:text-amber-300">· changed</span> : null}
        </p>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------- capabilities

function CapabilitiesPanel() {
  const q = useQuery({ queryKey: ['capabilities'], queryFn: () => api.getCapabilities() });

  if (q.isLoading) return <Spinner label="Loading provider status…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return null;

  // The endpoint may return the map directly or wrapped with retention info; handle both.
  const wrapped = q.data as CapabilitiesResponse;
  const caps: CapabilityMap = (wrapped.capabilities ?? (q.data as CapabilityMap)) as CapabilityMap;
  const retention = wrapped.retention;

  const entries = Object.entries(caps).filter(
    ([, v]) => v && typeof v === 'object' && 'status' in (v as object),
  ) as Array<[string, Capability]>;

  return (
    <>
      <Panel
        title="Provider capabilities"
        description="An unconfigured capability withholds its result. It never reports a page as clean, and never as “no handwriting”."
      >
        <ul className="space-y-2">
          {entries.map(([key, cap]) => (
            <li
              key={key}
              className={`rounded border p-3 ${
                cap.status === 'ready'
                  ? 'border-slate-200 dark:border-slate-800'
                  : 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {capabilityLabel(key)}
                </span>
                <StatusPill
                  view={
                    cap.status === 'ready'
                      ? { label: 'Ready', tone: 'ok', icon: '✓' }
                      : { label: 'Not configured', tone: 'warn', icon: '⚙' }
                  }
                  size="sm"
                />
                {cap.provider ? (
                  <span className="text-xs text-slate-600 dark:text-slate-400">provider: {cap.provider}</span>
                ) : null}
              </div>
              {cap.setup_required ? (
                <div className="mt-2 rounded bg-white/70 p-2 dark:bg-slate-900/70">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                    Setup required
                  </p>
                  {/* Verbatim from the backend — an instruction naming an env var must not be paraphrased. */}
                  <p className="mt-0.5 text-sm text-slate-900 dark:text-slate-100">{cap.setup_required}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Retention"
        description="Originals are written once at ingest and are never modified. Enhancement, annotation and rescan all create new records."
      >
        <dl>
          <DetailRow term="Original files">
            {retention?.retention_days_originals
              ? `Deleted ${retention.retention_days_originals} days after upload`
              : 'Kept indefinitely (no retention period configured)'}
          </DetailRow>
          <DetailRow term="Derived renders">
            {retention?.retention_days_derivatives
              ? `Deleted ${retention.retention_days_derivatives} days after creation`
              : 'Kept indefinitely (no retention period configured)'}
          </DetailRow>
          {retention?.max_upload_mb ? (
            <DetailRow term="Upload size limit">{retention.max_upload_mb} MB per file</DetailRow>
          ) : null}
          {retention?.max_pages_per_document ? (
            <DetailRow term="Page limit">{retention.max_pages_per_document} pages per document</DetailRow>
          ) : null}
          <DetailRow term="Audit">
            Access, changes and review decisions are recorded in an append-only audit log that never
            contains patient text.
          </DetailRow>
        </dl>
      </Panel>
    </>
  );
}
