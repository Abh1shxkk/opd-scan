/**
 * Small hand-built form and layout primitives.
 *
 * Two things are enforced here rather than left to each screen: every control is associated with
 * a real <label> (or an explicit aria-label), and every interactive element carries the same
 * visible focus ring, since a keyboard-driven review queue is unusable without one.
 *
 * Visually these are the boxed fields of a pre-printed form — a hairline box, a condensed
 * letterspaced label above it, and nothing else. The focus ring is declared once globally in
 * index.css, so `FOCUS_RING` survives only as the marker for elements that opt out of the default
 * outline and need it restored.
 */
import { useId } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

const CONTROL =
  'w-full border border-rule-2 bg-paper px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-2/70 disabled:bg-paper-2 disabled:text-ink-2';

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="field-label mb-1 block">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11px] leading-snug text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={props.id ?? id}>
      <input {...props} id={props.id ?? id} className={`${CONTROL} ${props.className ?? ''}`} />
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={props.id ?? id}>
      <textarea {...props} id={props.id ?? id} className={`${CONTROL} ${props.className ?? ''}`} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={props.id ?? id}>
      <select {...props} id={props.id ?? id} className={`${CONTROL} ${props.className ?? ''}`}>
        {children}
      </select>
    </Field>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * `primary` and `danger` are the only filled controls in the application, and `danger` is filled
 * in the same ink that means "out of band" everywhere else — so a destructive action is coloured
 * by the same rule as every other status, not by a decorative palette of its own.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'border border-chart bg-chart text-paper hover:bg-chart/90 disabled:border-rule-2 disabled:bg-ink-2',
  secondary: 'border border-rule-2 bg-paper-2 text-ink hover:bg-paper-3',
  danger:
    'border border-plot bg-plot/[0.07] text-plot hover:bg-plot/[0.14] disabled:border-rule-2 disabled:text-ink-2',
  ghost: 'border border-transparent text-ink hover:bg-chart/[0.07]',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-[30px] items-center justify-center gap-1.5 px-3 py-1 font-label text-[12px] font-semibold uppercase tracking-label transition-colors duration-150 ease-chart disabled:cursor-not-allowed disabled:opacity-70 ${VARIANT[variant]} ${className}`}
    />
  );
}

/**
 * A checkbox group inside a fieldset, so the group name is announced with each option. Used for
 * every multi-value filter (page class, defect, handwriting, diagnosis status).
 */
export function CheckboxGroup<T extends string>({
  legend,
  options,
  selected,
  onToggle,
  columns = 1,
}: {
  legend: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  selected: readonly string[];
  onToggle: (value: T) => void;
  columns?: 1 | 2;
}) {
  return (
    <fieldset>
      <legend className="field-label mb-1.5">{legend}</legend>
      <div className={`grid gap-0.5 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-start gap-2 px-1 py-1 text-[13px] text-ink transition-colors duration-150 ease-chart hover:bg-chart/[0.07]"
          >
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => onToggle(o.value)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-none border-rule-2 text-chart"
            />
            <span className="min-w-0">
              {o.label}
              {o.hint ? <span className="block text-[11px] text-ink-2">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Work in progress, drawn as a reading being plotted rather than as a spinning disc.
 *
 * Under `prefers-reduced-motion` the trace stops moving and the track stays hatched — which still
 * reads as "not finished", and is the honest picture of a value that has not arrived.
 */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-5 text-[13px] text-ink-2" role="status">
      <span
        aria-hidden="true"
        className="relative block h-2 w-20 overflow-hidden border border-rule bg-paper"
      >
        <span className="trace hatch absolute inset-y-0 w-1/3" />
      </span>
      {label}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  return (
    <div role="alert" className="border border-plot/60 bg-plot/[0.07] p-3 text-[13px] text-ink">
      <p className="flex items-center gap-1.5 font-label text-[12px] font-semibold uppercase tracking-label text-plot">
        <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" />
        Could not load this data
      </p>
      <p className="mt-1.5">{message}</p>
      {retry ? (
        <Button variant="secondary" onClick={retry} className="mt-2.5">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Nothing here — drawn as an unfilled field rather than as an illustration.
 *
 * Hatching is reserved for "never measured", so an empty result set is deliberately *not* hatched:
 * the query ran and returned nothing, which is a finding.
 */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border border-dashed border-rule-2 bg-paper-2 px-4 py-7 text-center">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      {children ? <div className="mt-1 text-[12px] text-ink-2">{children}</div> : null}
    </div>
  );
}

/** A definition-list row used across the detail panes. */
export function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-baseline gap-2 border-b border-rule py-1.5 text-[13px] last:border-b-0">
      <dt className="field-label">{term}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}
