/**
 * Standalone prescription analyzer.
 *
 * Deliberately not the scan-QC upload flow: no batch, no case, no patient reference, no waiting for
 * a background job and coming back later. Pick a file, click Analyse, and the finished reading comes
 * back in the same request — usually 20-60s, since it is a real OCR call followed by a real LLM
 * call, not a cached demo.
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatBytes, formatDateTime, MEDICINE_CONFIDENCE_LABEL, prescriptionView } from '../lib/status';
import type { PrescriptionAnalysisPage, PrescriptionAnalysisResponse } from '../lib/types';
import { Panel } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
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
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<PrescriptionAnalysisResponse | null>(null);

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
    setResult(null);
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
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ['prescriptions', 'recent'] });
      toast.push('Analysis complete.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'The analysis failed.', 'error'),
  });

  const openPrevious = useMutation({
    mutationFn: (documentId: string) => api.getPrescriptionAnalysis(documentId),
    onSuccess: (data) => {
      setResult(data);
      setFile(null);
      setPreviewUrl(null);
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not load that analysis.', 'error'),
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

      <Panel title="1. Upload" description="A photo (PNG/JPEG) or a PDF of one prescription.">
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

      {result ? (
        <Panel title="2. Result" description={result.original_filename}>
          <div className="space-y-6">
            {result.pages.map((p) => (
              <PrescriptionPageResult key={p.page_version_id} page={p} multi={result.pages.length > 1} />
            ))}
          </div>
        </Panel>
      ) : null}

      {recent.data && recent.data.length > 0 ? (
        <Panel title="Recent uploads" description="Re-open a previous analysis without re-uploading.">
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {recent.data.map((r) => (
              <li key={r.document_id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openPrevious.mutate(r.document_id)}
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
        </Panel>
      ) : null}
    </div>
  );
}

function PrescriptionPageResult({ page, multi }: { page: PrescriptionAnalysisPage; multi: boolean }) {
  const p = page.prescription;

  return (
    <div className={multi ? 'border-t border-slate-200 pt-4 first:border-t-0 first:pt-0 dark:border-slate-800' : ''}>
      {multi ? (
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Page {page.ordinal}</h3>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill view={prescriptionView(p?.status)} showDetail />
        {p?.language_detected ? (
          <span className="text-xs text-slate-600 dark:text-slate-400">Language: {p.language_detected}</span>
        ) : null}
      </div>

      {!p ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">No result for this page.</p>
      ) : p.error ? (
        <p className="text-sm text-red-800 dark:text-red-300">{p.error}</p>
      ) : (
        <div className="space-y-4">
          {p.requires_professional_confirmation ? (
            <p className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
              <span aria-hidden="true">⚠ </span>
              This reading has parts that are uncertain. Confirm every medicine, dose and instruction
              with the prescribing doctor or a pharmacist before acting on it.
            </p>
          ) : null}

          {p.safety_warnings.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-red-800 dark:text-red-300">
              {p.safety_warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}

          {p.medicines.length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Medicines</h4>
              <ul className="mt-1 space-y-2">
                {p.medicines.map((m, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {m.name || 'Unreadable name'}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          m.confidence === 'high'
                            ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
                            : m.confidence === 'medium'
                              ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
                              : 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100'
                        }`}
                      >
                        {MEDICINE_CONFIDENCE_LABEL[m.confidence] ?? m.confidence}
                      </span>
                    </div>
                    <dl className="mt-1 grid grid-cols-3 gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <div><dt className="text-slate-500 dark:text-slate-400">Dose</dt><dd>{m.dose || '—'}</dd></div>
                      <div><dt className="text-slate-500 dark:text-slate-400">Frequency</dt><dd>{m.frequency || '—'}</dd></div>
                      <div><dt className="text-slate-500 dark:text-slate-400">Duration</dt><dd>{m.duration || '—'}</dd></div>
                    </dl>
                    {m.general_use ? (
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Generally used for: {m.general_use}</p>
                    ) : null}
                    {m.uncertainty ? (
                      <p className="mt-1 text-xs italic text-amber-800 dark:text-amber-300">Uncertain: {m.uncertainty}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : p.status === 'extracted_pending_review' ? (
            <p className="text-sm text-slate-700 dark:text-slate-300">No medicines were read on this page.</p>
          ) : null}

          {p.possible_interpretation ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Possible interpretation</h4>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{p.possible_interpretation}</p>
            </div>
          ) : null}

          {p.patient_explanation ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">In plain language</h4>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{p.patient_explanation}</p>
            </div>
          ) : null}

          {p.uncertainties.length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Unclear or unreadable</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-300">
                {p.uncertainties.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-300">
              Raw OCR text (exact, unedited)
            </summary>
            <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-slate-800 dark:text-slate-200">
              {p.raw_extracted_text || '(no text was transcribed)'}
            </p>
          </details>

          <p className="border-t border-slate-200 pt-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
            This reading is AI-generated and may contain errors, especially for handwriting. It is not
            a diagnosis and does not replace advice from the prescribing doctor or a pharmacist. Never
            start, stop, or change a medication based only on this reading.
          </p>
        </div>
      )}
    </div>
  );
}
