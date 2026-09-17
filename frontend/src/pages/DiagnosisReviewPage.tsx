/**
 * Diagnosis review — source image beside the extracted text.
 *
 * Rules this screen exists to enforce:
 *
 *  - The raw transcription and the cleaned text are shown as two SEPARATE, labelled fields. The
 *    cleaned version differs only by whitespace and stripped label punctuation, and each applied
 *    transformation is listed, so a reviewer can see there was no clinical rewriting.
 *  - The qualifier is displayed prominently, next to the text rather than buried in metadata. A
 *    "ruled out" or "past history" entry read as a current diagnosis is a clinical error.
 *  - Ambiguous abbreviations that were deliberately NOT expanded are called out by name.
 *  - Anything no human has confirmed carries an unmissable "AI extraction — not reviewed" badge.
 *  - Corrections are appended. The original AI output stays on screen after a correction, always.
 *
 * The image pane crops to the diagnosis region by scaling the whole page render so that the region
 * fills the viewport, then translating it into place — the crop is therefore computed in the same
 * original-render-pixel space as every other overlay, and the "show whole page" toggle simply
 * switches back to the fit-to-pane scale.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, imagePath } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  diagnosisView,
  formatConfidence,
  formatDateTime,
  qualifierView,
  QUALIFIERS,
} from '../lib/status';
import type { DiagnosisDetail, Qualifier, Region } from '../lib/types';
import { useAuthedObjectUrl } from '../hooks/useAuthedObjectUrl';
import { OverlayCanvas } from '../components/OverlayCanvas';
import { Panel } from '../components/Sheet';
import { StatusPill } from '../components/StatusPill';
import { ReviewedBadge, UnreviewedBadge } from '../components/UnreviewedBadge';
import { useToast } from '../components/Toast';
import { Button, DetailRow, ErrorState, Select, Spinner, TextArea } from '../components/ui';
import { TriangleAlert } from 'lucide-react';

export default function DiagnosisReviewPage() {
  const { diagnosisId = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const q = useQuery({
    queryKey: ['diagnosis', diagnosisId],
    queryFn: () => api.getDiagnosis(diagnosisId),
    enabled: Boolean(diagnosisId),
  });

  const review = useMutation({
    mutationFn: (payload: {
      action: 'confirm' | 'correct' | 'reject';
      corrected_text?: string;
      corrected_qualifier?: Qualifier;
      comment?: string;
    }) => api.reviewDiagnosis(diagnosisId, payload),
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ['diagnosis', diagnosisId] });
      queryClient.invalidateQueries({ queryKey: ['diagnoses'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.push(
        vars.action === 'confirm'
          ? 'Extraction confirmed.'
          : vars.action === 'correct'
            ? 'Correction recorded. The original AI output is preserved.'
            : 'Extraction rejected.',
        'success',
      );
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'The review could not be saved.', 'error'),
  });

  if (q.isLoading) return <Spinner label="Loading extraction…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return null;

  return (
    <ReviewBody
      d={q.data}
      canReview={can('reviewer')}
      busy={review.isPending}
      onReview={(p) => review.mutate(p)}
    />
  );
}

function ReviewBody({
  d,
  canReview,
  busy,
  onReview,
}: {
  d: DiagnosisDetail;
  canReview: boolean;
  busy: boolean;
  onReview: (p: {
    action: 'confirm' | 'correct' | 'reject';
    corrected_text?: string;
    corrected_qualifier?: Qualifier;
    comment?: string;
  }) => void;
}) {
  const reviews = d.reviews ?? [];
  const isReviewed = reviews.length > 0;
  const lastAction = reviews.length > 0 ? reviews[reviews.length - 1].action : null;

  return (
    <div className="space-y-4">
      <header className="rule-double flex flex-wrap items-start justify-between gap-3 pb-2">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-ink">Diagnosis review</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            <Link
              to={`/pages/${d.page.page_version_id}`}
              className="font-medium text-chart underline"
            >
              Page {d.page.ordinal}
              {d.page.printed_page_label ? ` · printed ${d.page.printed_page_label}` : ''}
            </Link>{' '}
            of {d.page.document_filename}
            {d.page.patient_ref ? ` · patient ${d.page.patient_ref}` : ''}
            {d.page.encounter_ref ? ` · encounter ${d.page.encounter_ref}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isReviewed && lastAction ? (
            <ReviewedBadge action={lastAction} />
          ) : (
            <UnreviewedBadge />
          )}
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-2">
        <SourceImagePane
          region={d.region}
          pageVersionId={d.page.page_version_id}
          pageWidth={d.page.width}
          pageHeight={d.page.height}
          pageLabel={`Page ${d.page.ordinal} of ${d.page.document_filename}`}
        />
        <div className="space-y-4">
          <ExtractionPane d={d} isReviewed={isReviewed} />
          {canReview ? <ActionsPane d={d} busy={busy} onReview={onReview} /> : null}
          <HistoryPane d={d} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ image

function SourceImagePane({
  region,
  pageVersionId,
  pageWidth,
  pageHeight,
  pageLabel,
}: {
  region: Region | null;
  pageVersionId: string;
  pageWidth: number;
  pageHeight: number;
  pageLabel: string;
}) {
  const [wholePage, setWholePage] = useState(!region);
  const { url, loading, error } = useAuthedObjectUrl(imagePath.preview(pageVersionId));

  // The viewport the image is composed into. Fixed so the crop maths is stable and testable.
  const boxW = 560;
  const boxH = 420;

  const layout = useMemo(() => {
    if (!pageWidth || !pageHeight) return null;
    if (wholePage || !region || region.w <= 0 || region.h <= 0) {
      // Whole page: plain fit, no translation.
      const scale = Math.min(boxW / pageWidth, boxH / pageHeight);
      return { scale, offsetX: 0, offsetY: 0, fit: true as const };
    }
    // Crop: scale so the region (plus a margin of 30% of its size, to keep context) fills the box,
    // then translate the page so the region's top-left lands at the box's top-left plus the margin.
    const padX = region.w * 0.3;
    const padY = region.h * 0.3;
    const scale = Math.min(boxW / (region.w + padX * 2), boxH / (region.h + padY * 2));
    // Clamp so a tiny region does not blow up into an unreadable pixel soup.
    const clamped = Math.min(scale, 6);
    return {
      scale: clamped,
      offsetX: -(region.x - padX) * clamped,
      offsetY: -(region.y - padY) * clamped,
      fit: false as const,
    };
  }, [region, wholePage, pageWidth, pageHeight]);

  const displayedWidth = layout ? pageWidth * layout.scale : 0;
  const displayedHeight = layout ? pageHeight * layout.scale : 0;

  return (
    <Panel
      title="Source page"
      description={
        region
          ? 'Cropped to the region the text was read from.'
          : 'No region was recorded for this extraction, so the whole page is shown.'
      }
      actions={
        region ? (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={wholePage}
              onChange={(e) => setWholePage(e.target.checked)}
              className="h-4 w-4 rounded border-rule-2 text-chart focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            Show whole page
          </label>
        ) : null
      }
    >
      <div
        className="relative mx-auto overflow-hidden rounded border border-rule bg-paper-3"
        style={{ width: boxW, maxWidth: '100%', height: boxH }}
      >
        {loading ? <Spinner label="Loading the page image…" /> : null}
        {error ? (
          <p role="alert" className="p-4 text-[13px] text-ink">
            <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
            {error}
          </p>
        ) : null}
        {url && layout ? (
          <div
            className="absolute left-0 top-0"
            style={{
              width: displayedWidth,
              height: displayedHeight,
              transform: `translate(${layout.offsetX}px, ${layout.offsetY}px)`,
            }}
          >
            <img
              src={url}
              alt={`${pageLabel}${region && !wholePage ? ', cropped to the region the diagnosis was read from' : ''}`}
              width={displayedWidth}
              height={displayedHeight}
              className="block"
            />
            {/* Same scaling contract as the main viewer: regions are in original render pixels and
                are mapped through the SVG viewBox onto the displayed box. */}
            {region ? (
              <OverlayCanvas
                pageWidth={pageWidth}
                pageHeight={pageHeight}
                displayedWidth={displayedWidth}
                displayedHeight={displayedHeight}
                shapes={[
                  {
                    id: 'diagnosis-region',
                    kind: 'diagnosis',
                    region,
                    label: 'Diagnosis',
                    selected: true,
                  },
                ]}
                showLabels={!wholePage}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {!pageWidth || !pageHeight ? (
        <p className="mt-2 text-[13px] text-ink">
          <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
          This page version has no recorded pixel dimensions, so the region cannot be located on the image.
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-ink-2">
        Read the image, not the transcription, when the two disagree. The image is the record.
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------- extraction

function ExtractionPane({ d, isReviewed }: { d: DiagnosisDetail; isReviewed: boolean }) {
  const conf = formatConfidence(d.confidence);

  return (
    <Panel title="Extracted diagnosis">
      {/* Qualifier gets its own block at the top. It changes what everything below means. */}
      <div className="mb-3 border-y border-rule bg-paper-2 px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-2">
          Clinical qualifier
        </p>
        <div className="mt-1">
          <StatusPill view={qualifierView(d.qualifier)} showDetail />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill view={diagnosisView(d.status)} size="sm" />
        {!isReviewed ? <UnreviewedBadge size="sm" /> : null}
        {d.is_handwritten ? (
          <span className="rounded bg-paper-2 px-1.5 py-0.5 text-[11px] font-medium text-ink">
            Handwritten source
          </span>
        ) : null}
      </div>

      {/* --- raw and cleaned, side by side and labelled ------------------- */}
      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            Raw transcription
          </h3>
          <p className="text-[11px] text-ink-2">
            Exactly what the model read. Immutable — it is never edited, including by a correction.
          </p>
          <p className="mt-1 whitespace-pre-wrap rounded border border-rule bg-paper p-2 font-mono text-[13px] text-ink">
            {d.raw_text || <span className="italic text-ink-2">Nothing was transcribed.</span>}
          </p>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            Cleaned text (presentation only)
          </h3>
          <p className="text-[11px] text-ink-2">
            Whitespace and label punctuation only. No expansion, no spelling correction, no reordering.
          </p>
          <p className="mt-1 whitespace-pre-wrap rounded border border-rule bg-paper p-2 font-mono text-[13px] text-ink">
            {d.cleaned_text || (
              <span className="italic text-ink-2">
                No cleaned text — the transcription was not readable enough to present.
              </span>
            )}
          </p>
          {d.cleaning_applied && d.cleaning_applied.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-[11px] text-ink-2">
              {d.cleaning_applied.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* --- abbreviations deliberately not expanded ---------------------- */}
      {d.ambiguous_abbreviations && d.ambiguous_abbreviations.length > 0 ? (
        <div className="mt-3 rounded border border-note/50 bg-note/[0.07] p-3">
          <h3 className="text-[13px] font-semibold text-ink">
            <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
            Abbreviations left exactly as written
          </h3>
          <p className="mt-1 text-[13px] text-ink">
            These have more than one common reading in this setting and were deliberately not expanded.
            Decide what they mean from the record, not from the transcription.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {d.ambiguous_abbreviations.map((a) => (
              <li
                key={a}
                className="rounded border border-note/50 bg-note/[0.07] px-2 py-0.5 font-mono text-[13px] font-semibold text-ink"
              >
                {a}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.note ? (
        <p className="mt-3 rounded bg-paper-2 p-2 text-[13px] text-ink">
          {d.note}
        </p>
      ) : null}

      <dl className="mt-3 border-t border-rule pt-2">
        <DetailRow term="Label on the page">“{d.anchor_label || 'unlabelled'}”</DetailRow>
        <DetailRow term="ICD code">
          {/* Only ever present when a code is literally written on the page — never derived. */}
          {d.icd_code_verbatim ? (
            <span className="font-mono">{d.icd_code_verbatim}</span>
          ) : (
            <span className="text-ink-2">
              None written on the page. No code has been assigned.
            </span>
          )}
        </DetailRow>
        <DetailRow term="Confidence">
          {/* Nothing is shown when the API supplied nothing. */}
          {conf ?? <span className="text-ink-2">Not reported</span>}
        </DetailRow>
        <DetailRow term="Extracted">{formatDateTime(d.extracted_at)}</DetailRow>
        <DetailRow term="Model">{d.model_version || '—'}</DetailRow>
      </dl>
    </Panel>
  );
}

// --------------------------------------------------------------- actions

function ActionsPane({
  d,
  busy,
  onReview,
}: {
  d: DiagnosisDetail;
  busy: boolean;
  onReview: (p: {
    action: 'confirm' | 'correct' | 'reject';
    corrected_text?: string;
    corrected_qualifier?: Qualifier;
    comment?: string;
  }) => void;
}) {
  const [mode, setMode] = useState<'none' | 'correct' | 'reject'>('none');
  const [text, setText] = useState(d.cleaned_text || d.raw_text || '');
  const [qualifier, setQualifier] = useState<Qualifier>(d.qualifier);
  const [comment, setComment] = useState('');

  return (
    <Panel
      title="Your decision"
      description="Every action is appended to the history. The AI's original output is never overwritten."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => onReview({ action: 'confirm', comment: comment.trim() || undefined })}
        >
          Confirm as read
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setMode(mode === 'correct' ? 'none' : 'correct')}>
          Correct the text
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => setMode(mode === 'reject' ? 'none' : 'reject')}>
          Reject
        </Button>
      </div>

      {mode === 'correct' ? (
        <div className="mt-3 space-y-3 border-t border-rule pt-3">
          <TextArea
            label="Corrected text"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            hint="Type what the record actually says. The AI's raw transcription stays on this screen unchanged."
          />
          <Select
            label="Corrected qualifier"
            value={qualifier}
            onChange={(e) => setQualifier(e.target.value as Qualifier)}
            hint="Correct this if the record's wording makes it provisional, suspected, ruled out or historical."
          >
            {QUALIFIERS.map((q) => (
              <option key={q} value={q}>
                {qualifierView(q).label}
              </option>
            ))}
          </Select>
          <TextArea
            label="Comment"
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || text.trim().length === 0}
            onClick={() => {
              onReview({
                action: 'correct',
                corrected_text: text.trim(),
                corrected_qualifier: qualifier,
                comment: comment.trim() || undefined,
              });
              setMode('none');
              setComment('');
            }}
          >
            Save correction
          </Button>
        </div>
      ) : null}

      {mode === 'reject' ? (
        <div className="mt-3 space-y-3 rounded border border-plot/50 p-3">
          <p className="text-[13px] text-ink">
            Rejecting marks this extraction as not usable. It is not deleted — the AI output and your
            reason both stay in the history.
          </p>
          <TextArea
            label="Reason (required)"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            variant="danger"
            disabled={busy || comment.trim().length === 0}
            onClick={() => {
              onReview({ action: 'reject', comment: comment.trim() });
              setMode('none');
              setComment('');
            }}
          >
            Reject extraction
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

// --------------------------------------------------------------- history

function HistoryPane({ d }: { d: DiagnosisDetail }) {
  const reviews = d.reviews ?? [];

  return (
    <Panel
      title="Correction history"
      description="Append-only. Each entry sits alongside the original AI output rather than replacing it."
    >
      {reviews.length === 0 ? (
        <p className="text-[13px] text-ink-2">
          No one has reviewed this extraction yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="border-l-2 border-rule pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <ReviewedBadge action={r.action} />
                <span className="text-[11px] text-ink-2">
                  {r.reviewer_name || r.reviewer_id} · {formatDateTime(r.created_at)}
                </span>
              </div>
              {r.corrected_text ? (
                <div className="mt-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                    Corrected text
                  </p>
                  <p className="whitespace-pre-wrap font-mono text-[13px] text-ink">
                    {r.corrected_text}
                  </p>
                </div>
              ) : null}
              {r.corrected_qualifier ? (
                <p className="mt-1 text-[13px]">
                  <span className="text-ink-2">Qualifier corrected to: </span>
                  <StatusPill view={qualifierView(r.corrected_qualifier)} size="sm" />
                </p>
              ) : null}
              {r.comment ? (
                <p className="mt-1 text-[13px] text-ink">{r.comment}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {reviews.length > 0 ? (
        <p className="mt-3 rounded bg-paper-2 p-2 text-[11px] text-ink-2">
          The AI’s original transcription remains visible above, unchanged, whatever corrections were made.
        </p>
      ) : null}
    </Panel>
  );
}
