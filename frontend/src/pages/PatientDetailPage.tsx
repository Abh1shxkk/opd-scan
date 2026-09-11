/**
 * One patient record, in full.
 *
 * Everything the intake form captured, what the system has done with the files since, the
 * original PDFs as they arrived, and every page with its quality verdict — on one screen, so a
 * clerk answering "what do we have for this patient?" does not have to assemble the answer from
 * three others.
 *
 * The original file is fetched into an object URL rather than linked: the route is behind a
 * bearer token, and a plain `href` would send no Authorization header and render a 401 inside the
 * PDF viewer.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, ScanEye } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';
import { formatBytes, formatDateTime, ingestView } from '../lib/status';
import type { DocumentSummary, PageSummary } from '../lib/types';
import { ChartHead, MarginNote, Panel } from '../components/Sheet';
import { CompletenessPanel } from '../components/CompletenessPanel';
import { PageThumb } from '../components/PageThumb';
import { StatusPill } from '../components/StatusPill';
import { isWorking, ProcessingState } from '../components/ProcessingState';
import { Button, DetailRow, EmptyState, ErrorState, Spinner } from '../components/ui';

export default function PatientDetailPage() {
  const { caseId = '' } = useParams();

  const record = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => api.getCase(caseId),
    enabled: Boolean(caseId),
    refetchInterval: (query) => (query.state.data && isWorking(query.state.data) ? 4000 : false),
  });

  const docs = useQuery({
    queryKey: ['case-documents', caseId],
    queryFn: () => api.listDocuments(new URLSearchParams({ case_id: caseId })),
    enabled: Boolean(caseId),
  });

  const pages = useQuery({
    queryKey: ['case-pages', caseId],
    queryFn: () => api.listPages(new URLSearchParams({ case_id: caseId, limit: '500' })),
    enabled: Boolean(caseId),
    refetchInterval: record.data && isWorking(record.data) ? 4000 : false,
  });

  if (record.isLoading) return <Spinner label="Loading patient record…" />;
  if (record.isError) return <ErrorState error={record.error} retry={() => record.refetch()} />;
  if (!record.data) return null;

  const c = record.data;
  const documents = docs.data?.items ?? [];
  const pageRows = pages.data?.items ?? [];

  return (
    <div className="space-y-3">
      <ChartHead
        title={c.patient_name || c.patient_ref}
        description="Everything recorded for this patient, and everything the system has read from their files."
        meta={[
          { label: 'MR number', value: <span className="tabular-nums">{c.patient_ref}</span> },
          { label: 'IPD number', value: <span className="tabular-nums">{c.encounter_ref}</span> },
          { label: 'Entered', value: formatDateTime(c.created_at) },
          { label: 'Processing', value: <ProcessingState record={c} compact /> },
        ]}
        actions={
          <>
            <Link
              to="/patients"
              className="inline-flex min-h-[30px] items-center border border-rule-2 bg-paper-2 px-3 font-label text-[12px] font-semibold uppercase tracking-label text-ink transition-colors duration-150 ease-chart hover:bg-paper-3"
            >
              All records
            </Link>
            {c.first_page_version_id ? (
              <Link
                to={`/pages/${c.first_page_version_id}`}
                className="inline-flex min-h-[30px] items-center gap-1.5 border border-chart bg-chart px-3 font-label text-[12px] font-semibold uppercase tracking-label text-paper transition-colors duration-150 ease-chart hover:bg-chart/90"
              >
                <ScanEye size={13} strokeWidth={2.5} aria-hidden="true" />
                Open scan
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Panel
          title="Patient details"
          description="As entered on the intake form. An empty field means not recorded — never that it was looked up and not found."
        >
          <dl>
            <DetailRow term="Name">{c.patient_name || <Blank />}</DetailRow>
            <DetailRow term="Department">{c.department || <Blank />}</DetailRow>
            <DetailRow term="Mobile">{c.mobile || <Blank />}</DetailRow>
            <DetailRow term="Disease">{c.disease || <Blank />}</DetailRow>
            <DetailRow term="ICD code">
              {c.icd_code || <Blank />}
              <span className="mt-0.5 block text-[11px] text-ink-2">
                Recorded only as written on the page. Never looked up or completed.
              </span>
            </DetailRow>
            <DetailRow term="Consultant">{c.consultant_name || <Blank />}</DetailRow>
            <DetailRow term="Discharge type">{c.discharge_type || <Blank />}</DetailRow>
            <DetailRow term="MLC type">{c.mlc_type || <Blank />}</DetailRow>
            <DetailRow term="Admitted">{c.admission_date || <Blank />}</DetailRow>
            <DetailRow term="Discharged">{c.discharge_date || <Blank />}</DetailRow>
            <DetailRow term="Record date">{c.record_date || <Blank />}</DetailRow>
          </dl>
        </Panel>

        <div className="space-y-3">
          <Panel
            title="Files"
            description="The originals exactly as they were uploaded."
            flush
          >
            {docs.isLoading ? (
              <div className="p-3">
                <Spinner label="Loading files…" />
              </div>
            ) : documents.length === 0 ? (
              <div className="p-3">
                <EmptyState title="No files are attached to this record.">
                  The details can be entered before the documents arrive.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-rule">
                {documents.map((d) => (
                  <li key={d.id}>
                    <DocumentRow doc={d} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <CompletenessPanel caseId={caseId} />
        </div>
      </div>

      <Panel
        title="Pages"
        description="Every page of every file, with the verdict the quality engine gave it. Open one to read it beside its findings."
        flush
      >
        {pages.isLoading ? (
          <div className="p-3">
            <Spinner label="Loading pages…" />
          </div>
        ) : pageRows.length === 0 ? (
          <div className="p-3">
            {isWorking(c) ? (
              <MarginNote tone="warn">
                The pages are still being produced from the uploaded file. They appear here as the
                worker renders them — nothing is missing, it is not finished.
              </MarginNote>
            ) : (
              <EmptyState title="No pages have been rendered for this record." />
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 p-3">
            {pageRows.map((p: PageSummary) => (
              <Link
                key={p.page_version_id}
                to={`/pages/${p.page_version_id}`}
                className="block"
                aria-label={`Open page ${p.ordinal}`}
              >
                <PageThumb
                  as="div"
                  pageVersionId={p.page_version_id}
                  ordinal={p.ordinal}
                  printedLabel={p.printed_page_label}
                  pageClass={p.page_class ?? undefined}
                />
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Blank() {
  return <span className="text-ink-2">Not recorded</span>;
}

/**
 * One uploaded file, with its own PDF viewer.
 *
 * The viewer is opened on demand rather than eagerly: a record can carry a dozen files, and
 * fetching every original into memory to render previews nobody asked for would cost a clerk's
 * whole session in blobs.
 */
