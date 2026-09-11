/**
 * Rendering for one page's prescription reading.
 *
 * Shared between the standalone analyzer's "just finished" flow and the dedicated per-document
 * result page, so the two never drift out of sync on what a reading actually shows.
 *
 * Also owns the "Correct this reading" action. A correction is recorded as a page review (like a
 * scan-quality correction) — it never rewrites the stored reading. The reviewer's note is later fed
 * back to Gemini as a general lesson on future prescriptions (see backend pipeline.run_prescription
 * and gemini.py) — never as training, and never carrying this patient's own medicine/dose data into
 * someone else's reading, only the written lesson itself.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MEDICINE_CONFIDENCE_LABEL, prescriptionView } from '../lib/status';
import type { PrescriptionAnalysisPage } from '../lib/types';
import { Modal } from './Modal';
import { StatusPill } from './StatusPill';
import { useToast } from './Toast';
import { Button, TextArea } from './ui';
import { TriangleAlert } from 'lucide-react';

export function PrescriptionPageDetails({
  page,
  multi,
}: {
  page: PrescriptionAnalysisPage;
  multi: boolean;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [correcting, setCorrecting] = useState(false);
  const p = page.prescription;

  const correct = useMutation({
    mutationFn: (input: { category: string; comment: string }) =>
      api.reviewPage(page.page_version_id, {
        action: 'correct_prescription',
        comment: input.comment,
        payload: { category: input.category },
      }),
    onSuccess: () => {
      setCorrecting(false);
      toast.push(
        'Correction recorded. It will be used as a lesson for future readings.',
        'success',
      );
    },
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'The correction could not be saved.', 'error'),
  });

  const canCorrect = can('reviewer') && Boolean(p) && !p?.error;

  return (
    <div className={multi ? 'border-t border-rule pt-4 first:border-t-0 first:pt-0 ' : ''}>
      {multi ? <h3 className="mb-2 text-[13px] font-semibold text-ink">Page {page.ordinal}</h3> : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill view={prescriptionView(p?.status)} showDetail />
        {p?.language_detected ? (
          <span className="text-[11px] text-ink-2">Language: {p.language_detected}</span>
        ) : null}
        {canCorrect ? (
          <button
            type="button"
            onClick={() => setCorrecting(true)}
            className="ml-auto text-[11px] font-medium text-chart underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Correct this reading
          </button>
        ) : null}
      </div>

      {!p ? (
        <p className="text-[13px] text-ink-2">No result for this page.</p>
      ) : p.error ? (
        <p className="text-[13px] text-plot">{p.error}</p>
      ) : (
        <div className="space-y-4">
          {p.requires_professional_confirmation ? (
            <p className="rounded border border-note/50 bg-note/[0.07] px-3 py-2 text-[13px] text-ink">
              <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" className="mr-1 inline-block shrink-0 align-[-2px] text-note" />
              This reading has parts that are uncertain. Confirm every medicine, dose and
              instruction with the prescribing doctor or a pharmacist before acting on it.
            </p>
          ) : null}

          {p.safety_warnings.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-plot">
              {p.safety_warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}

          {p.medicines.length > 0 ? (
            <div>
              <h4 className="text-[13px] font-semibold text-ink">Medicines</h4>
              <ul className="mt-1 space-y-2">
                {p.medicines.map((m, i) => (
                  <li key={i} className="border-b border-rule px-2 py-2 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">
                        {m.name || 'Unreadable name'}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                          m.confidence === 'high'
                            ? 'bg-band/[0.07] text-ink '
                            : m.confidence === 'medium'
                              ? 'bg-note/[0.07] text-ink '
                              : 'bg-plot/[0.07] text-ink '
                        }`}
                      >
                        {MEDICINE_CONFIDENCE_LABEL[m.confidence] ?? m.confidence}
                      </span>
                    </div>
                    <dl className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-ink-2">
                      <div>
                        <dt className="text-ink-2">Dose</dt>
                        <dd>{m.dose || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-2">Frequency</dt>
                        <dd>{m.frequency || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-2">Duration</dt>
                        <dd>{m.duration || '—'}</dd>
                      </div>
                    </dl>
                    {m.general_use ? (
                      <p className="mt-1 text-[11px] text-ink-2">Generally used for: {m.general_use}</p>
                    ) : null}
                    {m.uncertainty ? (
                      <p className="mt-1 text-[11px] italic text-note">Uncertain: {m.uncertainty}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : p.status === 'extracted_pending_review' ? (
            <p className="text-[13px] text-ink-2">No medicines were read on this page.</p>
          ) : null}

          {p.possible_interpretation ? (
            <div>
              <h4 className="text-[13px] font-semibold text-ink">Possible interpretation</h4>
              <p className="mt-1 text-[13px] text-ink">{p.possible_interpretation}</p>
            </div>
          ) : null}

          {p.patient_explanation ? (
            <div>
              <h4 className="text-[13px] font-semibold text-ink">In plain language</h4>
              <p className="mt-1 text-[13px] text-ink">{p.patient_explanation}</p>
            </div>
          ) : null}

          {p.uncertainties.length > 0 ? (
            <div>
              <h4 className="text-[13px] font-semibold text-ink">Unclear or unreadable</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
                {p.uncertainties.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <details className="text-[13px]">
            <summary className="cursor-pointer font-medium text-ink-2">
              Raw OCR text (exact, unedited)
            </summary>
            <RawOcrText text={p.raw_extracted_text} />
          </details>

          <p className="border-t border-rule pt-3 text-[11px] text-ink-2">
            This reading is AI-generated and may contain errors, especially for handwriting. It is
            not a diagnosis and does not replace advice from the prescribing doctor or a pharmacist.
            Never start, stop, or change a medication based only on this reading.
          </p>
        </div>
      )}

      <CorrectPrescriptionDialog
        open={correcting}
        onClose={() => setCorrecting(false)}
        onSubmit={(category, comment) => correct.mutate({ category, comment })}
        submitting={correct.isPending}
      />
    </div>
  );
}

const CORRECTION_CATEGORIES = [
  ['medicine', 'A medicine name, dose, frequency or duration is wrong'],
  ['diagnosis', 'The diagnosis/notes or interpretation is wrong'],
  ['confidence', 'Something was marked uncertain but is actually clear (or the other way round)'],
  ['other', 'Something else'],
] as const;

function CorrectPrescriptionDialog({
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (category: string, comment: string) => void;
  submitting: boolean;
}) {
  const [category, setCategory] = useState<(typeof CORRECTION_CATEGORIES)[number][0]>('medicine');
  const [comment, setComment] = useState('');

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this reading"
      description="Your correction is recorded alongside the original reading, which is never overwritten. Describe the mistake and the correct reading in your own words — do not include the patient's name or other identifying details, since this note is also used as a general lesson for future prescriptions."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={comment.trim().length === 0 || submitting}
            onClick={() => onSubmit(category, comment.trim())}
          >
            {submitting ? 'Recording…' : 'Record correction'}
          </Button>
        </>
      }
    >
      <fieldset className="mb-3">
        <legend className="mb-1 text-[11px] font-medium text-ink">What is wrong with it?</legend>
        {CORRECTION_CATEGORIES.map(([value, label]) => (
          <label key={value} className="flex items-start gap-2 py-0.5 text-[13px]">
            <input
              type="radio"
              name="category"
              value={value}
              checked={category === value}
              onChange={() => setCategory(value)}
              className="mt-0.5 h-4 w-4 border-rule-2 text-chart focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <span className="text-ink">{label}</span>
          </label>
        ))}
      </fieldset>

      <TextArea
        label="What is the correct reading, and why (required)"
        rows={4}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
    </Modal>
  );
}

/**
 * Lays the OCR transcription out as one row per line instead of one dense paragraph.
 *
 * The text itself is never touched — every character the OCR engine returned is still shown,
 * verbatim, in the same order. This only adds line-by-line structure (and a bold label when a line
 * looks like "Label: value", a common shape on printed hospital forms) so a long transcription is
 * scannable instead of a wall of text.
 */
function RawOcrText({ text }: { text: string }) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return <p className="mt-1 text-[11px] text-ink-2">(no text was transcribed)</p>;
  }

  return (
    <div className="mt-1 max-h-96 overflow-y-auto border-y border-rule">
      <dl className="divide-y divide-rule">
        {lines.map((line, i) => {
          const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
          return (
            <div key={i} className="flex flex-wrap gap-x-2 px-2.5 py-1.5 odd:bg-paper-2">
              {m ? (
                <>
                  <dt className="w-32 shrink-0 font-mono text-[11px] font-semibold text-ink-2">
                    {m[1]}
                  </dt>
                  <dd className="min-w-0 flex-1 font-mono text-[11px] text-ink">{m[2]}</dd>
                </>
              ) : (
                <dd className="min-w-0 flex-1 font-mono text-[11px] text-ink">{line}</dd>
              )}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
