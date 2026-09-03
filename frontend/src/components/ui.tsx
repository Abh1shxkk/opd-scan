/**
 * Small hand-built form and layout primitives.
 *
 * Two things are enforced here rather than left to each screen: every control is associated with
 * a real <label> (or an explicit aria-label), and every interactive element carries the same
 * visible focus ring, since a keyboard-driven review queue is unusable without one.
 */

import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400';

const CONTROL =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-500';

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
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-xs font-medium text-slate-800 dark:text-slate-200"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{hint}</p> : null}
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
      <input {...props} id={props.id ?? id} className={`${CONTROL} ${FOCUS_RING} ${props.className ?? ''}`} />
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
      <textarea {...props} id={props.id ?? id} className={`${CONTROL} ${FOCUS_RING} ${props.className ?? ''}`} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={props.id ?? id}>
      <select {...props} id={props.id ?? id} className={`${CONTROL} ${FOCUS_RING} ${props.className ?? ''}`}>
        {children}
      </select>
    </Field>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-sky-700 text-white hover:bg-sky-800 disabled:bg-slate-400 dark:bg-sky-600 dark:hover:bg-sky-500 dark:disabled:bg-slate-700',
  secondary:
    'border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 disabled:text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-50 dark:hover:bg-slate-800',
  danger:
    'bg-red-700 text-white hover:bg-red-800 disabled:bg-slate-400 dark:bg-red-700 dark:hover:bg-red-600',
  ghost: 'text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
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
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${VARIANT[variant]} ${FOCUS_RING} ${className}`}
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
      <legend className="mb-1 text-xs font-medium text-slate-800 dark:text-slate-200">{legend}</legend>
      <div className={`grid gap-1 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-sm text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => onToggle(o.value)}
              className={`mt-0.5 h-4 w-4 shrink-0 rounded border-slate-500 text-sky-700 ${FOCUS_RING}`}
            />
            <span>
              {o.label}
              {o.hint ? (
                <span className="block text-xs text-slate-600 dark:text-slate-400">{o.hint}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-700 dark:text-slate-300" role="status">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-sky-700 dark:border-slate-600 dark:border-t-sky-400"
      />
      {label}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.';
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-400 bg-red-50 p-4 text-sm text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50"
    >
      <p className="font-medium">
        <span aria-hidden="true">⚠ </span>
        Could not load this data
      </p>
      <p className="mt-1">{message}</p>
      {retry ? (
        <Button variant="secondary" onClick={retry} className="mt-3">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center dark:border-slate-600">
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</p>
      {children ? <div className="mt-1 text-sm text-slate-700 dark:text-slate-300">{children}</div> : null}
    </div>
  );
}

/** A definition-list row used across the detail panes. */
export function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-slate-600 dark:text-slate-400">{term}</dt>
      <dd className="text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  );
}
