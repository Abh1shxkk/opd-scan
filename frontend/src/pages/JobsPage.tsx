/**
 * Background jobs — what is queued, what is running, and what failed.
 *
 * The dashboard has always reported "Jobs failed: N" with a note explaining that a failed job
 * leaves its page unmeasured rather than clean. It offered no way to see which jobs, why they
 * failed, or to do anything about it — the endpoints existed and no screen called them. A count of
 * failures nobody can act on is worse than no count: it tells a reviewer something is wrong and
 * then strands them.
 *
 * Failed is the default view for that reason. It is the only state that needs a human.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, jobView } from '../lib/status';
import type { Job, JobState } from '../lib/types';
import { Panel } from '../components/Sheet';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { Button, ErrorState, Spinner } from '../components/ui';

const STATES: Array<JobState | 'all'> = ['failed', 'queued', 'running', 'succeeded', 'cancelled', 'all'];

/** Stages a page can be re-run through. `ingest` is not one of them — it rebuilds the document. */
const REPROCESSABLE = new Set(['quality', 'handwriting', 'diagnosis', 'prescription']);

export default function JobsPage() {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') as JobState | 'all' | null) ?? 'failed';

  const q = useQuery({
    queryKey: ['jobs', state],
    queryFn: () => api.listJobs(state === 'all' ? {} : { state }),
    // Queued and running work moves on its own; failed does not.
    refetchInterval: state === 'queued' || state === 'running' ? 5000 : false,
  });

  const jobs = useMemo(() => q.data ?? [], [q.data]);

  return (
    <div className="space-y-4">
      <header className="rule-double pb-2">
        <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">
          Background jobs
        </h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Scanning, quality checks and text extraction run in the background. A failed job leaves
          its page unmeasured — not clean — so the page keeps whatever status it already had.
        </p>
      </header>

      <nav aria-label="Filter by state" className="flex flex-wrap gap-1">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setParams(s === 'failed' ? {} : { state: s })}
            aria-current={state === s ? 'true' : undefined}
            className={`border px-2 py-1 text-[13px] transition-colors duration-150 ease-chart ${
              state === s
                ? 'border-chart bg-chart font-semibold text-paper'
                : 'border-rule-2 text-ink hover:bg-chart/[0.07]'
            }`}
          >
            {s}
          </button>
        ))}
      </nav>

      {q.isLoading ? <Spinner label="Loading jobs…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {!q.isLoading && !q.isError ? (
        <Panel title={`${jobs.length} job${jobs.length === 1 ? '' : 's'}`}>
          {jobs.length === 0 ? (
            <p className="text-[13px] text-ink-2">
              {state === 'failed'
                ? 'Nothing has failed. Every job that has run so far finished or is still going.'
                : `No ${state} jobs.`}
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [done, setDone] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const retry = useMutation({
    mutationFn: () => api.reprocessPage(job.page_version_id as string, [job.kind as never]),
    onSuccess: () => {
      setDone('Re-queued.');
      invalidate();
      toast.push('Re-queued. It will pick up on the next worker pass.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not re-queue.', 'error'),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(job.id),
    onSuccess: () => {
      setDone('Cancelled.');
      invalidate();
      toast.push('Job cancelled.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not cancel.', 'error'),
  });

  const canRetry =
    can('uploader') && job.state === 'failed' && !!job.page_version_id && REPROCESSABLE.has(job.kind);
  const canCancel = can('uploader') && (job.state === 'queued' || job.state === 'running');

  return (
    <li className="flex flex-wrap items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{job.kind}</span>
          <StatusPill view={jobView(job.state)} size="sm" />
          {job.attempt > 1 ? (
            <span className="text-[11px] text-ink-2">
              attempt {job.attempt} of {job.max_attempts}
            </span>
          ) : null}
        </div>

        {/* The provider's own message, verbatim. It is what tells an operator whether this is a
            transient timeout worth retrying or a misconfiguration that retrying will not fix. */}
        {job.error ? <p className="mt-1 text-[13px] text-plot">{job.error}</p> : null}

        <p className="mt-1 text-[11px] text-ink-2">
          Queued {formatDateTime(job.queued_at)}
          {job.finished_at ? ` · finished ${formatDateTime(job.finished_at)}` : ''}
        </p>

        {job.page_version_id ? (
          <Link
            to={`/pages/${job.page_version_id}`}
            className="mt-1 inline-block text-[11px] text-chart underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Open the page
          </Link>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {done ? <span className="text-[11px] text-ink-2">{done}</span> : null}
        {canRetry ? (
          <Button variant="primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? 'Re-queuing…' : 'Retry'}
          </Button>
        ) : null}
        {canCancel ? (
          <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        ) : null}
        {/* An ingest failure cannot be retried per-page: ingest is what produces the pages. */}
        {job.state === 'failed' && !canRetry ? (
          <span className="text-[11px] text-ink-2">
            {job.kind === 'ingest' ? 'Re-upload the document' : 'Not retryable'}
          </span>
        ) : null}
      </div>
    </li>
  );
}
