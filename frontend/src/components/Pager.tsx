/**
 * Previous / next paging for every list screen.
 *
 * The API pages with `limit` and `offset`; screens think in page numbers. `pageParams` is the one
 * place that converts between them — the documents list used to send `page=` straight through,
 * which the API ignores, so every "next page" quietly showed page one again.
 */

import { useEffect } from 'react';
import { Button } from './ui';

export const PAGE_SIZE = 50;

export function pageParams(page: number, size = PAGE_SIZE): { limit: string; offset: string } {
  return { limit: String(size), offset: String(Math.max(0, page - 1) * size) };
}

export function Pager({
  page,
  pageSize = PAGE_SIZE,
  total,
  count,
  hasMore,
  onPage,
}: {
  page: number;
  pageSize?: number;
  /** Total matching rows, when the API reports it. */
  total?: number;
  /** Rows actually shown on this page. */
  count: number;
  /** For lists without a total: whether a further page exists. */
  hasMore?: boolean;
  onPage: (page: number) => void;
}) {
  const from = count === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = (page - 1) * pageSize + count;
  const lastPage = total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const canNext = lastPage !== undefined ? page < lastPage : Boolean(hasMore);

  if (page <= 1 && !canNext) return null;

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 py-2">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </Button>
      <p className="text-[13px] tabular-nums text-ink-2" aria-live="polite">
        {from}–{to}
        {total !== undefined ? ` of ${total}` : ''} · Page {page}
        {lastPage !== undefined ? ` of ${lastPage}` : ''}
      </p>
      <Button variant="secondary" disabled={!canNext} onClick={() => onPage(page + 1)}>
        Next →
      </Button>
    </nav>
  );
}

/**
 * Step back when the current page no longer exists — after deleting or deciding the last item on
 * the last page, the list would otherwise show "nothing here" with records still on earlier pages.
 */
export function useClampPage(
  page: number,
  total: number | undefined,
  setPage: (page: number) => void,
  pageSize = PAGE_SIZE,
): void {
  useEffect(() => {
    if (total === undefined || page <= 1) return;
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (page > last) setPage(last);
  }, [page, total, setPage, pageSize]);
}
