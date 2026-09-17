import type { QueryClient } from '@tanstack/react-query';

/** Every list that shows a page's state. Called after any review or rescan upload. */
const KEYS = ['page', 'cases', 'case', 'case-pages', 'case-documents', 'review-documents', 'document', 'document-pages', 'rescan-queue'];

export function refreshPageState(qc: QueryClient) {
  for (const key of KEYS) void qc.invalidateQueries({ queryKey: [key] });
}
