/**
 * Upload a rescan to stand in for an existing page.
 *
 * This is the step that closes the rescan loop: a reviewer asks for a rescan, someone re-scans the
 * sheet, and the new capture is attached here. The previous version is not deleted — it is kept in
 * history and stops being counted, so "what did the original look like" stays answerable, which is
 * the whole reason a patient record keeps versions at all.
 *
 * The replacement is analysed from scratch in the background. That is why this dialog reports
 * "queued for scanning" rather than a verdict: the quality result does not exist yet, and showing
 * the old page's verdict next to the new image would be worse than showing none.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatBytes } from '../lib/status';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { Button } from './ui';

const CLIENT_MAX_BYTES = 50 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/tiff', 'image/webp', 'application/pdf'];

export function ReplacePageDialog({
  pageVersionId,
  pageLabel,
  open,
  onClose,
  onReplaced,
}: {
  pageVersionId: string;
  /** Something the user recognises, e.g. "Page 7 of case-sheet.pdf". */
  pageLabel: string;
  open: boolean;
  onClose: () => void;
  onReplaced?: (newPageVersionId: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);

  const replace = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose the rescanned file first.');
      return api.replacePage(pageVersionId, file);
    },
    onSuccess: (result) => {
      // Everything that counted the old version is now wrong: the queues, the page itself, the
      // document's page list and the dashboard totals.
      queryClient.invalidateQueries({ queryKey: ['page'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      queryClient.invalidateQueries({ queryKey: ['rescan-queue'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.push(
        `Replaced — this is now version ${result.version_no}. It has been queued for scanning; ` +
          'the quality result will appear once it finishes.',
        'success',
      );
      setFile(null);
      onClose();
      onReplaced?.(result.page_version_id);
    },
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'The replacement could not be saved.', 'error'),
  });

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (f.size === 0) {
      toast.push('That file is empty (0 bytes).', 'error');
      return;
    }
    if (f.size > CLIENT_MAX_BYTES) {
      toast.push(
        `${formatBytes(f.size)} exceeds the ${formatBytes(CLIENT_MAX_BYTES)} limit for a single page.`,
        'error',
      );
      return;
    }
    if (f.type && !ACCEPTED.includes(f.type)) {
      toast.push(`"${f.type}" is not accepted. Upload an image or a single-page PDF.`, 'error');
      return;
    }
    setFile(f);
  };

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Replace with a rescan"
      description="The current version is kept in history and stops being counted. The new one is scanned from scratch."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={replace.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file || replace.isPending} onClick={() => replace.mutate()}>
            {replace.isPending ? 'Uploading…' : 'Replace page'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">
        Replacing <span className="font-medium text-ink">{pageLabel}</span>.
      </p>

      <label className="block">
        <span className="text-[13px] font-medium text-ink">Rescanned file</span>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.tif,.tiff,.webp,.pdf"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          className="mt-1 block w-full cursor-pointer text-[13px] file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-chart file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-paper hover:file:bg-chart/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      </label>

      {file ? (
        <p className="mt-2 text-[13px] text-ink">
          {file.name} <span className="text-ink-2">({formatBytes(file.size)})</span>
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-ink-2">
          An image, or a PDF containing just this one page. Maximum {formatBytes(CLIENT_MAX_BYTES)}.
        </p>
      )}
    </Modal>
  );
}
