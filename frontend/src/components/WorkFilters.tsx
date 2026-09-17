/**
 * The filter strip and the file-by-file layout shared by the three work queues — review, awaiting
 * rescan and diagnosis review.
 *
 * Kept deliberately quiet: one row of controls, no explanatory paragraphs, and a file list that
 * reads like an inbox. The date and time a clerk picks are their local time; `toUploadWindow` turns
 * them into the UTC instants the API compares against, so "uploaded on the 17th" means their 17th.
 */

import type { ReactNode } from 'react';
import { CalendarDays, ChevronRight, FileText, Search, X } from 'lucide-react';

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

const INPUT =
  'h-10 border border-rule-2 bg-paper px-2.5 text-[14px] text-ink placeholder:text-ink-2/70 focus:border-chart focus:outline-none focus-visible:ring-2 focus-visible:ring-chart/30 disabled:cursor-not-allowed disabled:opacity-50';

/** A small on/off chip for a queue option such as "Only not reviewed". */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
        active
          ? 'border-chart bg-chart text-paper'
          : 'border-rule-2 bg-paper text-ink hover:border-chart hover:text-chart'
      }`}
    >
      {active ? <span aria-hidden="true">✓</span> : null}
      {children}
    </button>
  );
}

export function WorkFilters({
  value,
  onChange,
  searchPlaceholder = 'Search by file name, MR or IPD number',
  children,
}: {
  value: WorkFilterValue;
  onChange: (next: WorkFilterValue) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Option chips shown under the search row. */
  children?: ReactNode;
}) {
  const set = (patch: Partial<WorkFilterValue>) => onChange({ ...value, ...patch });
  const active = Boolean(value.search || value.day || value.fromTime || value.toTime);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[16rem] flex-1">
          <span className="sr-only">Search</span>
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
          />
          <input
            type="search"
            value={value.search}
            placeholder={searchPlaceholder}
            onChange={(e) => set({ search: e.target.value })}
            className={`${INPUT} w-full pl-9`}
          />
        </label>

        <label className="relative">
          <span className="sr-only">Uploaded on</span>
          <CalendarDays
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
          />
          <input
            type="date"
            value={value.day}
            title="Uploaded on"
            onChange={(e) =>
              set({ day: e.target.value, ...(e.target.value ? {} : { fromTime: '', toTime: '' }) })
            }
            className={`${INPUT} w-[11.5rem] pl-9`}
          />
        </label>

        {/* Times only make sense within a chosen day, so they appear once a day is picked. */}
        {value.day ? (
          <div className="flex items-center gap-1.5">
            <label>
              <span className="sr-only">From time</span>
              <input
                type="time"
                value={value.fromTime}
                title="From time"
                onChange={(e) => set({ fromTime: e.target.value })}
                className={`${INPUT} w-[7.5rem]`}
              />
            </label>
            <span className="text-[13px] text-ink-2">to</span>
            <label>
              <span className="sr-only">To time</span>
              <input
                type="time"
                value={value.toTime}
                title="To time"
                onChange={(e) => set({ toTime: e.target.value })}
                className={`${INPUT} w-[7.5rem]`}
              />
            </label>
          </div>
        ) : null}

        {active ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_WORK_FILTER)}
            className="inline-flex h-10 items-center gap-1 px-2 text-[13px] font-medium text-chart hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <X size={14} aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>

      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
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
 * Files on the left, the selected file's work on the right. On a narrow screen the two stack, file
 * list first.
 */
export function FileSplit<T>({
  groups,
  selectedId,
  onSelect,
  countLabel,
  detail,
}: {
  groups: FileGroup<T>[];
  selectedId: string | null;
  onSelect: (documentId: string) => void;
  /** Tooltip for the count badge, e.g. n => `${n} pages waiting` */
  countLabel: (n: number) => string;
  meta?: (g: FileGroup<T>) => ReactNode;
  detail: (g: FileGroup<T>) => ReactNode;
}) {
  const selected = groups.find((g) => g.documentId === selectedId) ?? groups[0];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <nav aria-label="Files" className="border border-rule bg-paper lg:sticky lg:top-0">
        <p className="border-b border-rule px-3 py-2 text-[12px] font-medium uppercase tracking-label text-ink-2">
          Files <span className="tabular-nums">({groups.length})</span>
        </p>
        <ul className="max-h-[70vh] overflow-y-auto">
          {groups.map((g) => {
            const isSel = g.documentId === selected?.documentId;
            const n = g.count ?? g.items.length;
            return (
              <li key={g.documentId}>
                <button
                  type="button"
                  onClick={() => onSelect(g.documentId)}
                  aria-current={isSel ? 'true' : undefined}
                  className={`group flex w-full items-center gap-2.5 border-l-[3px] px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${
                    isSel ? 'border-chart bg-chart/[0.08]' : 'border-transparent hover:bg-paper-2'
                  }`}
                >
                  <FileText
                    size={16}
                    aria-hidden="true"
                    className={`shrink-0 ${isSel ? 'text-chart' : 'text-ink-2'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink" title={g.filename}>
                      {g.filename}
                    </span>
                    {g.patientRef ? (
                      <span className="block truncate text-[12px] text-ink-2">MR {g.patientRef}</span>
                    ) : null}
                  </span>
                  <span
                    title={countLabel(n)}
                    className={`min-w-[1.75rem] rounded-full px-2 py-0.5 text-center text-[12px] font-semibold tabular-nums ${
                      isSel ? 'bg-chart text-paper' : 'bg-paper-3 text-ink'
                    }`}
                  >
                    {n}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" className="hidden shrink-0 text-ink-2 lg:block" />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section aria-label={selected ? selected.filename : 'Selected file'} className="min-w-0">
        {selected ? detail(selected) : null}
      </section>
    </div>
  );
}

/** Header for the right-hand panel: file name, a subtitle, and the panel's main action. */
export function DetailHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-[16px] font-semibold text-ink" title={title}>
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** The page title every queue uses: a heading and one plain sentence. */
export function QueueHeader({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <header className="pb-1">
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
      <p className="mt-1 text-[14px] text-ink-2">{subtitle}</p>
    </header>
  );
}
