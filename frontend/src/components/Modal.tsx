/**
 * A keyboard-operable modal dialog.
 *
 * Behaviour required for WCAG 2.1.2 / 2.4.3, implemented by hand because there is no component
 * library here: focus moves into the dialog on open, Tab is trapped inside it, Escape closes it,
 * and focus returns to whatever opened it. The backdrop is inert to screen readers.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2)}`).current;
  const descId = `${titleId}-desc`;

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Focus the first control, or the panel itself when the dialog is purely informational.
    const node = panelRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    // The page behind must not scroll while a dialog is up.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = panelRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-[1px]"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative z-10 w-full ${width} rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none dark:border-slate-800 dark:bg-slate-900`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4 dark:border-slate-800">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900 dark:text-slate-50">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ✕
            </span>
            <span className="sr-only">Close dialog</span>
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-800">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
