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
import { Panel } from '../components/Sheet';
import { BandPlot } from '../components/BandPlot';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { Button, DetailRow, ErrorState, Spinner } from '../components/ui';
import { Check, Settings2, TriangleAlert } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <header className="rule-double pb-2">
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Administrator only. Threshold changes affect pages analysed from now on; already-analysed
          pages keep the result they were given, along with the hash of the thresholds used.
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
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'Thresholds could not be saved.', 'error'),
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
                setDraft(
                  Object.fromEntries(
                    Object.entries(q.data.thresholds).map(([k, v]) => [k, String(v)]),
                  ),
                );
                setDirty(false);
              }
            }}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
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
            <fieldset key={family.id} className="border-b border-rule px-3 py-3 last:border-b-0">
              <legend className="px-1 text-[13px] font-semibold text-ink">{family.title}</legend>
              <p className="mb-2 text-[11px] text-ink-2">{family.blurb}</p>
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
          <fieldset className="border-b border-rule px-3 py-3 last:border-b-0">
            <legend className="px-1 text-[13px] font-semibold text-ink">Other</legend>
            <p className="mb-2 text-[11px] text-ink-2">
              Settings this build of the interface does not have a description for. They are still
              editable.
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
        <p aria-live="polite" className="mt-3 text-[13px] text-ink">
          <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
          Unsaved changes.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * A value this deployment did not report.
 *
 * Hatched, like every other unmeasured reading in the application, so it cannot be skimmed as a
 * settled answer.
 */
function NotReported() {
  return (
    <span className="hatch inline-flex items-center border border-rule-2 px-1.5 py-0.5 text-[12px] text-ink-2">
      Not reported by this deployment
    </span>
  );
}

/**
 * One calibrated threshold, plotted against the value it shipped with.
 *
 * This is the signature reading of the application. A threshold is never presented as a bare
 * number: it sits on a band whose midpoint detent is the engine's own default, so an admin can see
 * at a glance whether this deployment has drifted above or below the value the CV engine was
 * calibrated with — which matters because these thresholds retune themselves from reviewer
 * corrections and can move without anybody typing anything.
 *
 * Focusing or hovering the field opens the band in place and reads out what the detent means. The
 * scale is fixed at twice the default, so the detent never moves under the reader while they type.
 */
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
  const current = Number(value);
  const known = defaultValue !== undefined && Number.isFinite(current);
  const changed = known && current !== defaultValue;
  const scaleMax = defaultValue !== undefined && defaultValue > 0 ? defaultValue * 2 : 1;
  const overScale = known && current > scaleMax;

  // Expressed against the default rather than as a raw difference: "18% above default" is the
  // question an admin is actually asking of a retuned threshold.
  const drift =
    changed && defaultValue !== undefined && defaultValue !== 0
      ? Math.round(((current - defaultValue) / defaultValue) * 100)
      : 0;

  return (
    <div className="group">
      <label htmlFor={id} className="mb-1 block font-mono text-[11px] text-ink">
        {name}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-rule-2 bg-paper px-2 py-1.5 text-[13px] tabular-nums text-ink"
      />

      {defaultValue !== undefined ? (
        <>
          <BandPlot
            className="mt-1"
            value={known ? Math.min(current, scaleMax) : null}
            max={scaleMax}
            tone={changed ? 'warn' : 'plain'}
            unmeasured={!known}
            height="h-1.5"
            detents={[{ at: defaultValue, kind: 'reference', label: `Default ${defaultValue}` }]}
          />
          <p className="mt-1 text-[11px] leading-snug text-ink-2">
            Default {defaultValue}
            {changed ? (
              <span className="ml-1 font-medium text-note">
                · {drift > 0 ? '+' : ''}
                {drift}%
              </span>
            ) : null}
          </p>
          {/* The band opens on hover or focus rather than spending a line on every field. */}
          <p className="hidden text-[11px] leading-snug text-ink-2 group-focus-within:block group-hover:block">
            The mark on the band is the engine default ({defaultValue}); the scale runs 0 to{' '}
            {Number(scaleMax.toPrecision(4))}.
            {overScale ? ' This value is above the top of the scale.' : ''}
            {changed ? '' : ' This threshold is at its default.'}
          </p>
        </>
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
  const limits = wrapped.limits;

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
                cap.status === 'ready' ? 'border-rule ' : 'border-note/50 bg-note/[0.07] '
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{capabilityLabel(key)}</span>
                <StatusPill
                  view={
                    cap.status === 'ready'
                      ? { label: 'Ready', tone: 'ok', icon: Check }
                      : { label: 'Not configured', tone: 'warn', icon: Settings2, unmeasured: true }
                  }
                  size="sm"
                />
                {cap.provider ? (
                  <span className="text-[11px] text-ink-2">provider: {cap.provider}</span>
                ) : null}
              </div>
              {cap.setup_required ? (
                <div className="mt-2 rounded bg-paper-2 p-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink">
                    Setup required
                  </p>
                  {/* Verbatim from the backend — an instruction naming an env var must not be paraphrased. */}
                  <p className="mt-0.5 text-[13px] text-ink">{cap.setup_required}</p>
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
          {/*
            A retention period of 0 is "none configured", not "keep forever" — stating the latter
            would invent a policy about patient records that nobody set.
          */}
          <DetailRow term="Original files">
            {retention === undefined ? (
              <NotReported />
            ) : retention.originals_days > 0 ? (
              `Deleted ${retention.originals_days} days after upload`
            ) : (
              <span className="text-ink-2">No retention period configured</span>
            )}
          </DetailRow>

          {/*
            Deliberately not presented as an enforced policy. `derivatives_days` is stored and
            returned, but no code path in this system reads it: renders, previews, thumbnails and
            extracted text are kept until someone deletes them by hand. Printing "deleted after N
            days" here would be a false claim about patient data.
          */}
          <DetailRow term="Derived renders">
            {retention === undefined ? (
              <NotReported />
            ) : (
              <>
                {retention.derivatives_days > 0
                  ? `Set to ${retention.derivatives_days} days`
                  : 'No retention period configured'}
                <span className="mt-1 block text-[11px] leading-snug text-note">
                  Not enforced. Nothing in this system deletes renders, previews, thumbnails or
                  extracted text — they are kept until removed by hand.
                </span>
              </>
            )}
          </DetailRow>

          <DetailRow term="Audit records">
            {retention === undefined ? (
              <NotReported />
            ) : retention.audit_days > 0 ? (
              `Deleted ${retention.audit_days} days after the event`
            ) : (
              <span className="text-ink-2">Kept indefinitely — nothing deletes audit rows</span>
            )}
          </DetailRow>

          {limits?.max_upload_mb ? (
            <DetailRow term="Upload size limit">{limits.max_upload_mb} MB per file</DetailRow>
          ) : null}
          {limits?.max_pages_per_document ? (
            <DetailRow term="Page limit">{limits.max_pages_per_document} pages per document</DetailRow>
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
