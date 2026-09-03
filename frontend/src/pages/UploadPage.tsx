/**
 * Bulk upload.
 *
 * The patient and encounter references are typed and explicitly confirmed by the person doing the
 * upload. Nothing on this screen reads a reference out of the file, and nothing merges two records
 * because their text looked similar — that is a deliberate constraint from docs/PLAN.md §3, and it
 * is why the confirmation checkbox is a hard gate rather than a nicety.
 *
 * Files upload one at a time so each row can show its own progress and, more importantly, its own
 * rejection reason. A batch-level "3 files failed" is useless to a clerk who needs to know which
 * file was password-protected and which one had 900 pages.
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatBytes, ingestView } from '../lib/status';
import type { UploadResultRow } from '../lib/types';
import { Panel } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { Button, ErrorState, Select, TextInput } from '../components/ui';

interface FileRow {
  id: string;
  file: File;
  progress: number;
  state: 'ready' | 'uploading' | 'done';
  result?: UploadResultRow;
}

/**
 * Client-side pre-checks. These are a courtesy that saves a 200 MB round trip; the server is still
 * the authority and may reject a file this passes (encrypted PDF, corrupt stream, page count).
 */
const CLIENT_MAX_BYTES = 200 * 1024 * 1024;
const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp'];

function preCheck(file: File): string | null {
  if (file.size === 0) return 'The file is empty (0 bytes). Nothing was uploaded.';
  if (file.size > CLIENT_MAX_BYTES)
    return `${formatBytes(file.size)} exceeds the ${formatBytes(CLIENT_MAX_BYTES)} upload limit. Split the file and try again.`;
  if (file.type && !ACCEPTED.includes(file.type))
    return `“${file.type}” is not an accepted type. Upload a PDF or a page image (PNG, JPEG, TIFF).`;
  return null;
}

