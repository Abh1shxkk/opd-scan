/**
 * Patient records.
 *
 * The way into the archive, by the thing a clerk actually starts from: a person, not a file. Each
 * row is one patient/admission with everything the intake form captured, and its actions lead to
 * the work already attached to that record — the scan with its quality verdict, handwriting and
 * diagnosis, and the wider document list when a case has more than one file.
 *
 * Two boundaries are deliberate and enforced by the API, not just hidden here:
 *
 *  - The MR and IPD numbers are shown but never editable. They identify the case, and rewriting
 *    an identity in place is how one patient's pages end up filed under another's. A wrong number
 *    is corrected by deleting the record and re-entering it.
 *  - Deleting is admin-only and takes the case's documents, pages, scan versions and analyses
 *    with it. The dialog says so in those words, and requires the IPD number typed back.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, FileText, Pencil, ScanEye, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/status';
import type { Case, CasePatch } from '../lib/types';
import { ChartHead, MarginNote, Panel } from '../components/Sheet';
import { isWorking, ProcessingState } from '../components/ProcessingState';
import { Modal } from '../components/Modal';
import { Pager, pageParams } from '../components/Pager';
import { useToast } from '../components/Toast';
import { Button, EmptyState, ErrorState, Select, Spinner, TextInput } from '../components/ui';

/** A date the API may not have. Rendered as an absence, never as a guess. */
function DateCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-2">—</span>;
  return <span className="tabular-nums">{value}</span>;
}

/** A human-entered field that was left blank. Blank means "not recorded". */
function Text({ value }: { value: string }) {
  if (!value) return <span className="text-ink-2">—</span>;
  return <>{value}</>;
}

