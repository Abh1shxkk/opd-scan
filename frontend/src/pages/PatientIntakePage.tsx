/**
 * Patient intake — enter the patient's details and attach their documents in one submit.
 *
 * Mirrors the paper/legacy form section by section (Basic Information, Patient Details, Medical
 * Information, Admission Details, Document Upload) so someone moving over from the old system does
 * not have to relearn where anything lives.
 *
 * Two deliberate behaviours:
 *
 * - Nothing here is filled in from a scan. Every value is typed by the person holding the file, and
 *   an empty field stays empty rather than being guessed at from OCR later.
 * - The MR lookup prefills from the patient's last visit, but only into editable fields. It is a
 *   convenience, never an assertion — whatever is submitted is what the clerk left on screen.
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes } from '../lib/status';
import type { IntakeFormValues, IntakeResponse, UploadResultRow } from '../lib/types';
import { Panel } from '../components/StatTile';
import { useToast } from '../components/Toast';
import { Button, ErrorState, Select, TextInput } from '../components/ui';

const EMPTY: IntakeFormValues = {
  mr_number: '',
  ipd_number: '',
  patient_name: '',
  department: '',
  mobile: '',
  disease: '',
  icd_code: '',
  consultant_name: '',
  discharge_type: '',
  mlc_type: '',
  admission_date: '',
  discharge_date: '',
};

const CLIENT_MAX_BYTES = 200 * 1024 * 1024;

export default function PatientIntakePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<IntakeFormValues>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<IntakeResponse | null>(null);

  const options = useQuery({
    queryKey: ['intake', 'options'],
    queryFn: () => api.getIntakeOptions(),
  });

  const set = useCallback(
    <K extends keyof IntakeFormValues>(key: K, value: IntakeFormValues[K]) =>
      setForm((f) => ({ ...f, [key]: value })),
    [],
  );

  const lookup = useMutation({
    mutationFn: (mr: string) => api.lookupMrNumber(mr),
    onSuccess: (data) => {
      if (!data.found || !data.case) {
        toast.push('No earlier record for that MR number. Enter the details below.', 'info');
        return;
      }
      const c = data.case;
      // Only the patient's standing details are prefilled. The admission-specific fields
      // (IPD number, dates, discharge type) deliberately are not: carrying a previous
      // admission's values into a new one is how wrong dates end up on a record.
      setForm((f) => ({
        ...f,
        patient_name: c.patient_name || f.patient_name,
        mobile: c.mobile || f.mobile,
        department: c.department || f.department,
        consultant_name: c.consultant_name || f.consultant_name,
      }));
      toast.push('Filled in from this patient’s last visit. Check every field before saving.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Lookup failed.', 'error'),
  });

  const submit = useMutation({
    mutationFn: () => {
      setProgress(0);
      return api.submitIntake(form, files, setProgress);
    },
    onSuccess: (data) => {
      setResult(data);
      setForm(EMPTY);
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      const rejected = data.documents.filter((d) => d.status === 'rejected').length;
      toast.push(
        rejected > 0
          ? `Record saved, but ${rejected} file${rejected === 1 ? '' : 's'} could not be accepted.`
          : 'Record saved and documents queued for scanning.',
        rejected > 0 ? 'error' : 'success',
      );
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'The record could not be saved.', 'error'),
  });

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const chosen = Array.from(list);
    const tooBig = chosen.find((f) => f.size > CLIENT_MAX_BYTES);
    if (tooBig) {
      toast.push(`${tooBig.name} is ${formatBytes(tooBig.size)} — the limit is ${formatBytes(CLIENT_MAX_BYTES)}.`, 'error');
      return;
    }
    const empty = chosen.find((f) => f.size === 0);
    if (empty) {
      toast.push(`${empty.name} is empty (0 bytes).`, 'error');
      return;
    }
    setFiles(chosen);
  };

  const canSubmit = form.mr_number.trim().length > 0 && !submit.isPending;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">New file upload</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Enter the patient’s details and attach their documents. Everything uploaded here is
          scanned and quality-checked automatically.
        </p>
      </header>

      {submit.isError ? <ErrorState error={submit.error} retry={() => submit.mutate()} /> : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit.mutate();
        }}
        className="space-y-4"
      >
        {/* ------------------------------------------------ basic information */}
        <Panel title="Basic information">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextInput label="Date" value={new Date().toLocaleDateString('en-GB')} readOnly disabled />
            <TextInput label="Uploader name" value={user?.full_name || user?.email || ''} readOnly disabled />

            <div>
              <label className="block text-sm font-medium text-slate-800 dark:text-slate-200" htmlFor="mr">
                MR number <span className="text-red-700 dark:text-red-400">*</span>
              </label>
              <div className="mt-1 flex gap-1.5">
                <input
                  id="mr"
                  value={form.mr_number}
                  onChange={(e) => set('mr_number', e.target.value)}
                  placeholder="Enter MR number"
                  required
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!form.mr_number.trim() || lookup.isPending}
                  onClick={() => lookup.mutate(form.mr_number.trim())}
                  title="Look up this patient's previous visit"
                >
                  {lookup.isPending ? '…' : 'Find'}
                </Button>
              </div>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Find fills in details from the last visit. Always check them.
              </p>
            </div>

            <TextInput
              label="IPD number"
              value={form.ipd_number}
              onChange={(e) => set('ipd_number', e.target.value)}
              placeholder="Enter IPD number"
              hint="Leave blank for an OPD visit."
            />
          </div>
        </Panel>

        {/* --------------------------------------------------- patient details */}
        <Panel title="Patient details">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextInput
              label="Patient's name"
              value={form.patient_name}
              onChange={(e) => set('patient_name', e.target.value)}
              placeholder="Enter patient name"
            />
            <Select label="Department" value={form.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">Select department</option>
              {(options.data?.departments ?? []).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
            <TextInput
              label="Mobile number"
              value={form.mobile}
              onChange={(e) => set('mobile', e.target.value)}
              placeholder="Enter 10-digit mobile number"
              inputMode="numeric"
            />
          </div>
        </Panel>

        {/* ------------------------------------------------ medical information */}
        <Panel title="Medical information">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextInput
              label="Disease"
              value={form.disease}
              onChange={(e) => set('disease', e.target.value)}
              placeholder="Enter disease"
            />
            <TextInput
              label="ICD code"
              value={form.icd_code}
              onChange={(e) => set('icd_code', e.target.value)}
              placeholder="Enter ICD code"
            />
            <TextInput
              label="Consultant's name"
              value={form.consultant_name}
              onChange={(e) => set('consultant_name', e.target.value)}
              placeholder="Enter consultant's name"
            />
            <Select
              label="Discharge type"
              value={form.discharge_type}
              onChange={(e) => set('discharge_type', e.target.value)}
            >
              <option value="">Select discharge type</option>
              {(options.data?.discharge_types ?? []).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
            <Select label="MLC type" value={form.mlc_type} onChange={(e) => set('mlc_type', e.target.value)}>
              <option value="">Select MLC type</option>
              {(options.data?.mlc_types ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </div>
        </Panel>

        {/* ------------------------------------------------- admission details */}
        <Panel title="Admission details">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextInput
              label="Date of admission"
              type="date"
              value={form.admission_date}
              onChange={(e) => set('admission_date', e.target.value)}
            />
            <TextInput
              label="Date of discharge"
              type="date"
              value={form.discharge_date}
              onChange={(e) => set('discharge_date', e.target.value)}
            />
          </div>
        </Panel>

        {/* --------------------------------------------------- document upload */}
        <Panel title="Document upload" description="PDFs or photos of the patient's records.">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp"
            onChange={(e) => pickFiles(e.target.files)}
            className="block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-sky-700 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-sky-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:file:bg-sky-600"
          />
          {files.length > 0 ? (
            <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="truncate text-slate-800 dark:text-slate-200">{f.name}</span>
                  <span className="shrink-0 text-xs text-slate-600 dark:text-slate-400">{formatBytes(f.size)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              No files chosen. The record can be saved without documents and files added later.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            Maximum {formatBytes(CLIENT_MAX_BYTES)} per file.
          </p>
        </Panel>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {submit.isPending ? 'Saving…' : 'Save record'}
          </Button>
          {submit.isPending ? (
            <span className="text-xs text-slate-600 dark:text-slate-400">
              {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Saving and queueing for scan…'}
            </span>
          ) : null}
          {!form.mr_number.trim() ? (
            <span className="text-xs text-slate-600 dark:text-slate-400">An MR number is required.</span>
          ) : null}
        </div>
      </form>

      {result ? <IntakeResult result={result} onOpen={(id) => navigate(`/documents?case_id=${id}`)} /> : null}
    </div>
  );
}

function IntakeResult({ result, onOpen }: { result: IntakeResponse; onOpen: (caseId: string) => void }) {
  const c = result.case;
  return (
    <Panel title="Saved" description={`MR ${c.patient_ref}${c.encounter_ref !== c.patient_ref ? ` · IPD ${c.encounter_ref}` : ''}`}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Field label="Patient" value={c.patient_name} />
        <Field label="Department" value={c.department} />
        <Field label="Consultant" value={c.consultant_name} />
        <Field label="Documents on this record" value={String(c.document_count)} />
      </dl>

      {result.documents.length > 0 ? (
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {result.documents.map((d, i) => (
            <DocumentRow key={`${d.filename}-${i}`} row={d} />
          ))}
        </ul>
      ) : null}

      <div className="mt-3">
        <Button variant="secondary" onClick={() => onOpen(c.id)}>
          View this patient’s documents
        </Button>
      </div>
    </Panel>
  );
}

function DocumentRow({ row }: { row: UploadResultRow }) {
  const tone =
    row.status === 'rejected'
      ? 'text-red-800 dark:text-red-300'
      : row.status === 'duplicate'
        ? 'text-amber-800 dark:text-amber-300'
        : 'text-emerald-800 dark:text-emerald-300';
  return (
    <li className="py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-slate-800 dark:text-slate-200">{row.filename}</span>
        <span className={`shrink-0 text-xs font-medium ${tone}`}>{row.status}</span>
      </div>
      {row.message ? (
        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{row.message}</p>
      ) : null}
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="text-slate-900 dark:text-slate-100">{value || '—'}</dd>
    </div>
  );
}
