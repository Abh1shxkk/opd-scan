/**
 * Transient status messages.
 *
 * The live region is `polite` and always present in the DOM (rather than mounted on demand) so
 * assistive technology actually announces changes — a region that appears at the same moment as
 * its text is frequently missed.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Check, Info, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

/**
 * The tone is carried by the mark and the announced prefix; the border stays a plain rule, because
 * a thick coloured edge is decoration and colour in this application only ever means status.
 */
const TONE: Record<ToastTone, { classes: string; mark: string; icon: LucideIcon; prefix: string }> =
  {
    success: {
      classes: 'border-band/50 bg-band/[0.07]',
      mark: 'text-band',
      icon: Check,
      prefix: 'Success',
    },
    error: {
      classes: 'border-plot/50 bg-plot/[0.07]',
      mark: 'text-plot',
      icon: TriangleAlert,
      prefix: 'Error',
    },
    info: {
      classes: 'border-chart/50 bg-chart/[0.07]',
      mark: 'text-chart',
      icon: Info,
      prefix: 'Notice',
    },
  };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, tone, message }]);
    // Errors stay longer: they usually need reading, not just noticing.
    window.setTimeout(
      () => setItems((prev) => prev.filter((t) => t.id !== id)),
      tone === 'error' ? 9000 : 5000,
    );
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
        {items.map((t) => {
          const Mark = TONE[t.tone].icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 border px-3 py-2 text-[13px] text-ink ${TONE[t.tone].classes}`}
            >
              <Mark
                size={14}
                strokeWidth={2.5}
                aria-hidden="true"
                className={`mt-[3px] shrink-0 ${TONE[t.tone].mark}`}
              />
              <span>
                <span className="sr-only">{TONE[t.tone].prefix}: </span>
                {t.message}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 px-1 text-ink-2 hover:text-ink"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
              >
                <X size={14} strokeWidth={2.5} aria-hidden="true" />
                <span className="sr-only">Dismiss this message</span>
              </button>
            </div>
          );
        })}
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
    <p aria-live="polite" aria-busy={busy ? 'true' : 'false'} className="text-[13px] text-ink-2">
      {message}
    </p>
  );
}
