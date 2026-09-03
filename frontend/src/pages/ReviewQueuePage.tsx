/**
 * Review queue.
 *
 * Built for the keyboard first: a reviewer works through hundreds of pages and should never have
 * to move a hand to the mouse. The listbox owns focus, arrow keys / J / K move the selection,
 * A accepts, R requests a rescan and Enter opens the full viewer. Every action and every selection
 * change is announced through an aria-live region, because the visual cue alone is useless to a
 * screen-reader user moving quickly through a queue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, imagePath } from '../lib/api';
import { defectLabel } from '../lib/defects';
import {
  diagnosisView,
  handwritingView,
  pageClassView,
  reviewStateView,
} from '../lib/status';
import type { PageSummary } from '../lib/types';
import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { FilterBar } from '../components/FilterBar';
import { Modal } from '../components/Modal';
import { Panel } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { Button, EmptyState, ErrorState, Spinner, TextArea } from '../components/ui';

export default function ReviewQueuePage() {
  const { filters, setFilters, reset, params } = useUrlFilters();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  // The queue defaults to pages nobody has actioned yet; the filter bar can widen it.
  const queueParams = useMemo(() => {
    const sp = new URLSearchParams(params);
    if (!sp.has('review_state')) sp.set('review_state', 'pending');
    return sp;
  }, [params]);

  const q = useQuery({
    queryKey: ['review-queue', queueParams.toString()],
    queryFn: () => api.listPages(queueParams),
  });

  const rows = q.data?.items ?? [];
  const [index, setIndex] = useState(0);
  const [rescanFor, setRescanFor] = useState<PageSummary | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the selection in range when the queue shrinks after an action.
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);

  const current = rows[index];

  const review = useMutation({
    mutationFn: (vars: { id: string; action: 'accept' | 'request_rescan'; comment?: string }) =>
      api.reviewPage(vars.id, { action: vars.action, comment: vars.comment }),
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      const msg = vars.action === 'accept' ? 'Page accepted.' : 'Rescan requested.';
      setAnnouncement(`${msg} Moving to the next page in the queue.`);
      toast.push(msg, 'success');
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : 'The action could not be saved.';
      setAnnouncement(`Action failed. ${msg}`);
      toast.push(msg, 'error');
    },
  });

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(Math.max(i + delta, 0), Math.max(rows.length - 1, 0));
        const row = rows[next];
        if (row) {
          setAnnouncement(
            `Page ${row.ordinal} of ${row.document_filename}. ${pageClassView(row.page_class).label}. ${
              handwritingView(row.handwriting_status).label
            }. Item ${next + 1} of ${rows.length}.`,
          );
        }
        return next;
      });
    },
    [rows],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let the browser handle typing inside the filter inputs.
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          move(-1);
          break;
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(Math.max(0, rows.length - 1));
          break;
        case 'a':
        case 'A':
          if (current) {
            e.preventDefault();
            review.mutate({ id: current.page_version_id, action: 'accept' });
          }
          break;
        case 'r':
        case 'R':
          if (current) {
            e.preventDefault();
            setRescanFor(current);
          }
          break;
        case 'Enter':
          if (current) {
            e.preventDefault();
            navigate(`/pages/${current.page_version_id}`);
          }
          break;
        case '?':
          e.preventDefault();
          setHelpOpen(true);
          break;
        default:
          break;
      }
    },
    [current, move, navigate, review, rows.length],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Review queue</h1>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            Pages waiting for a decision. Use the keyboard:{' '}
            <kbd className="rounded border px-1">J</kbd>/<kbd className="rounded border px-1">K</kbd> to move,{' '}
            <kbd className="rounded border px-1">A</kbd> to accept,{' '}
            <kbd className="rounded border px-1">R</kbd> to request a rescan,{' '}
            <kbd className="rounded border px-1">Enter</kbd> to open.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setHelpOpen(true)}>
          Keyboard shortcuts
        </Button>
      </header>

      <FilterBar
        value={filters}
        onChange={setFilters}
        onReset={reset}
        resultSummary={q.isLoading ? 'Loading…' : `${rows.length} page${rows.length === 1 ? '' : 's'} in the queue.`}
      />

      {/* One live region for the whole screen: selection changes and action results both land here. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {q.isLoading ? <Spinner label="Loading the queue…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      {q.data && rows.length === 0 ? (
        <EmptyState title="Nothing is waiting for review.">
          Every page matching these filters has been accepted or sent for rescan.
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Pages awaiting review"
            aria-activedescendant={current ? `queue-item-${current.page_version_id}` : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="max-h-[70vh] space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:border-slate-800 dark:bg-slate-900"
          >
            {rows.map((p, i) => (
              <li
                key={p.page_version_id}
                id={`queue-item-${p.page_version_id}`}
                role="option"
                aria-selected={i === index}
                onClick={() => setIndex(i)}
                className={`cursor-pointer rounded p-2 ${
                  i === index
                    ? 'bg-sky-100 ring-2 ring-sky-600 dark:bg-sky-950 dark:ring-sky-400'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Page {p.ordinal}
                    {p.printed_page_label ? ` ${p.printed_page_label}` : ''}
                  </span>
                  <span className="truncate text-xs text-slate-600 dark:text-slate-400" title={p.document_filename}>
                    {p.document_filename}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusPill view={pageClassView(p.page_class)} size="sm" />
                  <StatusPill view={handwritingView(p.handwriting_status)} size="sm" />
                  <StatusPill view={reviewStateView(p.review_state)} size="sm" />
                </div>
              </li>
            ))}
          </ul>

          {current ? (
            <QueueDetail
              page={current}
              busy={review.isPending}
              onAccept={() => review.mutate({ id: current.page_version_id, action: 'accept' })}
              onRescan={() => setRescanFor(current)}
            />
          ) : null}
        </div>
      ) : null}

      <RescanDialog
        page={rescanFor}
        onClose={() => setRescanFor(null)}
        onSubmit={(comment) => {
          if (rescanFor) review.mutate({ id: rescanFor.page_version_id, action: 'request_rescan', comment });
          setRescanFor(null);
        }}
      />

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="sm">
        <dl className="space-y-1 text-sm">
          {[
            ['J or ↓', 'Next page in the queue'],
            ['K or ↑', 'Previous page'],
            ['Home / End', 'First / last page'],
            ['A', 'Accept the selected page'],
            ['R', 'Request a rescan (asks for a reason)'],
            ['Enter', 'Open the selected page in the full viewer'],
            ['?', 'Show this list'],
          ].map(([key, meaning]) => (
            <div key={key} className="grid grid-cols-[7rem_1fr] gap-2">
              <dt>
                <kbd className="rounded border border-slate-400 px-1.5 py-0.5 text-xs dark:border-slate-600">
                  {key}
                </kbd>
              </dt>
              <dd className="text-slate-800 dark:text-slate-200">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
          Shortcuts apply while the queue list has focus. Click the list, or Tab to it, to use them.
        </p>
      </Modal>
    </div>
  );
}

function QueueDetail({
  page,
  busy,
  onAccept,
  onRescan,
}: {
  page: PageSummary;
  busy: boolean;
  onAccept: () => void;
  onRescan: () => void;
}) {
  const { url, loading, error } = useAuthedObjectUrl(imagePath.preview(page.page_version_id));

  return (
    <Panel
      title={`Page ${page.ordinal}${page.printed_page_label ? ` ${page.printed_page_label}` : ''}`}
      description={page.document_filename}
      actions={
        <Link
          to={`/pages/${page.page_version_id}`}
          className="text-sm font-medium text-sky-800 underline dark:text-sky-300"
        >
          Open full viewer
        </Link>
      }
    >
      <div className="flex flex-wrap gap-2">
        <StatusPill view={pageClassView(page.page_class)} showDetail />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <StatusPill view={handwritingView(page.handwriting_status)} />
        <StatusPill view={diagnosisView(page.diagnosis_status)} />
      </div>

      {page.defect_codes?.length ? (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-slate-800 dark:text-slate-200">Scan defects</h3>
          <ul className="mt-1 list-inside list-disc text-sm text-slate-800 dark:text-slate-200">
            {page.defect_codes.map((c) => (
              <li key={c}>{defectLabel(c)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex max-h-[45vh] justify-center overflow-auto rounded border border-slate-200 bg-slate-100 p-2 dark:border-slate-800 dark:bg-slate-950">
        {loading ? <Spinner label="Loading preview…" /> : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-900 dark:text-red-200">
            {error}
          </p>
        ) : null}
        {url ? (
          <img src={url} alt={`Preview of page ${page.ordinal}`} className="max-w-full object-contain" />
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onAccept} disabled={busy}>
          Accept <span className="ml-1 text-xs opacity-80">(A)</span>
        </Button>
        <Button variant="danger" onClick={onRescan} disabled={busy}>
          Request rescan <span className="ml-1 text-xs opacity-80">(R)</span>
        </Button>
      </div>
    </Panel>
  );
}

function RescanDialog({
  page,
  onClose,
  onSubmit,
}: {
  page: PageSummary | null;
  onClose: () => void;
  onSubmit: (comment: string) => void;
}) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (page) setText('');
  }, [page]);

  if (!page) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Request a rescan"
      description={`Page ${page.ordinal} of ${page.document_filename}. Say what needs fixing so whoever rescans it knows.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={text.trim().length === 0} onClick={() => onSubmit(text.trim())}>
            Request rescan
          </Button>
        </>
      }
    >
      <TextArea
        label="Reason (required)"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Sheet is sideways and the left margin is cut off."
      />
    </Modal>
  );
}
