/**
 * A reading plotted against its band.
 *
 * This is the instrument the rest of the interface is built around: a value is never stated as a
 * bare number when a scale exists to read it against. The band is the range the value can take,
 * the detents are the marks that give the range meaning — a reference value, a classification
 * threshold, or the position a threshold used to sit at before it was retuned.
 *
 * Two rules keep it honest:
 *
 *  - a detent is only ever drawn from a value the API actually supplied. There is no invented
 *    "target", because no such target exists in this product's data, and a shaded target band
 *    nobody set would be a claim rather than a reading.
 *  - a band with no value behind it is hatched, not empty, because "not measured" and "measured as
 *    zero" are different findings.
 */

import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export type BandTone = 'plain' | 'ok' | 'warn' | 'bad' | 'info';

const FILL: Record<BandTone, string> = {
  plain: 'bg-chart',
  ok: 'bg-band',
  warn: 'bg-note',
  bad: 'bg-plot',
  info: 'bg-chart',
};

export interface Detent {
  /** Position on the band, in the same units as `value`. */
  at: number;
  /** `reference` is a value the system was given; `ghost` is one it has since moved away from. */
  kind: 'reference' | 'ghost';
  /** Read out when the band is expanded, and carried as the mark's accessible name. */
  label: string;
}

function pct(n: number, min: number, max: number): number {
  if (!Number.isFinite(n) || max <= min) return 0;
  return Math.min(100, Math.max(0, ((n - min) / (max - min)) * 100));
}

export function BandPlot({
  value,
  min = 0,
  max,
  detents = [],
  tone = 'plain',
  unmeasured = false,
  width = 'w-full',
  height = 'h-2.5',
  className = '',
}: {
  /** `null` means nothing was measured — the band is hatched rather than drawn at zero. */
  value: number | null;
  min?: number;
  max: number;
  detents?: Detent[];
  tone?: BandTone;
  unmeasured?: boolean;
  width?: string;
  height?: string;
  className?: string;
}) {
  // Two different absences. A value the API never supplied hatches the whole band, because its
  // magnitude is unknown. A value that *is* known but describes something never measured — 96
  // pages whose handwriting check failed — plots at its real width and is hatched there, so the
  // size of the gap stays readable while never being mistaken for a measured result.
  const noValue = value === null;
  const hatched = noValue || unmeasured;
  const filled = noValue ? 100 : pct(value as number, min, max);

  return (
    <span
      aria-hidden="true"
      className={`chart-grid relative block shrink-0 border border-rule bg-paper ${width} ${height} ${className}`}
    >
      <span
        className={`absolute inset-y-0 left-0 transition-[width] duration-150 ease-chart ${
          hatched ? 'hatch border-r border-ink-2/60' : FILL[tone]
        }`}
        style={{ width: `${Math.max(filled > 0 ? 1.5 : 0, filled)}%` }}
      />

      {detents.map((d) => (
        <span
          key={`${d.kind}-${d.at}`}
          title={d.label}
          className={`absolute -top-px bottom-[-1px] w-px ${
            d.kind === 'reference' ? 'bg-ink' : 'bg-ink-2'
          }`}
          style={{
            left: `${pct(d.at, min, max)}%`,
            // A retuned-away-from position is drawn as a broken rule, so it reads as history
            // rather than as a second live threshold.
            backgroundImage:
              d.kind === 'ghost'
                ? 'repeating-linear-gradient(to bottom, currentColor 0 2px, transparent 2px 4px)'
                : undefined,
          }}
        />
      ))}
    </span>
  );
}

/**
 * A labelled reading: the name, the figure, the band, and whatever the band needs explaining.
 *
 * `expand` is the signature interaction — hovering or focusing the row opens the band in place and
 * reveals what its detents mean, so the reference values are available on demand rather than
 * spending a line of the table on every row.
 */
export function Reading({
  label,
  value,
  band,
  note,
  expand,
  to,
  unmeasured = false,
}: {
  label: ReactNode;
  value: ReactNode;
  band?: ReactNode;
  note?: ReactNode;
  expand?: ReactNode;
  /** Where this figure came from — the filtered list that produced it. */
  to?: string;
  unmeasured?: boolean;
}) {
  const body = (
    <>
      <span className="min-w-0 truncate text-ink">{label}</span>

      {/* A dotted leader, the way a printed schedule ties a name to its figure. Without it a row
          with no band strands its number a thousand pixels from its label on a wide screen. */}
      <span aria-hidden="true" className="mx-1 min-w-[1.5rem] border-b border-dotted border-rule-2" />

      <span
        className={`shrink-0 tabular-nums font-semibold ${unmeasured ? 'text-ink-2' : 'text-ink'}`}
      >
        {value}
      </span>
      <span className="flex shrink-0 justify-end">{band}</span>

      {note ? (
        <span className="col-span-4 mt-1 text-[11px] leading-snug text-ink-2">{note}</span>
      ) : null}

      {/* The band opens in place on hover or focus. The height is animated through a collapsing
          grid row rather than toggling `hidden`, which cannot transition — this is the one named
          moment of motion in the application and it is damped, not popped. */}
      {expand ? (
        <span className="col-span-4 grid grid-rows-[0fr] overflow-hidden transition-[grid-template-rows] duration-150 ease-chart group-focus-within:grid-rows-[1fr] group-hover:grid-rows-[1fr]">
          <span className="min-h-0 overflow-hidden">
            <span className="block pt-1 text-[11px] leading-snug text-ink-2">{expand}</span>
          </span>
        </span>
      ) : null}
    </>
  );

  const layout =
    'group grid grid-cols-[auto_minmax(1.5rem,1fr)_auto_auto] items-center gap-x-1 px-2 py-1.5 text-[13px]';
  const interactive = 'transition-colors duration-150 ease-chart hover:bg-chart/[0.07]';

  if (to) {
    return (
      <Link to={to} className={`${layout} ${interactive}`}>
        {body}
      </Link>
    );
  }
  // Deliberately not focusable. The expandable rows all contain their own control (the threshold
  // input), so `group-focus-within` already opens them from the keyboard; adding a tabindex here
  // would put a dozen non-actioning stops in front of the filter controls on a dense screen.
  return <div className={`${layout} ${expand ? interactive : ''}`}>{body}</div>;
}
