/**
 * "Back to top" for every screen.
 *
 * Mounted once in the app shell rather than on each list, so no list can forget it. The shell
 * scrolls inside <main>, not the window, so that is the element it watches and scrolls.
 */

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

export function BackToTop({ containerId = 'main', threshold = 400 }: { containerId?: string; threshold?: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const onScroll = () => setVisible(el.scrollTop > threshold);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerId, threshold]);

  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById(containerId);
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      }}
      aria-label="Back to top"
      title="Back to top"
      className={`fixed bottom-5 right-5 z-40 grid h-11 w-11 place-items-center rounded-full border border-chart bg-chart text-paper shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:bg-chart/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
        visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
      }`}
    >
      <ArrowUp size={18} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}