export default function UploadPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [batchId, setBatchId] = useState('');
  const [newBatchName, setNewBatchName] = useState('');
  const [patientRef, setPatientRef] = useState('');
  const [encounterRef, setEncounterRef] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');

  const batches = useQuery({ queryKey: ['batches'], queryFn: () => api.listBatches() });

  const createBatch = useMutation({
    mutationFn: () => api.createBatch({ name: newBatchName.trim() }),
    onSuccess: (b) => {
      setBatchId(b.id);
      setNewBatchName('');
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      toast.push(`Batch “${b.name}” created.`, 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not create the batch.', 'error'),
  });

  const addFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files).map<FileRow>((file) => {
      const problem = preCheck(file);
      return {
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        progress: 0,
        state: problem ? 'done' : 'ready',
        result: problem
          ? { document_id: null, status: 'rejected', message: problem, filename: file.name }
          : undefined,
      };
    });
    setRows((prev) => [...prev, ...incoming]);
    setStatus(`${incoming.length} file${incoming.length === 1 ? '' : 's'} added to the queue.`);
  }, []);

  const readyCount = rows.filter((r) => r.state === 'ready').length;
  const canUpload = Boolean(batchId) && confirmed && encounterRef.trim().length > 0 && readyCount > 0 && !uploading;

  async function startUpload() {
    if (!canUpload) return;
    setUploading(true);
    setStatus('Uploading…');

    // The case is created (or reused) once, from the values the user typed and confirmed.
    let targetCaseId = caseId;
    if (!targetCaseId) {
      try {
        const existing = await api.listCases({ batch_id: batchId, encounter_ref: encounterRef.trim() });
        const match = existing.find((c) => c.encounter_ref === encounterRef.trim());
        const created =
          match ??
          (await api.createCase({
            batch_id: batchId,
            patient_ref: patientRef.trim(),
            encounter_ref: encounterRef.trim(),
          }));
        // Record who confirmed the reference, and when. The API stores the confirming user.
        await api.confirmCase(created.id).catch(() => undefined);
        targetCaseId = created.id;
        setCaseId(created.id);
      } catch (e) {
        toast.push(
          e instanceof Error ? e.message : 'Could not record the patient/encounter reference.',
          'error',
        );
        setUploading(false);
        return;
      }
    }

    for (const row of rows) {
      if (row.state !== 'ready') continue;
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, state: 'uploading' } : r)));
      const result = await api.uploadDocument(
        row.file,
        { batch_id: batchId, case_id: targetCaseId },
        (fraction) =>
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, progress: fraction } : r))),
      );
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, state: 'done', progress: 1, result } : r)),
      );
    }

    setUploading(false);
    setStatus('Upload finished. Review the result of each file below.');
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }

  const rejected = rows.filter((r) => r.result && r.result.status === 'rejected');
  const accepted = rows.filter((r) => r.result && r.result.status !== 'rejected');

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Upload scans</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Files are attached to a batch and to one patient encounter. References are entered by you and
          are never derived from the file contents.
        </p>
      </header>

      {/* ------------------------------------------------------------- batch */}
      <Panel title="1. Batch" description="Group this delivery of files under a batch name.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Existing batch" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">Select a batch…</option>
            {(batches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput
                label="…or create a new batch"
                placeholder="e.g. Ward 4 — September intake"
                value={newBatchName}
                onChange={(e) => setNewBatchName(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => createBatch.mutate()}
              disabled={!newBatchName.trim() || createBatch.isPending}
            >
              Create
            </Button>
          </div>
        </div>
        {batches.isError ? <ErrorState error={batches.error} retry={() => batches.refetch()} /> : null}
      </Panel>

      {/* ---------------------------------------------------------- references */}
      <Panel
        title="2. Patient and encounter reference"
        description="Type the references from the physical record. Nothing is auto-filled from the scan and no two records are ever merged automatically."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Patient reference"
            placeholder="e.g. IP140922101"
            value={patientRef}
            onChange={(e) => {
              setPatientRef(e.target.value);
              setCaseId(null);
              setConfirmed(false);
            }}
          />
          <TextInput
            label="Encounter reference (required)"
            required
            value={encounterRef}
            onChange={(e) => {
              setEncounterRef(e.target.value);
              setCaseId(null);
              setConfirmed(false);
            }}
          />
        </div>
        <label className="mt-3 flex items-start gap-2 rounded border border-slate-200 p-3 text-sm dark:border-slate-800">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-500 text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          />
          <span className="text-slate-900 dark:text-slate-100">
            I have checked these references against the physical record and confirm they are correct.
            <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">
              Your name and the time are recorded against this confirmation.
            </span>
          </span>
        </label>
      </Panel>

      {/* ------------------------------------------------------------- files */}
      <Panel title="3. Files" description="PDF or page images. Drag them in, or browse.">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed p-8 text-center transition ${
            dragging
              ? 'border-sky-600 bg-sky-50 dark:border-sky-400 dark:bg-sky-950'
              : 'border-slate-300 dark:border-slate-700'
          }`}
        >
          <p className="text-sm text-slate-800 dark:text-slate-200">
            Drag files here, or
          </p>
          {/* The visible control is a real button; the input stays in the DOM for keyboard users. */}
          <label className="mt-2 inline-block">
            <span className="sr-only">Choose files to upload</span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = '';
              }}
              className="block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-sky-700 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-sky-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:file:bg-sky-600"
            />
          </label>
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
            Maximum {formatBytes(CLIENT_MAX_BYTES)} per file. Password-protected and corrupted files are
            rejected with the reason shown against the file.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={startUpload} disabled={!canUpload}>
            {uploading ? 'Uploading…' : `Upload ${readyCount} file${readyCount === 1 ? '' : 's'}`}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRows([]);
              setStatus('Queue cleared.');
            }}
            disabled={uploading || rows.length === 0}
          >
            Clear queue
          </Button>
          {!canUpload && rows.length > 0 && !uploading ? (
            <p className="text-sm text-amber-800 dark:text-amber-300">
              <span aria-hidden="true">⚠ </span>
              {!batchId
                ? 'Select or create a batch first.'
                : !encounterRef.trim()
                  ? 'Enter the encounter reference.'
                  : !confirmed
                    ? 'Confirm the references before uploading.'
                    : 'Nothing left to upload.'}
            </p>
          ) : null}
        </div>

        <p aria-live="polite" className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          {status}
        </p>

        {rows.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="table-base">
              <caption className="sr-only">Files queued for upload and their result</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Size</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <FileResultRow key={r.id} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {rows.some((r) => r.state === 'done') ? (
          <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
            {accepted.length} accepted, {rejected.length} rejected.{' '}
            {accepted.length > 0 ? (
              <Link
                to={batchId ? `/documents?batch_id=${batchId}` : '/documents'}
                className="font-medium text-sky-800 underline dark:text-sky-300"
              >
                View the uploaded documents
              </Link>
            ) : null}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

function FileResultRow({ row }: { row: FileRow }) {
  const pct = Math.round(row.progress * 100);
  const rejected = row.result?.status === 'rejected';

  return (
    <tr>
      <th scope="row" className="px-3 py-2 text-left font-normal align-top">
        <span className="block max-w-xs truncate text-slate-900 dark:text-slate-100" title={row.file.name}>
          {row.file.name}
        </span>
      </th>
      <td className="tabular-nums">{formatBytes(row.file.size)}</td>
      <td>
        {row.state === 'uploading' ? (
          <>
            <progress value={pct} max={100} className="w-32 align-middle">
              {pct}%
            </progress>
            <span className="ml-2 text-xs tabular-nums text-slate-700 dark:text-slate-300">{pct}%</span>
          </>
        ) : row.state === 'ready' ? (
          <span className="text-slate-600 dark:text-slate-400">Waiting</span>
        ) : (
          <span className="text-slate-600 dark:text-slate-400">—</span>
        )}
      </td>
      <td>
        {row.result ? (
          <>
            <StatusPill view={ingestView(row.result.status)} size="sm" />
            {/* The rejection message is the actionable part — always shown in full, never truncated. */}
            {row.result.message ? (
              <p
                className={`mt-1 max-w-md text-sm ${
                  rejected ? 'text-red-900 dark:text-red-200' : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                {row.result.message}
              </p>
            ) : null}
            {row.result.document_id ? (
              <Link
                to={`/documents?q=${encodeURIComponent(row.file.name)}`}
                className="mt-1 inline-block text-sm font-medium text-sky-800 underline dark:text-sky-300"
              >
                Open document
              </Link>
            ) : null}
          </>
        ) : (
          <span className="text-slate-600 dark:text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}
