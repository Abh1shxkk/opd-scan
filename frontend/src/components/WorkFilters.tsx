/**
 * The filter strip and the file-by-file layout shared by the three work queues — review, awaiting
 * rescan and diagnosis review.
 *
 * All three are worked a PDF at a time: pick a file on the left, see what is outstanding in it on
 * the right. The date and time a clerk picks are their local time; `toUploadWindow` turns them into
 * the UTC instants the API compares against, so "uploaded on the 17th" means the clerk's 17th.
 */

import type { ReactNode } from 'react';
import { Button, TextInput } from './ui';

export interface WorkFilterValue {
  search: string;
  day: string;
  fromTime: string;
  toTime: string;
}

export const EMPTY_WORK_FILTER: WorkFilterValue = { search: '', day: '', fromTime: '', toTime: '' };

export function toUploadWindow(f: WorkFilterValue): { from?: string; to?: string } {
  if (!f.day) return {};
  return {
    from: new Date(`${f.day}T${f.fromTime || '00:00'}:00`).toISOString(),
    to: new Date(`${f.day}T${f.toTime || '23:59'}:59.999`).toISOString(),
  };
}

export function WorkFilters({
  value,
  onChange,
  searchLabel = 'File name',
  searchPlaceholder = 'e.g. case-sheet, discharge',
  children,
}: {
  value: WorkFilterValue;
  onChange: (next: WorkFilterValue) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Extra controls (toggles) placed after the date and time. */
  children?: ReactNode;
}) {
  const set = (patch: Partial<WorkFilterValue>) => onChange({ ...value, ...patch });
  const active = Boolean(value.search || value.day || value.fromTime || value.toTime);

  return (
    <div className="sheet p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <TextInput
          label={searchLabel}
          value={value.search}
          placeholder={searchPlaceholder}
          onChange={(e) => set({ search: e.target.value })}
        />
        <TextInput
          label="Uploaded on"
          type="date"
          value={value.day}
          onChange={(e) => set({ day: e.target.value, ...(e.target.value ? {} : { fromTime: '', toTime: '' }) })}
        />
        <TextInput
          label="From time"
          type="time"
          value={value.fromTime}
          disabled={!value.day}
          onChange={(e) => set({ fromTime: e.target.value })}
        />
        <TextInput
          label="To time"
          type="time"
          value={value.toTime}
          disabled={!value.day}
          onChange={(e) => set({ toTime: e.target.value })}
        />
        <div className="flex items-end">
          <Button variant="secondary" disabled={!active} onClick={() => onChange(EMPTY_WORK_FILTER)}>
            Clear
          </Button>
        </div>
      </div>
      {children ? <div className="mt-3 flex flex-wrap items-center gap-4">{children}</div> : null}
      {!value.day ? (
        <p className="mt-2 text-[11px] text-ink-2">Choose a date to filter by time as well.</p>
      ) : null}
    </div>
  );
}

export interface FileGroup<T> {
  documentId: string;
  filename: string;
  patientRef?: string | null;
  uploadedAt?: string | null;
  items: T[];
  /** Shown instead of items.length when the group is a summary rather than a list of rows. */
  count?: number;
}

/** Group rows by the PDF they came from, keeping the order in which each file first appears. */
export function groupByFile<T>(
  rows: T[],
  key: (row: T) => { documentId: string; filename: string; patientRef?: string | null; uploadedAt?: string | null },
): FileGroup<T>[] {
  const groups = new Map<string, FileGroup<T>>();
  for (const row of rows) {
    const k = key(row);
    let g = groups.get(k.documentId);
    if (!g) {
      g = { ...k, items: [] };
      groups.set(k.documentId, g);
    }
    g.items.push(row);
  }
  return [...groups.values()];
}

/**
 * Files on the left, the selected file's outstanding items on the right. On a narrow screen the two
 * stack, file list first.
 */
export function FileSplit<T>({
  groups,
  selectedId,
  onSelect,
  countLabel,
  meta,
  detail,
}: {
  groups: FileGroup<T>[];
  selectedId: string | null;
  onSelect: (documentId: string) => void;
  /** e.g. n => `${n} waiting` */
  countLabel: (n: number) => string;
  meta?: (g: FileGroup<T>) => ReactNode;
  detail: (g: FileGroup<T>) => ReactNode;
}) {
  const selected = groups.find((g) => g.documentId === selectedId) ?? groups[0];

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <ul aria-label="Files" className="sheet max-h-[75vh] divide-y divide-rule overflow-y-auto">
        {groups.map((g) => {
          const isSel = g.documentId === selected?.documentId;
          return (
            <li key={g.documentId}>
              <button
                type="button"
                onClick={() => onSelect(g.documentId)}
                aria-current={isSel ? 'true' : undefined}
                className={`block w-full px-3 py-2.5 text-left transition-colors duration-150 ease-chart focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${
                  isSel ? 'border-l-4 border-chart bg-chart/[0.1]' : 'border-l-4 border-transparent hover:bg-paper-2'
                }`}
              >
                <span className="block truncate text-[13px] font-medium text-ink" title={g.filename}>
                  {g.filename}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-2">
                  <span className={`font-semibold ${isSel ? 'text-chart' : 'text-ink'}`}>
                    {countLabel(g.count ?? g.items.length)}
                  </span>
                  {g.patientRef ? <span>MR {g.patientRef}</span> : null}
                  {meta ? meta(g) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <section aria-label={selected ? selected.filename : 'Selected file'} className="min-w-0">
        {selected ? detail(selected) : null}
      </section>
    </div>
  );
}
