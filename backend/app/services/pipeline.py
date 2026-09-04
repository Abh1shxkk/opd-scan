"""Per-page processing: quality, handwriting, diagnosis — three separate, independent states.

Keeping them separate is the point. A provider outage must leave the quality verdict intact and
must not turn into "no handwriting on this page"; a page whose handwriting model failed must not be
reported as clean. Each stage writes its own row with its own status.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from sqlalchemy.orm import Session

from app.config import settings
from app.core.audit import log_error
from app.core.storage import get_storage
from app.models import (
    DiagnosisExtraction,
    HandwritingRegion,
    HandwritingResult,
    PageVersion,
    PrescriptionAnalysis,
    PrescriptionMedicine,
    QualityFinding,
    QualityResult,
)
from app.models.core import (
    ColourMode,
    DiagnosisStatus,
    HandwritingCategory,
    HandwritingStatus,
    PageClass,
    PrescriptionStatus,
    Qualifier,
    Severity,
)
from app.processing import ingest
from app.processing.extract import diagnosis as diag_extract
from app.processing.extract import handwriting as hw_extract
from app.processing.providers import router as provider_router
from app.processing.providers.base import (
    OcrPage,
    ProviderError,
    ProviderUnconfigured,
    ProviderUnsupported,
)
from app.processing.quality import metrics as qmetrics
from app.processing.quality import rules as qrules
from app.services.settings_store import get_thresholds


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_render(pv: PageVersion) -> np.ndarray | None:
    try:
        data = get_storage().get_bytes(pv.storage_key_render)
    except Exception as exc:
        log_error(f"render fetch failed: {type(exc).__name__}", page_version_id=pv.id)
        return None
    return ingest.bytes_to_image(data)


# --------------------------------------------------------------------- quality


def run_quality(db: Session, pv: PageVersion) -> QualityResult:
    """Measure the ORIGINAL render and classify it.

    The local engine always runs. When an OCR provider that publishes its own quality signals is
    configured, those are merged in as additional evidence tagged ``source='provider'`` — they never
    replace the local measurements, and their absence changes nothing.
    """
    result = pv.quality or QualityResult(page_version_id=pv.id)
    result.engine_version = qmetrics.ENGINE_VERSION
    result.computed_at = _now()
    for old in list(result.findings):
        db.delete(old)
    result.findings = []
    # Flush before writing findings: the primary key is generated on INSERT, so a not-yet-flushed
    # parent leaves every child row with a null foreign key.
    db.add(result)
    db.flush()

    image = _load_render(pv)
    if image is None:
        result.overall = PageClass.failed
        result.score = None
        result.provider_error = "The stored render could not be read."
        db.add(result)
        return result

    bpc = 1 if pv.colour_mode == ColourMode.bitonal else None
    m = qmetrics.measure(image, source_bits_per_component=bpc)
    thresholds = get_thresholds(db)
    judgement = qrules.judge(m, thresholds)
    findings = list(judgement.findings)
    overall, score = judgement.overall, judgement.score

    # Optional provider corroboration.
    provider_used = None
    provider_error = None
    if settings.ocr_provider != "none":
        try:
            payload, mime = ingest.image_to_upload_bytes(image)
            page: OcrPage = provider_router.analyse(payload, mime, "ocr", _language_hints(printed_only=True))
            provider_used = page.provider
            if page.detected_defects:
                findings = qrules.merge_provider_defects(findings, page.detected_defects, page.provider)
            if page.orientation_deg in (90, 180, 270):
                findings = [f for f in findings if f.code != qrules.ROTATED]
                findings.append(
                    qrules.Finding(
                        qrules.ROTATED,
                        "high",
                        f"{page.provider} read the page as rotated by {page.orientation_deg}°.",
                        confidence=0.9,
                        source="provider",
                    )
                )
            elif page.orientation_deg == 0:
                # The provider read the text upright, which settles it — drop the local guess.
                findings = [f for f in findings if not (f.code == qrules.ROTATED and f.source == "local")]
            if overall not in ("blank", "failed"):
                overall, score = qrules.reclassify(findings, thresholds)
        except ProviderUnconfigured as exc:
            provider_error = f"setup required: {exc}"
        except (ProviderError, ProviderUnsupported) as exc:
            provider_error = str(exc)

    result.overall = PageClass(overall)
    result.score = score
    result.thresholds_hash = judgement.thresholds_hash
    result.provider_used = provider_used
    result.provider_error = provider_error
    result.raw_metrics_json = m.to_json()

    for f in findings:
        db.add(
            QualityFinding(
                quality_result_id=result.id,
                defect_code=f.code,
                severity=Severity(f.severity),
                confidence=f.confidence,
                source=f.source,
                detail=f.detail,
                region_json=f.region.as_dict() if f.region else None,
            )
        )

    # Detected capture facts are recorded on the version so the viewer can label them.
    pv.capture_profile = pv.capture_profile.__class__(m.capture_profile)
    if m.is_bitonal:
        pv.colour_mode = ColourMode.bitonal
    pv.dpi_estimate = int(m.est_dpi) if m.est_dpi else pv.dpi_estimate

    db.add(result)
    return result


def _language_hints(printed_only: bool = False, handwritten: bool = False) -> list[str]:
    """Language hints for the configured deployment."""
    base = settings.document_languages_list
    if handwritten:
        return [f"{b}:handwritten" for b in base]
    return base if not printed_only else base


# ----------------------------------------------------------------- handwriting


def run_handwriting(db: Session, pv: PageVersion) -> HandwritingResult:
    """Check every page for handwriting — including pages the quality engine called acceptable."""
    result = pv.handwriting or HandwritingResult(page_version_id=pv.id)
    result.computed_at = _now()
    for old in list(result.regions):
        db.delete(old)
    result.regions = []

    if settings.handwriting_provider == "none" and settings.handwriting_devanagari_provider == "none":
        result.status = HandwritingStatus.unconfigured
        result.error = (
            "No handwriting provider is configured. Set HANDWRITING_PROVIDER (and "
            "HANDWRITING_DEVANAGARI_PROVIDER for Hindi) to enable handwriting detection. "
            "Until then handwriting is UNKNOWN for this page, not absent."
        )
        db.add(result)
        return result

    image = _load_render(pv)
    if image is None:
        result.status = HandwritingStatus.failed
        result.error = "The stored render could not be read."
        db.add(result)
        return result

    try:
        payload, mime = ingest.image_to_upload_bytes(image)
        page = provider_router.analyse(payload, mime, "handwriting", _language_hints(handwritten=True))
    except ProviderUnconfigured as exc:
        result.status = HandwritingStatus.unconfigured
        result.error = str(exc)
        db.add(result)
        return result
    except ProviderUnsupported as exc:
        result.status = HandwritingStatus.failed
        result.error = f"unsupported: {exc}"
        db.add(result)
        return result
    except ProviderError as exc:
        result.status = HandwritingStatus.failed
        result.error = str(exc)
        db.add(result)
        return result

    data = hw_extract.detect(page, image)
    result.model_version = data.model_version
    result.provider_used = data.provider
    result.error = data.error
    result.status = {
        "detected": HandwritingStatus.detected,
        "none_detected": HandwritingStatus.none_detected,
        "failed": HandwritingStatus.failed,
        "unsupported": HandwritingStatus.failed,
        "unconfigured": HandwritingStatus.unconfigured,
    }[data.status]

    db.add(result)
    db.flush()
    for r in data.regions:
        db.add(
            HandwritingRegion(
                handwriting_result_id=result.id,
                category=HandwritingCategory(r.category),
                category_confidence=r.category_confidence,
                confidence=r.confidence,
                script_hint=r.script_hint,
                polygon_json=r.polygon,
                model_version=data.model_version,
            )
        )
    return result


# ------------------------------------------------------------------- diagnosis


def run_diagnosis(db: Session, pv: PageVersion) -> list[DiagnosisExtraction]:
    """Transcribe any diagnosis already recorded on this page.

    Existing extractions for this page version are replaced, but only those that have never been
    reviewed. A reviewer's confirmation or correction is never discarded by a re-run.
    """
    for old in list(pv.diagnoses):
        if not old.reviews:
            db.delete(old)

    if settings.diagnosis_provider == "none":
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.unconfigured,
            model_version=diag_extract.EXTRACTOR_VERSION,
            error=(
                "No diagnosis provider is configured. Set DIAGNOSIS_PROVIDER to enable extraction. "
                "No conclusion is drawn about whether this page carries a diagnosis."
            ),
        )
        db.add(rec)
        return [rec]

    image = _load_render(pv)
    if image is None:
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.processing_failed,
            model_version=diag_extract.EXTRACTOR_VERSION,
            error="The stored render could not be read.",
        )
        db.add(rec)
        return [rec]

    try:
        payload, mime = ingest.image_to_upload_bytes(image)
        page = provider_router.analyse(payload, mime, "diagnosis", _language_hints())
    except ProviderUnconfigured as exc:
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.unconfigured,
            model_version=diag_extract.EXTRACTOR_VERSION,
            error=str(exc),
        )
        db.add(rec)
        return [rec]
    except (ProviderError, ProviderUnsupported) as exc:
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.processing_failed,
            model_version=diag_extract.EXTRACTOR_VERSION,
            error=str(exc),
        )
        db.add(rec)
        return [rec]

    candidates = diag_extract.extract(page)
    if not candidates:
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.not_found,
            model_version=f"{page.model_version}+{diag_extract.EXTRACTOR_VERSION}",
            provider_used=page.provider,
        )
        db.add(rec)
        return [rec]

    out: list[DiagnosisExtraction] = []
    for c in candidates:
        rec = DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus(c.status),
            anchor_label=c.anchor_label,
            raw_text=c.raw_text,
            cleaned_text=c.cleaned_text,
            qualifier=Qualifier(c.qualifier),
            icd_code_verbatim=c.icd_code_verbatim,
            is_handwritten=c.is_handwritten,
            region_json=(
                {**c.region, "note": c.note, "cleaning_applied": c.cleaning_applied,
                 "ambiguous_abbreviations": c.ambiguous_abbreviations}
                if c.region
                else {"note": c.note, "cleaning_applied": c.cleaning_applied,
                      "ambiguous_abbreviations": c.ambiguous_abbreviations}
            ),
            confidence=c.confidence,
            model_version=f"{page.model_version}+{diag_extract.EXTRACTOR_VERSION}",
            provider_used=page.provider,
        )
        db.add(rec)
        out.append(rec)
    return out


# -------------------------------------------------------------- prescription


def run_prescription(db: Session, pv: PageVersion) -> PrescriptionAnalysis:
    """Two-stage: read the page with whichever OCR provider is already configured (``ocr_provider``
    — Google Document AI in this deployment), then hand that text plus the image to the configured
    reasoning provider (Gemini) to structure it. Neither stage is skipped or faked when the other is
    unavailable; an OCR failure here is reported the same way a quality/handwriting OCR failure is —
    never silently treated as "no prescription found"."""
    result = pv.prescription or PrescriptionAnalysis(page_version_id=pv.id)
    result.computed_at = _now()
    for old in list(result.medicines):
        db.delete(old)
    result.medicines = []

    if settings.ocr_provider == "none" or settings.prescription_reasoning_provider == "none":
        result.status = PrescriptionStatus.unconfigured
        result.error = (
            "OCR_PROVIDER and PRESCRIPTION_REASONING_PROVIDER must both be set to enable "
            "prescription understanding. Until then nothing is claimed about this page."
        )
        db.add(result)
        return result

    image = _load_render(pv)
    if image is None:
        result.status = PrescriptionStatus.processing_failed
        result.error = "The stored render could not be read."
        db.add(result)
        return result

    try:
        payload, mime = ingest.image_to_upload_bytes(image)
        ocr_page = provider_router.analyse(payload, mime, "ocr", _language_hints())
    except ProviderUnconfigured as exc:
        result.status = PrescriptionStatus.unconfigured
        result.error = str(exc)
        db.add(result)
        return result
    except (ProviderError, ProviderUnsupported) as exc:
        result.status = PrescriptionStatus.processing_failed
        result.error = str(exc)
        db.add(result)
        return result

    result.raw_extracted_text = ocr_page.full_text
    result.ocr_provider_used = ocr_page.provider

    reasoning_provider = provider_router.get_reasoning_provider(settings.prescription_reasoning_provider)
    try:
        reading = reasoning_provider.interpret(ocr_page.full_text, payload, mime, _language_hints())
    except ProviderUnconfigured as exc:
        result.status = PrescriptionStatus.unconfigured
        result.error = str(exc)
        db.add(result)
        return result
    except ProviderError as exc:
        result.status = PrescriptionStatus.processing_failed
        result.error = str(exc)
        db.add(result)
        return result

    result.status = (
        PrescriptionStatus.not_a_prescription
        if not reading.medicines and "not a prescription" in reading.possible_interpretation.lower()
        else PrescriptionStatus.extracted_pending_review
    )
    result.language_detected = reading.language_detected
    result.diagnosis_or_notes = reading.diagnosis_or_notes
    result.possible_interpretation = reading.possible_interpretation
    result.patient_explanation = reading.patient_explanation
    result.safety_warnings_json = reading.safety_warnings
    result.uncertainties_json = reading.uncertainties
    # Never trust the model's own "false" at face value if it also reported low-confidence medicines
    # or any uncertainty — the DB-side default stays conservative regardless of what was returned.
    result.requires_professional_confirmation = reading.requires_professional_confirmation or any(
        m.confidence != "high" for m in reading.medicines
    ) or bool(reading.uncertainties)
    result.reasoning_provider_used = reading.provider
    result.model_version = f"{ocr_page.model_version}+{reading.model_version}"
    result.error = None

    db.add(result)
    db.flush()
    for m in reading.medicines:
        db.add(
            PrescriptionMedicine(
                analysis_id=result.id,
                name=m.name,
                dose=m.dose,
                frequency=m.frequency,
                duration=m.duration,
                general_use=m.general_use,
                confidence=m.confidence,
                uncertainty=m.uncertainty,
            )
        )
    return result
