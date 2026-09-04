/**
 * Page viewer.
 *
 * The overlay geometry is the delicate part, and it is handled in exactly one place:
 *
 *   effectiveScale = displayedWidth / page.width
 *
 * `page.width` / `page.height` are the ORIGINAL RENDER dimensions, which is the coordinate space
 * every quality region, handwriting polygon and diagnosis region is expressed in. The image on
 * screen is a fitted, zoomed, and possibly bounded-size preview, so nothing may be drawn at raw
 * coordinates. `OverlayCanvas` receives the displayed box and does the mapping through the SVG
 * viewBox; this screen only has to work out what that displayed box is.
 *
 * Rotation is applied to a wrapper that contains BOTH the image and the overlay
 * (`RotatableStage`), so the two can never come apart — rotating a page rotates its findings with
 * it, which is what a reviewer expects when they straighten a sideways ENT sheet.
 *
 * The annotated view is a server-rendered image with the overlays burned in. When it is showing,
 * the client-side SVG overlay is suppressed: drawing both would double every outline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, imagePath } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CUTOFF_CAVEAT, defectLabel, isCutoff } from '../lib/defects';
import {
  captureProfileLabel,
  colourModeLabel,
  diagnosisView,
  formatConfidence,
  formatDateTime,
  formatScore,
  handwritingCategoryLabel,
  handwritingView,
  MEDICINE_CONFIDENCE_LABEL,
  pageClassView,
  prescriptionView,
  qualifierView,
  reviewStateView,
  scriptHintLabel,
  severityView,
} from '../lib/status';
import type { PageDetail, PageReviewAction, QualityFinding } from '../lib/types';
import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';
import {
  OverlayCanvas,
  OverlayLegend,
  RotatableStage,
  type OverlayKind,
  type OverlayShape,
} from '../components/OverlayCanvas';
import { CompletenessPanel } from '../components/CompletenessPanel';
import { PageThumb } from '../components/PageThumb';
import { Panel } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { Button, DetailRow, ErrorState, Select, Spinner, TextArea } from '../components/ui';

type Rotation = 0 | 90 | 180 | 270;

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;

export default function PageViewerPage() {
  const { pageVersionId = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const q = useQuery({
    queryKey: ['page', pageVersionId],
    queryFn: () => api.getPage(pageVersionId),
    enabled: Boolean(pageVersionId),
  });

  const review = useMutation({
    mutationFn: (payload: { action: PageReviewAction; comment?: string; payload?: Record<string, unknown> }) =>
      api.reviewPage(pageVersionId, payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['page', pageVersionId] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.push(
        variables.action === 'accept'
          ? 'Page accepted.'
          : variables.action === 'request_rescan'
            ? 'Rescan requested.'
            : variables.action === 'correct_finding'
              ? 'Correction recorded.'
              : 'Comment added.',
        'success',
      );
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'The action could not be saved.', 'error'),
  });

  const analyzePrescription = useMutation({
    mutationFn: () => api.reprocessPage(pageVersionId, ['prescription']),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page', pageVersionId] });
      toast.push('Prescription analysis started — this can take a few seconds.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not start the analysis.', 'error'),
  });

  if (q.isLoading) return <Spinner label="Loading page…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return null;

  return (
    <ViewerBody
      page={q.data}
      canReview={can('reviewer')}
      canAnalyzePrescription={can('uploader')}
      onReview={(payload) => review.mutate(payload)}
      reviewPending={review.isPending}
      onAnalyzePrescription={() => analyzePrescription.mutate()}
      analyzingPrescription={analyzePrescription.isPending}
    />
  );
}

function ViewerBody({
  page,
  canReview,
  canAnalyzePrescription,
  onReview,
  reviewPending,
  onAnalyzePrescription,
  analyzingPrescription,
}: {
  page: PageDetail;
  canReview: boolean;
  canAnalyzePrescription: boolean;
  onReview: (p: { action: PageReviewAction; comment?: string; payload?: Record<string, unknown> }) => void;
  reviewPending: boolean;
  onAnalyzePrescription: () => void;
  analyzingPrescription: boolean;
}) {
  const [mode, setMode] = useState<'original' | 'annotated'>('original');
  const [rotation, setRotation] = useState<Rotation>(0);
  const [zoom, setZoom] = useState(1);
  const [selectedShape, setSelectedShape] = useState<string | null>(null);
  const [show, setShow] = useState<Record<OverlayKind, boolean>>({
    quality: true,
    handwriting: true,
    diagnosis: true,
  });
  const [commentOpen, setCommentOpen] = useState(false);
  const [rescanOpen, setRescanOpen] = useState(false);
  const [correctFinding, setCorrectFinding] = useState<QualityFinding | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(900);

  // Measure the pane so the page can be fitted to it; re-measure on layout changes.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(el);
    setPaneWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const activeShow = useMemo(
    () => (Object.keys(show) as OverlayKind[]).filter((k) => show[k]),
    [show],
  );

  const imgPath =
    mode === 'annotated'
      ? imagePath.annotated(page.page_version_id, activeShow)
      : imagePath.preview(page.page_version_id);
  const { url, loading, error } = useAuthedObjectUrl(imgPath);

  // ---- geometry -----------------------------------------------------------
  // The page's own pixel space. Everything the API returns is in these units.
  const pw = page.width || 0;
  const ph = page.height || 0;
  const quarterTurn = rotation === 90 || rotation === 270;
  // Fit the page to the pane, accounting for the fact that a quarter-turn presents its height
  // across the pane instead of its width.
  const fitScale = pw && ph ? Math.min(1, (paneWidth - 24) / (quarterTurn ? ph : pw)) : 1;
  const effectiveScale = Math.max(0.02, fitScale * zoom);
  const displayedWidth = Math.round(pw * effectiveScale);
  const displayedHeight = Math.round(ph * effectiveScale);

  // Wheel zoom needs a non-passive listener: React's onWheel is registered passively, so
  // preventDefault() there does not stop the page from scrolling behind the image.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        e.preventDefault();
        setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_ZOOM, MAX_ZOOM));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- overlay shapes -----------------------------------------------------
  const shapes = useMemo<OverlayShape[]>(() => {
    const out: OverlayShape[] = [];

    if (show.quality && page.quality) {
      for (const f of page.quality.findings) {
        if (!f.region) continue;
        out.push({
          id: `q-${f.id}`,
          kind: 'quality',
          region: f.region,
          label: defectLabel(f.code, f.label),
          description: f.detail,
          selected: selectedShape === `q-${f.id}`,
          // A suspected cut-off is drawn dashed because the engine states it as a suspicion.
          tentative: isCutoff(f.code),
        });
      }
    }

    // Handwriting regions are drawn only when the check actually ran and found something. A
    // failed/unconfigured check has no regions and must not imply an empty page was examined.
    if (show.handwriting && page.handwriting?.status === 'detected') {
      for (const r of page.handwriting.regions) {
        out.push({
          id: `h-${r.id}`,
          kind: 'handwriting',
          polygon: r.polygon,
          label: handwritingCategoryLabel(r.category),
          description: scriptHintLabel(r.script_hint),
          selected: selectedShape === `h-${r.id}`,
        });
      }
    }

    if (show.diagnosis) {
      for (const d of page.diagnoses ?? []) {
        if (!d.region) continue;
        out.push({
          id: `d-${d.id}`,
          kind: 'diagnosis',
          region: d.region,
          label: d.anchor_label || 'Diagnosis',
          description: qualifierView(d.qualifier).label,
          selected: selectedShape === `d-${d.id}`,
        });
      }
    }

    return out;
  }, [page, show, selectedShape]);

  const legendKinds = useMemo<OverlayKind[]>(
    () => (['quality', 'handwriting', 'diagnosis'] as OverlayKind[]).filter((k) => show[k]),
    [show],
  );

  const activeVersion = page.versions?.find((v) => v.is_active);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
            Page {page.ordinal}
            {page.printed_page_label ? (
              <span className="ml-2 text-base font-normal text-slate-600 dark:text-slate-400">
                printed {page.printed_page_label}
              </span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            {page.document_filename}
            {page.patient_ref ? ` · patient ${page.patient_ref}` : ''}
            {page.encounter_ref ? ` · encounter ${page.encounter_ref}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill view={pageClassView(page.page_class)} />
          <StatusPill view={reviewStateView(page.review_state)} />
        </div>
      </header>

      {/* ---------------------------------------------------------- thumbnails */}
      {page.document_pages && page.document_pages.length > 1 ? (
        <nav aria-label="Pages in this document" className="overflow-x-auto">
          <ul className="flex gap-1 pb-2">
            {page.document_pages.map((p) => (
              <li key={p.page_version_id}>
                <Link
                  to={`/pages/${p.page_version_id}`}
                  className="block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  aria-current={p.page_version_id === page.page_version_id ? 'page' : undefined}
                >
                  <PageThumb
                    pageVersionId={p.page_version_id}
                    ordinal={p.ordinal}
                    printedLabel={p.printed_page_label}
                    pageClass={p.page_class}
                    selected={p.page_version_id === page.page_version_id}
                    as="div"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
        {/* ------------------------------------------------------------ image */}
        <section
          aria-label="Page image"
          className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
            <div role="group" aria-label="Image source" className="flex gap-1 rounded border border-slate-200 p-0.5 dark:border-slate-800">
              {(['original', 'annotated'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded px-2.5 py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
                    mode === m
                      ? 'bg-sky-700 text-white dark:bg-sky-600'
                      : 'text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  {m === 'original' ? 'Original' : 'Annotated'}
                </button>
              ))}
            </div>

            <div role="group" aria-label="Zoom" className="flex items-center gap-1">
              <Button onClick={() => setZoom((z) => clamp(z / 1.25, MIN_ZOOM, MAX_ZOOM))} aria-label="Zoom out">
                −
              </Button>
              <span className="w-14 text-center text-sm tabular-nums text-slate-800 dark:text-slate-200" aria-live="polite">
                {Math.round(effectiveScale * 100)}%
              </span>
              <Button onClick={() => setZoom((z) => clamp(z * 1.25, MIN_ZOOM, MAX_ZOOM))} aria-label="Zoom in">
                +
              </Button>
              <Button onClick={() => setZoom(1)} aria-label="Fit page to width">
                Fit
              </Button>
            </div>

            <div role="group" aria-label="Rotate" className="flex items-center gap-1">
              <Button onClick={() => setRotation((r) => rotate(r, -90))} aria-label="Rotate 90 degrees anticlockwise">
                ↺
              </Button>
              <span className="w-12 text-center text-sm tabular-nums text-slate-800 dark:text-slate-200">
                {rotation}°
              </span>
              <Button onClick={() => setRotation((r) => rotate(r, 90))} aria-label="Rotate 90 degrees clockwise">
                ↻
              </Button>
            </div>

            <fieldset className="ml-auto flex items-center gap-3">
              <legend className="sr-only">Overlays to show</legend>
              {(['quality', 'handwriting', 'diagnosis'] as OverlayKind[]).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm text-slate-800 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={show[k]}
                    onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))}
                    className="h-4 w-4 rounded border-slate-500 text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  />
                  {k === 'quality' ? 'Defect regions' : k === 'handwriting' ? 'Handwriting' : 'Diagnosis'}
                </label>
              ))}
            </fieldset>
          </div>

          <div className="border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
            <OverlayLegend kinds={legendKinds} />
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {mode === 'annotated'
                ? 'Overlays are drawn by the server into this image. Switch to Original to inspect the unmarked scan.'
                : 'Scroll to zoom. Overlay positions are scaled from the original render size and rotate with the page.'}
            </p>
          </div>

          <div
            ref={paneRef}
            className="relative max-h-[75vh] overflow-auto bg-slate-200 p-3 dark:bg-slate-950"
          >
            {loading ? <Spinner label="Loading the page image…" /> : null}
            {error ? (
              <div role="alert" className="p-4 text-sm text-red-900 dark:text-red-200">
                <span aria-hidden="true">⚠ </span>
                {error}
              </div>
            ) : null}
            {url && pw > 0 && ph > 0 ? (
              <RotatableStage width={displayedWidth} height={displayedHeight} rotation={rotation}>
                <img
                  src={url}
                  alt={`Page ${page.ordinal} of ${page.document_filename}`}
                  width={displayedWidth}
                  height={displayedHeight}
                  className="block select-none"
                  draggable={false}
                />
                {/* Client overlays are suppressed on the annotated render, which already has them. */}
                {mode === 'original' ? (
                  <OverlayCanvas
                    pageWidth={pw}
                    pageHeight={ph}
                    displayedWidth={displayedWidth}
                    displayedHeight={displayedHeight}
                    shapes={shapes}
                    onSelect={(id) => setSelectedShape((cur) => (cur === id ? null : id))}
                    showLabels={effectiveScale > 0.18}
                  />
                ) : null}
              </RotatableStage>
            ) : url ? (
              <div className="p-4 text-sm text-amber-900 dark:text-amber-200">
                <span aria-hidden="true">⚠ </span>
                This page version has no recorded pixel dimensions, so region overlays cannot be placed.
                The image is shown without them.
                <img src={url} alt={`Page ${page.ordinal}`} className="mt-3 max-w-full" />
              </div>
            ) : null}
          </div>
        </section>

        {/* ------------------------------------------------------------ side */}
        <div className="space-y-4">
          {canReview ? (
            <Panel title="Reviewer actions">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={reviewPending}
                  onClick={() => onReview({ action: 'accept' })}
                >
                  Accept page
                </Button>
                <Button variant="danger" disabled={reviewPending} onClick={() => setRescanOpen(true)}>
                  Request rescan
                </Button>
                <Button variant="secondary" disabled={reviewPending} onClick={() => setCommentOpen(true)}>
                  Add comment
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                Accepting records your name against this page version. It does not alter the scan.
              </p>
            </Panel>
          ) : null}

          <QualityPanel page={page} onCorrect={canReview ? setCorrectFinding : undefined} onSelect={setSelectedShape} />
          <HandwritingPanel page={page} onSelect={setSelectedShape} />
          <DiagnosisPanel page={page} onSelect={setSelectedShape} />
          <PrescriptionPanel
            page={page}
            canAnalyze={canAnalyzePrescription}
            onAnalyze={onAnalyzePrescription}
            analyzing={analyzingPrescription}
          />
          <VersionHistoryPanel page={page} activeVersionId={activeVersion?.id ?? page.page_version_id} />
          <ReviewHistoryPanel page={page} />
          {page.case_id ? <CompletenessPanel caseId={page.case_id} /> : null}

          <Panel title="Capture details">
            <dl>
              <DetailRow term="Render size">
                {pw && ph ? `${pw} × ${ph} px` : 'Not recorded'}
              </DetailRow>
              <DetailRow term="Colour mode">{colourModeLabel(page.colour_mode)}</DetailRow>
              <DetailRow term="Capture type">{captureProfileLabel(page.capture_profile)}</DetailRow>
              <DetailRow term="Version">
                {page.version_no} <span className="text-slate-600 dark:text-slate-400">(active)</span>
              </DetailRow>
            </dl>
          </Panel>
        </div>
      </div>

      {/* --------------------------------------------------------- dialogs */}
      <CommentDialog
        open={commentOpen}
        title="Add a comment"
        description="The comment is attached to this page version and is visible to other reviewers."
        confirmLabel="Save comment"
        onClose={() => setCommentOpen(false)}
        onSubmit={(comment) => {
          onReview({ action: 'comment', comment });
          setCommentOpen(false);
        }}
      />
      <CommentDialog
        open={rescanOpen}
        title="Request a rescan"
        description="Say what is wrong with this capture so whoever rescans it knows what to fix."
        confirmLabel="Request rescan"
        destructive
        required
        onClose={() => setRescanOpen(false)}
        onSubmit={(comment) => {
          onReview({ action: 'request_rescan', comment });
          setRescanOpen(false);
        }}
      />
      <CorrectFindingDialog
        finding={correctFinding}
        onClose={() => setCorrectFinding(null)}
        onSubmit={(payload, comment) => {
          onReview({ action: 'correct_finding', comment, payload });
          setCorrectFinding(null);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ panels

function QualityPanel({
  page,
  onCorrect,
  onSelect,
}: {
  page: PageDetail;
  onCorrect?: (f: QualityFinding) => void;
  onSelect: (id: string) => void;
}) {
  const quality = page.quality;
  const score = formatScore(quality?.score);

  return (
    <Panel
      title="Scan quality"
      description="Scan defects only. Handwriting on a page is not a defect and is never listed here."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill view={pageClassView(page.page_class)} showDetail />
      </div>

      {score ? (
        <p className="mb-2 text-sm text-slate-700 dark:text-slate-300">
          Quality score <span className="font-semibold tabular-nums">{score}</span>{' '}
          <span className="text-slate-600 dark:text-slate-400">(1.00 is best)</span>
        </p>
      ) : null}

      {quality?.provider_error ? (
        <p className="mb-2 rounded border border-amber-400 bg-amber-50 px-2 py-1.5 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
          <span aria-hidden="true">⚠ </span>
          Provider signals unavailable: {quality.provider_error}. The local measurements below still apply.
        </p>
      ) : null}

      {!quality ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          No quality result has been recorded for this page version.
        </p>
      ) : quality.findings.length === 0 ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {page.page_class === 'blank'
            ? 'Reported as blank. Nothing else is measured on a blank page — calling an empty sheet “blurred” would be meaningless.'
            : page.page_class === 'failed'
              ? 'The page could not be measured, so no findings exist. This is not the same as a clean page.'
              : 'No scan defects were found.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {quality.findings.map((f) => {
            const conf = formatConfidence(f.confidence);
            return (
              <li
                key={f.id}
                className="rounded-lg border border-slate-200 p-2 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {defectLabel(f.code, f.label)}
                  </span>
                  <StatusPill view={severityView(f.severity)} size="sm" />
                  {/* Only rendered when the API supplied one. Never a made-up percentage. */}
                  {conf ? (
                    <span className="text-xs text-slate-600 dark:text-slate-400">confidence {conf}</span>
                  ) : null}
                  <span className="text-xs text-slate-600 dark:text-slate-400">
                    {f.source === 'provider' ? 'reported by provider' : 'measured locally'}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{f.detail}</p>
                {isCutoff(f.code) ? (
                  <p className="mt-1 text-xs italic text-slate-600 dark:text-slate-400">{CUTOFF_CAVEAT}</p>
                ) : null}
                <div className="mt-1 flex gap-2">
                  {f.region ? (
                    <Button variant="ghost" onClick={() => onSelect(`q-${f.id}`)} className="px-1 py-0.5 text-xs">
                      Highlight on the page
                    </Button>
                  ) : null}
                  {onCorrect ? (
                    <Button variant="ghost" onClick={() => onCorrect(f)} className="px-1 py-0.5 text-xs">
                      Correct this finding
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function HandwritingPanel({ page, onSelect }: { page: PageDetail; onSelect: (id: string) => void }) {
  const hw = page.handwriting;
  const view = handwritingView(hw?.status ?? page.handwriting_status);

  return (
    <Panel
      title="Handwriting"
      description="Recorded separately from scan quality. Its presence is never treated as a defect."
    >
      <StatusPill view={view} showDetail />

      {hw?.error ? (
        <p className="mt-2 text-sm text-amber-900 dark:text-amber-200">Reported error: {hw.error}</p>
      ) : null}

      {hw?.status === 'detected' && hw.regions.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {hw.regions.map((r) => {
            const conf = formatConfidence(r.confidence);
            return (
              <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => onSelect(`h-${r.id}`)}
                  className="font-medium text-sky-800 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-sky-300"
                >
                  {handwritingCategoryLabel(r.category)}
                </button>
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  {scriptHintLabel(r.script_hint)}
                  {conf ? ` · confidence ${conf}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {hw?.status === 'detected' && hw.regions.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          Handwriting was detected but no region outline was returned for it.
        </p>
      ) : null}
    </Panel>
  );
}

function DiagnosisPanel({ page, onSelect }: { page: PageDetail; onSelect: (id: string) => void }) {
  const items = page.diagnoses ?? [];

  return (
    <Panel title="Diagnosis extractions" description="Transcribed from a diagnosis label on this page.">
      {items.length === 0 ? (
        <StatusPill view={diagnosisView(page.diagnosis_status)} showDetail />
      ) : (
        <ul className="space-y-2">
          {items.map((d) => (
            <li key={d.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill view={diagnosisView(d.status)} size="sm" />
                <StatusPill view={qualifierView(d.qualifier)} size="sm" />
                {!d.is_reviewed ? (
                  <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-950 dark:bg-amber-900 dark:text-amber-50">
                    AI extraction — not reviewed
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Label on the page: “{d.anchor_label || 'unlabelled'}”
              </p>
              {d.cleaned_text || d.raw_text ? (
                <p className="mt-1 font-mono text-sm text-slate-900 dark:text-slate-100">
                  {d.cleaned_text || d.raw_text}
                </p>
              ) : null}
              <div className="mt-1 flex gap-2">
                {d.region ? (
                  <Button variant="ghost" onClick={() => onSelect(`d-${d.id}`)} className="px-1 py-0.5 text-xs">
                    Highlight on the page
                  </Button>
                ) : null}
                <Link
                  to={`/diagnoses/${d.id}`}
                  className="px-1 py-0.5 text-xs font-medium text-sky-800 underline dark:text-sky-300"
                >
                  Open in diagnosis review
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Prescription understanding. Opt-in per page (unlike quality/handwriting/diagnosis, which run on
 * every upload) — a reviewer explicitly asks for it, since not every scanned page is a prescription.
 *
 * The layout keeps three things visually distinct on purpose: the immutable OCR transcription, the
 * AI's interpretation of it, and the disclaimer — so nothing here reads as more certain than it is.
 */
function PrescriptionPanel({
  page,
  canAnalyze,
  onAnalyze,
  analyzing,
}: {
  page: PageDetail;
  canAnalyze: boolean;
  onAnalyze: () => void;
  analyzing: boolean;
}) {
  const p = page.prescription;
  const status = page.prescription_status ?? null;

  return (
    <Panel
      title="Prescription understanding"
      description="AI-assisted reading of a handwritten prescription. Not a diagnosis, and not medical advice."
      actions={
        canAnalyze ? (
          <Button variant="secondary" onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? 'Analysing…' : p ? 'Re-analyse' : 'Analyse as prescription'}
          </Button>
        ) : undefined
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill view={prescriptionView(status)} showDetail />
        {p?.language_detected ? (
          <span className="text-xs text-slate-600 dark:text-slate-400">Language: {p.language_detected}</span>
        ) : null}
      </div>

      {!p ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {status === 'unconfigured'
            ? 'No prescription-reading provider is configured for this deployment.'
            : 'Not yet analysed. Use "Analyse as prescription" above if this page is a handwritten prescription.'}
        </p>
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
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Safety warnings</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-red-800 dark:text-red-300">
                {p.safety_warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {p.medicines.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Medicines</h3>
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
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Dose</dt>
                        <dd>{m.dose || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Frequency</dt>
                        <dd>{m.frequency || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Duration</dt>
                        <dd>{m.duration || '—'}</dd>
                      </div>
                    </dl>
                    {m.general_use ? (
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                        Generally used for: {m.general_use}
                      </p>
                    ) : null}
                    {m.uncertainty ? (
                      <p className="mt-1 text-xs italic text-amber-800 dark:text-amber-300">
                        Uncertain: {m.uncertainty}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : status === 'extracted_pending_review' ? (
            <p className="text-sm text-slate-700 dark:text-slate-300">No medicines were read on this page.</p>
          ) : null}

          {p.possible_interpretation ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Possible interpretation</h3>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{p.possible_interpretation}</p>
            </div>
          ) : null}

          {p.patient_explanation ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">In plain language</h3>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{p.patient_explanation}</p>
            </div>
          ) : null}

          {p.diagnosis_or_notes ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Diagnosis / notes on the page</h3>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">{p.diagnosis_or_notes}</p>
            </div>
          ) : null}

          {p.uncertainties.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Unclear or unreadable</h3>
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
    </Panel>
  );
}

/**
 * Version history. Only the active version is counted anywhere in the system; superseded versions
 * exist solely here, which is why each row states plainly which one is which.
 */
function VersionHistoryPanel({ page, activeVersionId }: { page: PageDetail; activeVersionId: string }) {
  const versions = [...(page.versions ?? [])].sort((a, b) => b.version_no - a.version_no);

  return (
    <Panel
      title="Version history"
      description="A rescan creates a new version of the same logical page. Only the active version is counted in totals and exports."
    >
      {versions.length === 0 ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">Only one version exists for this page.</p>
      ) : (
        <ol className="space-y-2">
          {versions.map((v) => {
            const isActive = v.id === activeVersionId || v.is_active;
            return (
              <li
                key={v.id}
                className={`rounded border p-2 ${
                  isActive
                    ? 'border-sky-600 bg-sky-50 dark:border-sky-500 dark:bg-sky-950'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Version {v.version_no}
                  </span>
                  {isActive ? (
                    <StatusPill view={{ label: 'Active version', tone: 'ok', icon: '✓' }} size="sm" />
                  ) : (
                    <StatusPill
                      view={{
                        label: 'Superseded',
                        tone: 'neutral',
                        icon: '↩',
                        detail: 'Kept for audit. Not counted in any total or export.',
                      }}
                      size="sm"
                    />
                  )}
                  {v.page_class ? <StatusPill view={pageClassView(v.page_class)} size="sm" /> : null}
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                  {formatDateTime(v.created_at)} · {v.width}×{v.height} px · {colourModeLabel(v.colour_mode)} ·{' '}
                  {captureProfileLabel(v.capture_profile)}
                </p>
                {!isActive ? (
                  <Link
                    to={`/pages/${v.id}`}
                    className="mt-1 inline-block text-xs font-medium text-sky-800 underline dark:text-sky-300"
                  >
                    View this superseded version
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function ReviewHistoryPanel({ page }: { page: PageDetail }) {
  const reviews = page.reviews ?? [];
  if (reviews.length === 0) return null;

  const ACTION_LABEL: Record<string, string> = {
    accept: 'Accepted',
    request_rescan: 'Rescan requested',
    correct_finding: 'Finding corrected',
    comment: 'Comment',
  };

  return (
    <Panel title="Review history">
      <ol className="space-y-2">
        {reviews.map((r) => (
          <li key={r.id} className="border-l-2 border-slate-200 pl-2 dark:border-slate-800">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {ACTION_LABEL[r.action] ?? r.action}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {r.reviewer_name || r.reviewer_id} · {formatDateTime(r.created_at)}
            </p>
            {r.comment ? (
              <p className="mt-0.5 text-sm text-slate-800 dark:text-slate-200">{r.comment}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ------------------------------------------------------------------ dialogs

function CommentDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  required = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  required?: boolean;
  onClose: () => void;
  onSubmit: (comment: string) => void;
}) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={required && text.trim().length === 0}
            onClick={() => onSubmit(text.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <TextArea
        label={required ? 'Reason (required)' : 'Comment'}
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  );
}

/**
 * Correcting a finding never edits the original detection: the correction is submitted as a review
 * action, and the engine's own output stays visible above it.
 */
function CorrectFindingDialog({
  finding,
  onClose,
  onSubmit,
}: {
  finding: QualityFinding | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>, comment: string) => void;
}) {
  const [verdict, setVerdict] = useState<'not_a_defect' | 'wrong_severity' | 'wrong_code'>('not_a_defect');
  const [severity, setSeverity] = useState('medium');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (finding) {
      setVerdict('not_a_defect');
      setSeverity(finding.severity);
      setComment('');
    }
  }, [finding]);

  if (!finding) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this finding"
      description="Your correction is recorded alongside the original detection. The engine's output is not overwritten."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={comment.trim().length === 0}
            onClick={() =>
              onSubmit(
                {
                  finding_id: finding.id,
                  defect_code: finding.code,
                  verdict,
                  corrected_severity: verdict === 'wrong_severity' ? severity : undefined,
                },
                comment.trim(),
              )
            }
          >
            Record correction
          </Button>
        </>
      }
    >
      <p className="mb-3 rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">
        <span className="font-medium">{defectLabel(finding.code, finding.label)}</span>{' '}
        <span className="text-slate-700 dark:text-slate-300">— {finding.detail}</span>
      </p>

      <fieldset className="mb-3">
        <legend className="mb-1 text-xs font-medium text-slate-800 dark:text-slate-200">
          What is wrong with it?
        </legend>
        {(
          [
            ['not_a_defect', 'This is not a defect — the page is fine as captured'],
            ['wrong_severity', 'The defect is real but the severity is wrong'],
            ['wrong_code', 'The defect is real but has been classified as the wrong type'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-start gap-2 py-0.5 text-sm">
            <input
              type="radio"
              name="verdict"
              value={value}
              checked={verdict === value}
              onChange={() => setVerdict(value)}
              className="mt-0.5 h-4 w-4 border-slate-500 text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            />
            <span className="text-slate-900 dark:text-slate-100">{label}</span>
          </label>
        ))}
      </fieldset>

      {verdict === 'wrong_severity' ? (
        <Select label="Correct severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      ) : null}

      <div className="mt-3">
        <TextArea
          label="Explain the correction (required)"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ helpers

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function rotate(current: Rotation, delta: number): Rotation {
  return (((current + delta) % 360) + 360) % 360 as Rotation;
}
