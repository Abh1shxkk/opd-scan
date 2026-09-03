/**
 * Case completeness.
 *
 * `not_verified` is the default state and is what a case with no checklist attached always shows.
 * It is rendered with the exact wording "Completeness not verified" — never "Incomplete", never a
 * tick, never silence. Those would all claim something the system does not know: with no checklist
 * there is nothing to check the record against, which is different from checking it and finding
 * pages missing.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { completenessView, formatDateTime } from '../lib/status';
import { Panel } from './StatTile';
import { StatusPill } from './StatusPill';
import { ErrorState, Spinner } from './ui';

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
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          Attach a checklist to this case to have its completeness assessed. Until then nothing is
          claimed about whether pages are missing.
        </p>
      ) : null}

      {q.data?.checklist_name ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          Checklist: {q.data.checklist_name}
          {q.data.computed_at ? ` · computed ${formatDateTime(q.data.computed_at)}` : ''}
        </p>
      ) : null}

      {status !== 'not_verified' && findingEntries.length > 0 ? (
        <dl className="mt-3 space-y-1 text-sm">
          {findingEntries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[12rem_1fr] gap-2">
              <dt className="text-slate-600 dark:text-slate-400">{key.replace(/_/g, ' ')}</dt>
              <dd className="text-slate-900 dark:text-slate-100">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Panel>
  );
}
