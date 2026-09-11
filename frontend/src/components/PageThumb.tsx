/**
 * A page thumbnail with its status underneath.
 *
 * The status is always spelled out in text: a strip of thumbnails distinguished only by border
 * colour is exactly the case where a reviewer with a colour-vision deficiency loses the plot.
 */

import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';
import { imagePath } from '../lib/api';
import { pageClassView } from '../lib/status';
import type { PageClass } from '../lib/types';
import { StatusPill } from './StatusPill';

export function PageThumb({
  pageVersionId,
  ordinal,
  printedLabel,
  pageClass,
  selected = false,
  onClick,
  as = 'button',
}: {
  pageVersionId: string;
  ordinal: number;
  printedLabel?: string | null;
  pageClass?: PageClass;
  selected?: boolean;
  onClick?: () => void;
  as?: 'button' | 'div';
}) {
  const { url, loading, error } = useAuthedObjectUrl(imagePath.thumb(pageVersionId));
  const view = pageClass ? pageClassView(pageClass) : null;

  const inner = (
    <>
      <span
        className={`flex h-24 w-full items-center justify-center overflow-hidden rounded border bg-paper-2 ${
          selected ? 'border-chart ring-2 ring-chart ' : 'border-rule '
        }`}
      >
        {url ? (
          <img src={url} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
        ) : loading ? (
          <span className="text-[11px] text-ink-2">Loading…</span>
        ) : (
          <span className="px-1 text-center text-[11px] text-plot">
            {error ? 'Preview unavailable' : 'No preview'}
          </span>
        )}
      </span>
      <span className="mt-1 block text-[11px] font-medium text-ink">
        Page {ordinal}
        {/* The printed "(14)" in the form's corner is the sequence-gap signal; show it verbatim. */}
        {printedLabel ? <span className="ml-1 font-normal text-ink-2">{printedLabel}</span> : null}
      </span>
      {view ? (
        <span className="mt-0.5 block">
          <StatusPill view={view} size="sm" />
        </span>
      ) : null}
    </>
  );

  if (as === 'div' || !onClick) {
    return <div className="w-28 shrink-0 text-left">{inner}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className="w-28 shrink-0 rounded p-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {inner}
    </button>
  );
}