function DocumentRow({ doc }: { doc: DocumentSummary }) {
  const [open, setOpen] = useState(false);
  const file = useAuthedObjectUrl(open ? api.documentFilePath(doc.id) : null);

  return (
    <div className="px-2.5 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] text-ink">
            <FileText size={13} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-ink-2" />
            <span className="truncate font-medium">{doc.original_filename}</span>
          </p>
          <p className="mt-1 text-[11px] text-ink-2">
            {doc.page_count} page{doc.page_count === 1 ? '' : 's'} · {formatBytes(doc.byte_size)} ·
            uploaded {formatDateTime(doc.uploaded_at)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill view={ingestView(doc.ingest_status)} size="sm" />
          <Button variant="secondary" onClick={() => setOpen((v) => !v)} className="min-h-[26px] px-2">
            {open ? 'Hide PDF' : 'View PDF'}
          </Button>
        </div>
      </div>

      {doc.ingest_error ? (
        <p className="mt-1.5 text-[12px] text-plot">{doc.ingest_error}</p>
      ) : null}

      {open ? (
        <div className="mt-2">
          {file.loading ? <Spinner label="Loading the original file…" /> : null}
          {file.error ? (
            <MarginNote tone="warn">{file.error}</MarginNote>
          ) : null}
          {file.url ? (
            <>
              <div className="flex justify-end pb-1.5">
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-chart underline"
                >
                  <ExternalLink size={12} strokeWidth={2.5} aria-hidden="true" />
                  Open in a new tab
                </a>
              </div>
              <iframe
                src={file.url}
                title={`${doc.original_filename} — original file`}
                className="h-[36rem] w-full border border-rule-2 bg-paper-2"
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
