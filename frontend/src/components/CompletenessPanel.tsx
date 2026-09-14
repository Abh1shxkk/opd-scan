/**
 * Case completeness.
 *
 * `not_verified` is the default state and is what a case with no checklist attached always shows.
 * It is rendered with the exact wording "Completeness not verified" — never "Incomplete", never a
 * tick, never silence. Those would all claim something the system does not know: with no checklist
 * there is nothing to check the record against, which is different from checking it and finding
 * pages missing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { completenessView, formatDateTime } from '../lib/status';
import { Panel } from './Sheet';
import { StatusPill } from './StatusPill';
import { useToast } from './Toast';
import { Button, ErrorState, Spinner } from './ui';

export function CompletenessPanel({ caseId }: { caseId: string }) {
  const q = useQuery({
    queryKey: ['completeness', caseId],
    queryFn: () => api.getCompleteness(caseId),
    enabled: Boolean(caseId),
  });

  if (q.isLoading) return <Spinner label="Checking completeness…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  // A missing payload is treated exactly like an explicit not_verified: nothing was assessed.
  const status = q.data?.status ?? 'not_verified';
  const view = completenessView(status);
  const findings = (q.data?.findings ?? {}) as Record<string, unknown>;
  const findingEntries = Object.entries(findings).filter(([, v]) => v !== null && v !== undefined);

  return (
    <Panel
      title="Completeness"
      description="Whether the record contains the documents a checklist says it should."
    >
      <StatusPill view={view} showDetail />

      {status === 'not_verified' ? (
        <p className="mt-2 text-[13px] text-ink-2">
          Attach a checklist to this case to have its completeness assessed. Until then nothing is
          claimed about whether pages are missing.
        </p>
      ) : null}

      {q.data?.checklist_name ? (
        <p className="mt-2 text-[11px] text-ink-2">
          Checklist: {q.data.checklist_name}
          {q.data.computed_at ? ` · computed ${formatDateTime(q.data.computed_at)}` : ''}
        </p>
      ) : null}

      {status !== 'not_verified' && findingEntries.length > 0 ? (
        <dl className="mt-3 space-y-1 text-[13px]">
          {findingEntries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[12rem_1fr] gap-2">
              <dt className="text-ink-2">{key.replace(/_/g, ' ')}</dt>
              <dd className="text-ink">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <ChecklistPicker caseId={caseId} current={q.data?.checklist_id ?? null} />
    </Panel>
  );
}

/**
 * Attach or change the checklist this case is measured against.
 *
 * This control is the reason the completeness feature was unreachable: a case could only ever be
 * given a checklist at creation, and nothing in the product passed one, so every case in existence
 * had none and every panel reported "not verified" forever.
 *
 * Recompute is offered separately because attaching a checklist assesses the record as it stands
 * now — pages added afterwards do not re-trigger it.
 */
function ChecklistPicker({ caseId, current }: { caseId: string; current: string | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const lists = useQuery({
    queryKey: ['checklists'],
    queryFn: () => api.listChecklists(),
    enabled: can('uploader'),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['completeness', caseId] });
    queryClient.invalidateQueries({ queryKey: ['case', caseId] });
  };

  const attach = useMutation({
    mutationFn: (checklistId: string | null) => api.updateCase(caseId, { checklist_id: checklistId }),
    onSuccess: async (_data, checklistId) => {
      if (checklistId) await api.recomputeCompleteness(caseId).catch(() => undefined);
      invalidate();
      toast.push(checklistId ? 'Checklist attached and assessed.' : 'Checklist detached.', 'success');
    },
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'Could not change the checklist.', 'error'),
  });

  const recompute = useMutation({
    mutationFn: () => api.recomputeCompleteness(caseId),
    onSuccess: () => {
      invalidate();
      toast.push('Completeness reassessed.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not reassess.', 'error'),
  });

  if (!can('uploader')) return null;

  const options = (lists.data ?? []).filter((c) => c.is_active || c.id === current);
  const busy = attach.isPending || recompute.isPending;

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-rule pt-3">
      <label className="min-w-[12rem] flex-1">
        <span className="text-[11px] text-ink-2">Measured against</span>
        <select
          value={current ?? ''}
          disabled={busy || lists.isLoading}
          onChange={(e) => attach.mutate(e.target.value || null)}
          className="mt-1 w-full border border-rule-2 bg-paper px-2 py-1 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <option value="">No checklist</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {current ? (
        <Button variant="secondary" disabled={busy} onClick={() => recompute.mutate()}>
          {recompute.isPending ? 'Reassessing…' : 'Reassess'}
        </Button>
      ) : null}

      {options.length === 0 && !lists.isLoading ? (
        <p className="w-full text-[11px] text-ink-2">
          No checklists exist yet. An administrator can create one in Settings.
        </p>
      ) : null}
    </div>
  );
}