export default function PatientsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [mr, setMr] = useState('');
  const [ipd, setIpd] = useState('');
  // When the record was entered, in the clerk's local time. Filtered here rather than on the API:
  // the list is already fetched whole, and "the 17th" means the local day, not the UTC one.
  const [day, setDay] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [editing, setEditing] = useState<Case | null>(null);
  const [deleting, setDeleting] = useState<Case | null>(null);

  const [page, setPage] = useState(1);

  // The chosen day and times are the clerk's local time; the API compares UTC instants.
  const entryWindow = useMemo(() => {
    if (!day) return {};
    return {
      created_from: new Date(`${day}T${fromTime || '00:00'}:00`).toISOString(),
      created_to: new Date(`${day}T${toTime || '23:59'}:59.999`).toISOString(),
    };
  }, [day, fromTime, toTime]);

  const q = useQuery({
    queryKey: ['cases', 'paged', mr, ipd, entryWindow, page],
    queryFn: () =>
      api.listCasesPaged({
        patient_ref: mr.trim() || undefined,
        encounter_ref: ipd.trim() || undefined,
        ...entryWindow,
        ...pageParams(page),
      }),
    placeholderData: (prev) => prev,
    // The analysis runs on a worker, so the list refreshes itself while anything is outstanding
    // and then stops. Polling a settled archive forever would be a request per clerk per 4s for
    // no new information.
    refetchInterval: (query) => ((query.state.data?.items ?? []).some(isWorking) ? 4000 : false),
  });

  const dateFiltered = Boolean(day);
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const matching = q.data?.total ?? 0;
  const withScans = useMemo(() => rows.filter((c) => c.page_count > 0).length, [rows]);
  const working = useMemo(() => rows.filter(isWorking).length, [rows]);

  return (
    <div className="space-y-3">
      <ChartHead
        title="Patient records"
        description="Every record entered on the intake screen. Open one to read its scan, its quality verdict and anything the machine read from it."
        meta={[
          {
            label: 'Total records',
            value: <span className="tabular-nums">{q.data ? q.data.grand_total : '…'}</span>,
          },
          {
            label: day ? `Entered on ${day}` : 'Matching records',
            value: <span className="tabular-nums">{matching}</span>,
          },
          { label: 'With scans attached', value: <span className="tabular-nums">{withScans}</span> },
          {
            label: 'Still processing',
            value:
              working === 0 ? (
                <span className="text-ink-2">Nothing outstanding</span>
              ) : (
                <span className="tabular-nums text-chart">{working} in progress</span>
              ),
          },
          {
            label: 'Identifiers',
            value: 'MR and IPD numbers are fixed after entry',
          },
          {
            label: 'New record',
            value: (
              <Link to="/intake" className="font-medium text-chart underline">
                New file upload
              </Link>
            ),
          },
        ]}
      />

      <Panel
        title="Find a record"
        description="MR and IPD match on any part of the number. Date and time filter on when the record was entered — choose a date first, then optionally a time range."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <TextInput
            label="MR number"
            value={mr}
            placeholder="e.g. 201409221237"
            onChange={(e) => {
              setMr(e.target.value);
              setPage(1);
            }}
          />
          <TextInput
            label="IPD number"
            value={ipd}
            placeholder="e.g. IP.140922103"
            onChange={(e) => {
              setIpd(e.target.value);
              setPage(1);
            }}
          />
          <TextInput
            label="Entered on"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              setPage(1);
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              label="From time"
              type="time"
              disabled={!day}
              value={fromTime}
              onChange={(e) => {
              setFromTime(e.target.value);
              setPage(1);
            }}
            />
            <TextInput
              label="To time"
              type="time"
              disabled={!day}
              value={toTime}
              onChange={(e) => {
              setToTime(e.target.value);
              setPage(1);
            }}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={() => {
                setMr('');
                setIpd('');
                setDay('');
                setFromTime('');
                setToTime('');
                setPage(1);
              }}
              disabled={!mr && !ipd && !dateFiltered}
            >
              Clear
            </Button>
          </div>
        </div>
      </Panel>

      {q.isLoading ? <Spinner label="Loading patient records…" /> : null}
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : null}

      <Pager page={page} total={q.data?.total} count={rows.length} onPage={setPage} />

      {q.data ? (
        <Panel
          title="Records"
          description="A record with no scan attached is not an error — the details can be entered before the documents arrive."
          flush
        >
          {rows.length === 0 ? (
            <div className="p-3">
              <EmptyState title="No patient records match this view.">
                Enter one on the <Link to="/intake" className="text-chart underline">intake screen</Link>.
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Patient</th>
                    <th scope="col">Clinical</th>
                    <th scope="col">Dates</th>
                    <th scope="col" className="text-right">
                      Scans
                    </th>
                    <th scope="col">Processing</th>
                    {/* Sticky, so the actions stay reachable when the table scrolls sideways —
                        an action column you have to scroll to find is an action nobody takes. */}
                    <th scope="col" className="sticky right-0 z-20 bg-paper-3">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="group/row">
                      <td className="whitespace-nowrap">
                        <span className="block font-medium tabular-nums text-ink">
                          {c.patient_ref}
                        </span>
                        <span className="mt-0.5 block text-[11px] tabular-nums text-ink-2">
                          IPD {c.encounter_ref}
                        </span>
                      </td>

                      <td className="min-w-[10rem]">
                        <span className="block text-ink">
                          <Text value={c.patient_name} />
                        </span>
                        <span className="mt-0.5 block text-[11px] text-ink-2">
                          <Text value={c.department} />
                          {c.mobile ? ` · ${c.mobile}` : ''}
                        </span>
                      </td>

                      <td className="min-w-[12rem] max-w-[20rem]">
                        <span className="block truncate text-ink">
                          <Text value={c.disease} />
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-ink-2">
                          <Text value={c.consultant_name} />
                          {c.icd_code ? ` · ICD ${c.icd_code}` : ''}
                          {c.discharge_type ? ` · ${c.discharge_type}` : ''}
                          {c.mlc_type ? ` · MLC ${c.mlc_type}` : ''}
                        </span>
                      </td>

                      <td className="whitespace-nowrap text-[11px]">
                        <span className="block">
                          <span className="text-ink-2">Adm </span>
                          <DateCell value={c.admission_date} />
                          <span className="text-ink-2"> · Dis </span>
                          <DateCell value={c.discharge_date} />
                        </span>
                        <span className="mt-0.5 block">
                          <span className="text-ink-2">Recorded </span>
                          <DateCell value={c.record_date} />
                        </span>
                        <span className="mt-0.5 block">
                          <span className="text-ink-2">Entered </span>
                          <span className="tabular-nums">{c.created_at ? formatDateTime(c.created_at) : '—'}</span>
                        </span>
                      </td>

                      <td className="whitespace-nowrap text-right tabular-nums">
                        <span className="block text-ink">{c.page_count} pages</span>
                        <span className="mt-0.5 block text-[11px] text-ink-2">
                          {c.document_count} file{c.document_count === 1 ? '' : 's'}
                        </span>
                      </td>

                      <td className="min-w-[10rem]">
                        <ProcessingState record={c} />
                      </td>

                      <td className="sticky right-0 z-10 whitespace-nowrap bg-paper group-hover/row:bg-paper-2 group-[:nth-child(even)]/row:bg-paper-2">
                        <div className="flex items-center gap-1">
                          {c.first_page_version_id ? (
                            <Link
                              to={`/pages/${c.first_page_version_id}`}
                              title="Open the scan, its quality verdict, handwriting and diagnosis"
                              className="inline-flex min-h-[26px] items-center gap-1 border border-chart bg-chart px-2 font-label text-[11px] font-semibold uppercase tracking-label text-paper transition-colors duration-150 ease-chart hover:bg-chart/90"
                            >
                              <ScanEye size={12} strokeWidth={2.5} aria-hidden="true" />
                              Open scan
                            </Link>
                          ) : (
                            <span
                              className="inline-flex min-h-[26px] items-center border border-rule-2 bg-paper-2 px-2 font-label text-[11px] font-semibold uppercase tracking-label text-ink-2"
                              title="No scan is attached to this record yet"
                            >
                              No scan yet
                            </span>
                          )}

                          {c.document_count > 1 ? (
                            <Link
                              to={`/documents?case_id=${encodeURIComponent(c.id)}`}
                              title={`All ${c.document_count} files filed under this record`}
                              className="inline-flex min-h-[26px] items-center border border-rule-2 bg-paper-2 px-2 font-label text-[11px] font-semibold uppercase tracking-label text-ink transition-colors duration-150 ease-chart hover:bg-paper-3"
                            >
                              <FileStack size={12} strokeWidth={2.5} aria-hidden="true" />
                            </Link>
                          ) : null}

                          <Link
                            to={`/patients/${c.id}`}
                            title="All of this patient's details, their files, and every page"
                            className="inline-flex min-h-[26px] items-center gap-1 border border-rule-2 bg-paper-2 px-2 font-label text-[11px] font-semibold uppercase tracking-label text-ink transition-colors duration-150 ease-chart hover:bg-paper-3"
                          >
                            <FileText size={12} strokeWidth={2.5} aria-hidden="true" />
                            Details
                          </Link>

                          <Button
                            variant="secondary"
                            onClick={() => setEditing(c)}
                            title="Edit this record's details"
                            aria-label={`Edit ${c.patient_ref}`}
                            className="min-h-[26px] px-2"
                          >
                            <Pencil size={12} strokeWidth={2.5} aria-hidden="true" />
                          </Button>

                          {can('admin') ? (
                            <Button
                              variant="danger"
                              onClick={() => setDeleting(c)}
                              title="Delete this record and everything filed under it"
                              aria-label={`Delete ${c.patient_ref}`}
                              className="min-h-[26px] px-2"
                            >
                              <Trash2 size={12} strokeWidth={2.5} aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {editing ? (
        <EditCaseDialog
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['cases'] });
            toast.push('Patient record updated.', 'success');
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteCaseDialog
          record={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            qc.invalidateQueries({ queryKey: ['cases'] });
            toast.push('Patient record deleted.', 'success');
          }}
        />
      ) : null}
    </div>
  );
}

/** The editable subset of a record. Identifiers are shown as fixed context, not as inputs. */
function EditCaseDialog({
  record,
  onClose,
  onSaved,
}: {
  record: Case;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const options = useQuery({
    queryKey: ['intake-options'],
    queryFn: () => api.getIntakeOptions(),
    staleTime: 300_000,
  });

  const [form, setForm] = useState<CasePatch>({
    patient_name: record.patient_name,
    department: record.department,
    mobile: record.mobile,
    disease: record.disease,
    icd_code: record.icd_code,
    consultant_name: record.consultant_name,
    discharge_type: record.discharge_type,
    mlc_type: record.mlc_type,
    admission_date: record.admission_date ?? '',
    discharge_date: record.discharge_date ?? '',
    record_date: record.record_date ?? '',
  });

  function set<K extends keyof CasePatch>(key: K, value: CasePatch[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const save = useMutation({
    mutationFn: () => {
      // An empty date field means "clear it", which the API models as null. An empty string is
      // not a date and would be rejected.
      const patch: CasePatch = {
        ...form,
        admission_date: form.admission_date || null,
        discharge_date: form.discharge_date || null,
        record_date: form.record_date || null,
      };
      return api.updateCase(record.id, patch);
    },
    onSuccess: onSaved,
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not save.', 'error'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit patient record"
      description="The MR and IPD numbers identify this record and cannot be changed here."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <dl className="mb-3 flex flex-wrap border border-rule-2 bg-rule">
        <div className="min-w-[9rem] flex-1 bg-paper-2 px-2.5 py-1.5">
          <dt className="field-label">MR number</dt>
          <dd className="mt-1 tabular-nums text-ink">{record.patient_ref}</dd>
        </div>
        <div className="min-w-[9rem] flex-1 bg-paper-2 px-2.5 py-1.5">
          <dt className="field-label">IPD number</dt>
          <dd className="mt-1 tabular-nums text-ink">{record.encounter_ref}</dd>
        </div>
        <div className="min-w-[9rem] flex-1 bg-paper-2 px-2.5 py-1.5">
          <dt className="field-label">Entered</dt>
          <dd className="mt-1 text-ink">{formatDateTime(record.created_at)}</dd>
        </div>
      </dl>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Patient's name"
          value={form.patient_name ?? ''}
          onChange={(e) => set('patient_name', e.target.value)}
        />
        <Select
          label="Department"
          value={form.department ?? ''}
          onChange={(e) => set('department', e.target.value)}
        >
          <option value="">Not recorded</option>
          {(options.data?.departments ?? []).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <TextInput
          label="Mobile number"
          value={form.mobile ?? ''}
          onChange={(e) => set('mobile', e.target.value)}
        />
        <TextInput
          label="Consultant's name"
          value={form.consultant_name ?? ''}
          onChange={(e) => set('consultant_name', e.target.value)}
        />
        <TextInput
          label="Disease"
          value={form.disease ?? ''}
          onChange={(e) => set('disease', e.target.value)}
        />
        <TextInput
          label="ICD code"
          hint="Recorded only as written on the page. Never looked up or completed."
          value={form.icd_code ?? ''}
          onChange={(e) => set('icd_code', e.target.value)}
        />
        <Select
          label="Discharge type"
          value={form.discharge_type ?? ''}
          onChange={(e) => set('discharge_type', e.target.value)}
        >
          <option value="">Not recorded</option>
          {(options.data?.discharge_types ?? []).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <Select
          label="MLC type"
          value={form.mlc_type ?? ''}
          onChange={(e) => set('mlc_type', e.target.value)}
        >
          <option value="">Not recorded</option>
          {(options.data?.mlc_types ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <TextInput
          label="Date of admission"
          type="date"
          value={form.admission_date ?? ''}
          onChange={(e) => set('admission_date', e.target.value)}
        />
        <TextInput
          label="Date of discharge"
          type="date"
          value={form.discharge_date ?? ''}
          onChange={(e) => set('discharge_date', e.target.value)}
        />
        <TextInput
          label="Record date"
          hint="The date on the form, which for an older record is not today."
          type="date"
          value={form.record_date ?? ''}
          onChange={(e) => set('record_date', e.target.value)}
        />
      </div>
    </Modal>
  );
}

/**
 * Deleting a patient record.
 *
 * Destructive and not undoable, so the dialog states exactly what goes and asks for the IPD
 * number to be typed back — a confirmation that cannot be cleared by a reflex click.
 */
function DeleteCaseDialog({
  record,
  onClose,
  onDeleted,
}: {
  record: Case;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === record.encounter_ref;

  const remove = useMutation({
    mutationFn: () => api.deleteCase(record.id),
    onSuccess: onDeleted,
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not delete.', 'error'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Delete this patient record?"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => remove.mutate()}
            disabled={!matches || remove.isPending}
          >
            {remove.isPending ? 'Deleting…' : 'Delete record'}
          </Button>
        </>
      }
    >
      <MarginNote tone="warn">
        This removes the record for <strong className="font-semibold">{record.patient_ref}</strong>{' '}
        and everything filed under it: {record.document_count} file
        {record.document_count === 1 ? '' : 's'}, {record.page_count} page
        {record.page_count === 1 ? '' : 's'}, and every scan version, quality verdict, handwriting
        result and diagnosis attached to them. It cannot be undone.
      </MarginNote>

      <div className="mt-3">
        <TextInput
          label={`Type the IPD number to confirm: ${record.encounter_ref}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={record.encounter_ref}
        />
      </div>
    </Modal>
  );
}
