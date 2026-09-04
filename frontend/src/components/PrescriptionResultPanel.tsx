/**
 * Rendering for one page's prescription reading.
 *
 * Shared between the standalone analyzer's "just finished" flow and the dedicated per-document
 * result page, so the two never drift out of sync on what a reading actually shows.
 */

import { MEDICINE_CONFIDENCE_LABEL, prescriptionView } from '../lib/status';
import type { PrescriptionAnalysisPage } from '../lib/types';
import { StatusPill } from './StatusPill';

export function PrescriptionPageDetails({ page, multi }: { page: PrescriptionAnalysisPage; multi: boolean }) {
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
