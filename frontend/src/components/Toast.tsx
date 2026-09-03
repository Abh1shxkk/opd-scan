/**
 * Transient status messages.
 *
 * The live region is `polite` and always present in the DOM (rather than mounted on demand) so
 * assistive technology actually announces changes — a region that appears at the same moment as
 * its text is frequently missed.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastValue {
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const TONE: Record<ToastTone, { classes: string; icon: string; prefix: string }> = {
  success: {
    classes:
      'border-emerald-600 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50 dark:border-emerald-400',
    icon: '✓',
    prefix: 'Success',
  },
  error: {
    classes: 'border-red-600 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-50 dark:border-red-400',
    icon: '⚠',
    prefix: 'Error',
  },
  info: {
    classes: 'border-sky-600 bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-50 dark:border-sky-400',
    icon: 'i',
    prefix: 'Notice',
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, tone, message }]);
    // Errors stay longer: they usually need reading, not just noticing.
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), tone === 'error' ? 9000 : 5000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-md border-l-4 px-3 py-2 text-sm shadow-lg ${TONE[t.tone].classes}`}
          >
            <span aria-hidden="true" className="mt-0.5 font-bold">
              {TONE[t.tone].icon}
            </span>
            <span>
              <span className="sr-only">{TONE[t.tone].prefix}: </span>
              {t.message}
            </span>
            <button
              type="button"
              className="ml-auto rounded px-1 text-xs opacity-70 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <span aria-hidden="true">✕</span>
              <span className="sr-only">Dismiss this message</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/**
 * A standing aria-live region for slower async work (loading a queue, running an export) where a
 * toast would be too transient.
 */
export function LiveStatus({ message, busy }: { message: string; busy?: boolean }) {
  return (
    <p
      aria-live="polite"
      aria-busy={busy ? 'true' : 'false'}
      className="text-sm text-slate-700 dark:text-slate-300"
    >
      {message}
    </p>
  );
}
