/**
 * Filter state that lives in the address bar.
 *
 * Keeping the canonical copy in the URL rather than in component state is what makes a filtered
 * view shareable — paste the link to a colleague and they see the same rows — and it is also what
 * guarantees an export matches the view, because both are built from the same query string.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FILTER_KEYS, parseFilters, toSearchParams, type Filters } from '../lib/filters';

export function useUrlFilters(): {
  filters: Filters;
  setFilters: (next: Filters) => void;
  reset: () => void;
  /** Query string for the API, including any non-filter params already in the URL (e.g. page). */
  params: URLSearchParams;
  page: number;
  setPage: (page: number) => void;
} {
  const [search, setSearch] = useSearchParams();

  const filters = useMemo(() => parseFilters(search), [search]);
  const page = Number(search.get('page') ?? '1') || 1;

  /**
   * Carry over any parameter the filter model does not own — a screen's own view state, such as
   * the pages/documents tab. Without this, changing a filter would silently reset it.
   */
  const carryOver = useCallback(
    (target: URLSearchParams) => {
      for (const [k, v] of search.entries()) {
        if (k === 'page') continue; // paging is decided by the caller below
        if (!FILTER_KEYS.has(k) && !target.has(k)) target.set(k, v);
      }
      return target;
    },
    [search],
  );

  const setFilters = useCallback(
    (next: Filters) => {
      // Any filter change resets paging: page 4 of the old result set is meaningless in the new one.
      setSearch(carryOver(toSearchParams(next)), { replace: true });
    },
    [setSearch, carryOver],
  );

  const reset = useCallback(
    () => setSearch(carryOver(new URLSearchParams()), { replace: true }),
    [setSearch, carryOver],
  );

  const setPage = useCallback(
    (p: number) => {
      const sp = carryOver(toSearchParams(filters));
      if (p > 1) sp.set('page', String(p));
      setSearch(sp, { replace: false });
    },
    [filters, setSearch, carryOver],
  );

  const params = useMemo(() => toSearchParams(filters, { page }), [filters, page]);

  return { filters, setFilters, reset, params, page, setPage };
}
