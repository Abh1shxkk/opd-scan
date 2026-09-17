/**
 * One place that knows which screens show a page's state.
 *
 * Every mutation used to invalidate its own short list of query keys, and each list missed some:
 * accept a page in the viewer, go back, and the file view still said "3 of 12 open"; upload a rescan
 * and the patient record kept the old thumbnail. Anything that changes a page, its review, its
 * version or its diagnoses calls this instead.
 */

import type { QueryClient } from '@tanstack/react-query';

const PAGE_STATE_KEYS = [
  'page',
  'pages',
  'dashboard',
  'review-queue',
  'review-documents',
  'review-open-pages',
  'rescan-queue',
  'document',
  'document-pages',
  'documents',
  'case',
  'case-pages',
  'case-documents',
  'cases',
  'completeness',
  'diagnoses',
  'diagnosis',
] as const;

export function refreshPageState(queryClient: QueryClient): void {
  for (const key of PAGE_STATE_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
