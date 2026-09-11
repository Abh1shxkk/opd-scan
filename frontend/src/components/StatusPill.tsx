/**
 * A stamped verdict.
 *
 * Colour here means status and nothing else — but it is never the *only* carrier of it. The drawn
 * mark and the label carry the meaning on their own, so a stamp still reads correctly in
 * greyscale, at any colour-vision profile, and to a screen reader.
 *
 * The one thing colour is *not* asked to carry is the distinction this product cares about most.
 * A status whose `unmeasured` flag is set — a failed check, an unconfigured provider, a page still
 * in the queue — is hatched, the chart convention for a region that was never measured. That is
 * what keeps "Handwriting not checked" from being read at a glance as "No handwriting", which is
 * the opposite claim.
 *
 * Where two statuses share a fixed label, `qualifier` is what separates them, and it is rendered
 * rather than hidden in a `title` — a tooltip does not exist on the tablets this is used on.
 *
 * All wording comes from `lib/status.ts`; a screen never passes a hand-written label for a status
 * that has a canonical one.
 */

import { BandPlot, type BandTone } from './BandPlot';
import type { StatusView, Tone } from '../lib/status';

/**
 * Status ink. These four colours exist only to mean something — nothing decorative in this
 * application is ever coloured, which is why a stamp reads as a verdict and not as styling.
 */
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-band border-band/50 bg-band/[0.07]',
  warn: 'text-note border-note/50 bg-note/[0.07]',
  bad: 'text-plot border-plot/50 bg-plot/[0.07]',
  info: 'text-chart border-chart/50 bg-chart/[0.07]',
  neutral: 'text-ink-2 border-rule-2 bg-paper-2',
};

const MARK_CLASS: Record<Tone, string> = {
  ok: 'text-band',
  warn: 'text-note',
  bad: 'text-plot',
  info: 'text-chart',
  neutral: 'text-ink-2',
};

const BAND_TONE: Record<Tone, BandTone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  info: 'info',
  neutral: 'plain',
};

const SIZE_CLASS = {
  sm: 'text-[10px] px-1 py-[1px] gap-1',
  md: 'text-[11px] px-1.5 py-0.5 gap-1',
};

const MARK_SIZE = { sm: 10, md: 12 };

export function StatusPill({
  view,
  size = 'md',
  showDetail = false,
  className = '',
}: {
  view: StatusView;
  size?: keyof typeof SIZE_CLASS;
  /** Render the explanatory sentence beneath the stamp (used in detail panes, not in tables). */
  showDetail?: boolean;
  className?: string;
}) {
  const Mark = view.icon;
  return (
    // `min-w-0 max-w-full` so a stamp inside a wrapping flex row can shrink and wrap instead of
    // running past the edge — the qualifier made these wide enough for that to matter.
    <span className={`inline-block min-w-0 max-w-full align-top ${className}`}>
      <span
        className={`inline-flex max-w-full items-center border font-label font-semibold uppercase leading-none tracking-label ${
          TONE_CLASS[view.tone]
        } ${SIZE_CLASS[size]} ${view.unmeasured ? 'hatch' : ''}`}
        title={!showDetail && view.detail ? view.detail : undefined}
      >
        <Mark size={MARK_SIZE[size]} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{view.label}</span>
        {/*
          Rendered, not hidden behind a hover. Two statuses share the label "Handwriting not
          checked" by design, and a reviewer on a tablet — a confirmed device — has no way to
          summon a tooltip, so the reason has to be on the stamp itself.
        */}
        {view.qualifier ? (
          <>
            <span aria-hidden="true" className="shrink-0 opacity-45">
              ·
            </span>
            <span className="truncate font-normal opacity-90">{view.qualifier}</span>
          </>
        ) : null}
      </span>
      {showDetail && view.detail ? (
        <span className="mt-1 block text-[11px] text-ink-2">{view.detail}</span>
      ) : null}
    </span>
  );
}

/**
 * A count plotted against the population it came from.
 *
 * The band is not decoration duplicating the number beside it: it is the only thing that makes six
 * classes comparable at a glance, which is the whole job of the dashboard breakdowns. An
 * unmeasured class is hatched at its real width rather than filled, so a large "not checked" bar
 * shows how large the gap is without ever reading as a measured result.
 */
export function StatusCountRow({
  view,
  count,
  total,
  onClick,
}: {
  view: StatusView;
  count: number;
  total: number;
  onClick?: () => void;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const Mark = view.icon;

  const inner = (
    <>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <Mark
            size={12}
            strokeWidth={2.5}
            aria-hidden="true"
            className={`shrink-0 ${MARK_CLASS[view.tone]}`}
          />
          <span className="truncate text-ink">{view.label}</span>
        </span>
        {view.qualifier ? (
          <span className="mt-0.5 block pl-[18px] text-[11px] leading-none text-ink-2">
            {view.qualifier}
          </span>
        ) : null}
      </span>

      <span className="shrink-0 self-start tabular-nums font-semibold text-ink">
        {count.toLocaleString()}
      </span>

      <BandPlot
        value={count}
        max={total || 1}
        tone={BAND_TONE[view.tone]}
        unmeasured={view.unmeasured}
        width="w-16 sm:w-24"
      />

      <span className="w-9 shrink-0 self-start text-right text-[11px] tabular-nums text-ink-2">
        {total > 0 ? `${pct}%` : '—'}
      </span>
    </>
  );

  const layout =
    'grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-2.5 px-2 py-1.5 text-[13px]';

  if (!onClick) {
    return <div className={layout}>{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${layout} w-full text-left transition-colors duration-150 ease-chart hover:bg-chart/[0.07]`}
    >
      {inner}
    </button>
  );
}
