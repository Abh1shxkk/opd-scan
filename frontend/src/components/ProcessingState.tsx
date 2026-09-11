/**
 * What is still happening to a patient's files.
 *
 * Uploading a record and having it analysed are two different moments. The ingest rasterises the
 * pages first; then the quality engine measures each one, the OCR reads it, and the interpreter
 * works on the prescriptions. All of that happens on a worker, minutes after the clerk has moved
 * on — so a record can sit there with nothing to show and still be perfectly healthy.
 *
 * This states which. The four states are derived only from counts the API actually supplies, and
 * the one that matters most is the distinction this whole product is built on: a record with no
 * pages yet is **not done**, and must never read as a record with nothing wrong.
 */

import { CircleCheck, Ellipsis, RefreshCw, TriangleAlert } from 'lucide-react';
import type { Case } from '../lib/types';
import { BandPlot } from './BandPlot';

export type Phase = 'ingesting' | 'analysing' | 'ready' | 'failed' | 'empty';

export function phaseOf(c: Case): Phase {
  if (c.ingest_failed > 0) return 'failed';
  if (c.documents_pending > 0) return 'ingesting';
  if (c.document_count === 0) return 'empty';
  // Every active page measured, and nothing left on the queue.
  if (c.page_count > 0 && c.pages_measured >= c.page_count && c.jobs_active === 0) return 'ready';
  return 'analysing';
}

/** True while the server still owes this record work — the signal to keep polling. */
export function isWorking(c: Case): boolean {
  const p = phaseOf(c);
  return p === 'ingesting' || p === 'analysing';
}

const MARK = {
  ingesting: Ellipsis,
  analysing: RefreshCw,
  ready: CircleCheck,
  failed: TriangleAlert,
  empty: Ellipsis,
} as const;

const INK = {
  ingesting: 'text-ink-2',
  analysing: 'text-chart',
  ready: 'text-band',
  failed: 'text-plot',
  empty: 'text-ink-2',
} as const;

export function ProcessingState({ record, compact = false }: { record: Case; compact?: boolean }) {
  const phase = phaseOf(record);
  const Mark = MARK[phase];

  const label =
    phase === 'failed'
      ? `${record.ingest_failed} file${record.ingest_failed === 1 ? '' : 's'} refused`
      : phase === 'ingesting'
        ? 'Reading the file'
        : phase === 'empty'
          ? 'No file attached'
          : phase === 'ready'
            ? 'Ready'
            : 'Analysing';

  const detail =
    phase === 'analysing'
      ? `${record.pages_measured} of ${record.page_count} pages measured`
      : phase === 'ingesting'
        ? 'Rasterising pages — they appear as it goes'
        : phase === 'failed'
          ? 'Open the record to see why'
          : phase === 'ready'
            ? `${record.page_count} page${record.page_count === 1 ? '' : 's'} measured`
            : 'Details were entered before the documents';

  return (
    <div className={compact ? '' : 'min-w-[9rem]'}>
      <span className="flex items-center gap-1.5">
        <Mark
          size={12}
          strokeWidth={2.5}
          aria-hidden="true"
          className={`shrink-0 ${INK[phase]} ${phase === 'analysing' ? 'motion-safe:animate-spin' : ''}`}
        />
        <span className="truncate text-ink">{label}</span>
      </span>

      {/* Hatched while the work is outstanding: the pages that exist have not been measured yet,
          and a solid bar would claim otherwise. */}
      {phase === 'analysing' && record.page_count > 0 ? (
        <BandPlot
          className="mt-1"
          value={record.pages_measured}
          max={record.page_count}
          tone="info"
          height="h-1.5"
          width="w-full"
        />
      ) : null}

      <span className="mt-0.5 block truncate text-[11px] leading-none text-ink-2">{detail}</span>
    </div>
  );
}
