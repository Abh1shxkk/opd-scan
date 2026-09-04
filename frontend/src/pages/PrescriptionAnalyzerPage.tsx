/**
 * Standalone prescription analyzer — landing view.
 *
 * Deliberately not the scan-QC upload flow: no batch, no case, no patient reference, no waiting for
 * a background job and coming back later. Pick a file, click Analyse, and the finished reading opens
 * on its own page — usually 20-60s, since it is a real OCR call followed by a real LLM call, not a
 * cached demo.
 *
 * This screen itself only does two things: take a new upload, and list past ones (a CRUD-style
 * index) so a previous reading can be reopened without re-uploading. The actual reading is shown on
 * PrescriptionResultPage.
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/status';
import { Panel } from '../components/StatTile';
import { useToast } from '../components/Toast';
import { Button, ErrorState } from '../components/ui';

const CLIENT_MAX_BYTES = 200 * 1024 * 1024;
const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp'];

function preCheck(file: File): string | null {
  if (file.size === 0) return 'The file is empty (0 bytes).';
  if (file.size > CLIENT_MAX_BYTES) return `${formatBytes(file.size)} exceeds the ${formatBytes(CLIENT_MAX_BYTES)} limit.`;
  if (file.type && !ACCEPTED.includes(file.type))
    return `"${file.type}" is not accepted. Upload a photo (PNG/JPEG) or a PDF.`;
  return null;
}

export default function PrescriptionAnalyzerPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);

  const recent = useQuery({
    queryKey: ['prescriptions', 'recent'],
    queryFn: () => api.listRecentPrescriptionAnalyses(),
  });

  const pickFile = useCallback((f: File) => {
    const problem = preCheck(f);
    if (problem) {
      toast.push(problem, 'error');
      return;
    }
    setFile(f);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
    });
  }, [toast]);

  const analyze = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose a file first.');
      setProgress(0);
      return api.analyzePrescription(file, setProgress);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['prescriptions', 'recent'] });
      toast.push('Analysis complete.', 'success');
      navigate(`/prescriptions/${data.document_id}`);
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'The analysis failed.', 'error'),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Prescription analyzer</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Upload a photo or PDF of a handwritten prescription. This is an AI-assisted reading, not a
          diagnosis and not medical advice — see the disclaimer with every result.
        </p>
      </header>

      <Panel title="Upload" description="A photo (PNG/JPEG) or a PDF of one prescription.">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.[0]) pickFile(e.dataTransfer.files[0]);
          }}
          className={`rounded-lg border-2 border-dashed p-8 text-center transition ${
            dragging
              ? 'border-sky-600 bg-sky-50 dark:border-sky-400 dark:bg-sky-950'
              : 'border-slate-300 dark:border-slate-700'
          }`}
        >
          {previewUrl ? (
            <img src={previewUrl} alt="Prescription preview" className="mx-auto mb-3 max-h-64 rounded-lg border border-slate-200 dark:border-slate-800" />
          ) : file ? (
            <p className="mb-3 text-sm text-slate-800 dark:text-slate-200">{file.name} ({formatBytes(file.size)})</p>
          ) : null}

          <p className="text-sm text-slate-800 dark:text-slate-200">Drag a file here, or</p>
          <label className="mt-2 inline-block">
            <span className="sr-only">Choose a prescription file</span>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp"
              onChange={(e) => {
                if (e.target.files?.[0]) pickFile(e.target.files[0]);
                e.target.value = '';
              }}
              className="block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-sky-700 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-sky-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:file:bg-sky-600"
            />
          </label>
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
            Maximum {formatBytes(CLIENT_MAX_BYTES)}.
          </p>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" disabled={!file || analyze.isPending} onClick={() => analyze.mutate()}>
            {analyze.isPending ? 'Analysing…' : 'Analyse prescription'}
          </Button>
          {analyze.isPending ? (
            <span className="text-xs text-slate-600 dark:text-slate-400">
              {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Reading and interpreting — this can take up to a minute.'}
            </span>
          ) : null}
        </div>
      </Panel>

      {analyze.isError ? <ErrorState error={analyze.error} retry={() => analyze.mutate()} /> : null}

      <Panel title="Previous uploads" description="Every prescription analysed so far. Open one to see its reading.">
        {recent.isLoading ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">Loading…</p>
        ) : recent.data && recent.data.length > 0 ? (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {recent.data.map((r) => (
              <li key={r.document_id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => navigate(`/prescriptions/${r.document_id}`)}
                    className="truncate text-sm font-medium text-sky-800 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-sky-300"
                  >
                    {r.original_filename}
                  </button>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {formatDateTime(r.uploaded_at)} · {r.page_count} page{r.page_count === 1 ? '' : 's'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-700 dark:text-slate-300">No prescriptions analysed yet.</p>
        )}
      </Panel>
    </div>
  );
}
