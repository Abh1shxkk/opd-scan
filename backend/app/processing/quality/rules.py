"""Turning measurements into findings and a page classification.

Separated from ``metrics.py`` on purpose: a site can retune every number below from Settings
without anyone touching the image-processing code.

Four rules are enforced structurally rather than by convention:

1. A page that could not be measured is ``failed`` — never ``acceptable``.
2. A blank page is ``blank``, its own class, because a blank page in a case file is often
   deliberate. It is never counted as a defect and never as an accepted page.
3. Handwriting is not considered here at all — it is not a scan-quality defect.
4. Cut-off is always phrased as a suspicion. Nothing can be known about content outside the image.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.processing.quality.metrics import PageMetrics, Region

# --------------------------------------------------------------- defect codes

BLUR = "blur"
FAINT = "faint"
DARK = "dark"
LOW_CONTRAST = "low_contrast"
NOISE = "noise"
ROTATED = "rotated"
SKEWED = "skewed"
GLARE = "glare"
SHADOW = "shadow"
UNREADABLE_REGION = "unreadable_region"
SUSPECTED_CUTOFF = "suspected_cutoff"
BITONAL_LOSS = "bitonal_loss"
LOW_RESOLUTION = "low_resolution"
NEAR_BLANK = "near_blank"

DEFECT_LABELS: dict[str, str] = {
    BLUR: "Blurred / out of focus",
    FAINT: "Faint — ink barely separated from paper",
    DARK: "Under-exposed / too dark",
    LOW_CONTRAST: "Low overall contrast",
    NOISE: "Noisy / speckled",
    ROTATED: "Incorrectly rotated",
    SKEWED: "Excessively skewed",
    GLARE: "Glare / blown highlights",
    SHADOW: "Shadow across the page",
    UNREADABLE_REGION: "Region(s) likely unreadable",
    SUSPECTED_CUTOFF: "Suspected cut-off page edge or text",
    BITONAL_LOSS: "Saved as 1-bit — mid-tones lost",
    LOW_RESOLUTION: "Text too small for reliable reading",
    NEAR_BLANK: "Nearly blank",
}

DEFECT_ORDER = list(DEFECT_LABELS.keys())


DEFAULT_THRESHOLDS: dict[str, Any] = {
    # blank / near blank
    "blank_ink_coverage": 0.004,
    "blank_component_count": 40,
    "near_blank_ink_coverage": 0.015,
    # Sharpness — stroke_sharpness is resolution independent and never applied to bitonal pages.
    # Calibrated by Gaussian-blurring a crisp flatbed page from the pilot set and reading the metric
    # at each step: crisp 3.86, σ=1.5 (soft but readable) 2.09, σ=2.5 (clearly blurred) 1.45,
    # σ=4 (barely readable) 1.01, σ=6 (unreadable) 0.66. Across the 95 pilot pages the 5th
    # percentile is 2.28 and the minimum 1.25, so these values flag roughly the worst 5% of that
    # material — which matches a visual check of which pages are actually soft.
    "sharpness_min": 2.0,
    "sharpness_severe": 1.2,
    "sharpness_min_ink_coverage": 0.005,
    # faint / contrast
    "faint_ink_paper_contrast": 45.0,
    "faint_severe_contrast": 28.0,
    "low_contrast_ink_paper": 70.0,
    # exposure
    "dark_median_luma": 120.0,
    "dark_severe_median_luma": 85.0,
    # noise
    "noise_sigma": 3.0,
    "noise_sigma_severe": 6.0,
    "min_snr": 12.0,
    # geometry
    "skew_deg": 1.5,
    "skew_severe_deg": 3.5,
    "rotation_confident": 0.55,
    "rotation_uncertain": 0.30,
    "orientation_min_components": 120,
    # illumination
    "glare_area_fraction": 0.015,
    "glare_area_fraction_severe": 0.07,
    "shadow_area_fraction": 0.10,
    "illumination_ratio": 2.2,
    # localisation
    "unreadable_tile_fraction": 0.20,
    # resolution
    "min_text_height_px": 9.0,
    # classification
    "rescan_severity_score": 6.0,
    "review_severity_score": 2.5,
}

_SEV_WEIGHT = {"low": 1.0, "medium": 2.5, "high": 6.0}

# A single high-severity legibility problem means rescan on its own, whatever the total score.
_LEGIBILITY_CODES = (BLUR, FAINT, DARK, UNREADABLE_REGION, ROTATED)


@dataclass
class Finding:
    code: str
    severity: str
    detail: str
    confidence: float | None = None
    source: str = "local"
    region: Region | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "label": DEFECT_LABELS.get(self.code, self.code),
            "severity": self.severity,
            "detail": self.detail,
            "confidence": self.confidence,
            "source": self.source,
            "region": self.region.as_dict() if self.region else None,
        }


@dataclass
class Judgement:
    overall: str            # acceptable | review | rescan | blank | failed
    score: float            # 0..1, higher is better
    findings: list[Finding]
    thresholds_hash: str


def thresholds_hash(th: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(th, sort_keys=True, default=str).encode()).hexdigest()[:16]


def judge(m: PageMetrics, thresholds: dict[str, Any] | None = None) -> Judgement:
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    h = thresholds_hash(th)
    f: list[Finding] = []

    if m.error or m.width == 0 or m.height == 0:
        return Judgement("failed", 0.0, [], h)

    # ------------------------------------------------- degenerate captures
    # A sheet of paper that carries nothing is blank. A frame that is uniformly dark carries
    # nothing either, but it is a scanner lid left open or a badly under-exposed capture — not a
    # blank page in the file. Checking this first stops such a page being reported as blank with a
    # perfect score, which is the one way this classifier could hide a total capture failure.
    if m.median_luma < th["dark_severe_median_luma"] and m.text_ink_coverage < th["blank_ink_coverage"]:
        return Judgement(
            "rescan",
            0.0,
            [
                Finding(
                    DARK,
                    "high",
                    f"The whole frame is dark (median luminance {m.median_luma:.0f} of 255) and no "
                    "content could be measured. This looks like a failed capture rather than a "
                    "blank page.",
                    confidence=0.9,
                )
            ],
            h,
        )

    # ---------------------------------------------------------------- blank
    if m.text_ink_coverage < th["blank_ink_coverage"] and m.text_component_count < th["blank_component_count"]:
        # Reported as blank and nothing else: calling an empty page "blurred" is meaningless.
        return Judgement("blank", 1.0, [], h)

    near_blank = m.text_ink_coverage < th["near_blank_ink_coverage"]
    if near_blank:
        f.append(
            Finding(
                NEAR_BLANK,
                "low",
                f"Only {m.text_ink_coverage * 100:.2f}% of the sheet carries writing. May be intentional — "
                "confirm against the expected document before requesting a rescan.",
                confidence=0.6,
            )
        )

    # --------------------------------------------------------------- bitonal
    if m.is_bitonal:
        f.append(
            Finding(
                BITONAL_LOSS,
                "medium",
                "Stored with only black and white values. Pencil, faint pen and stamp shading "
                "cannot be recovered from this file even though it may look sharp.",
                confidence=0.95,
            )
        )

    # -------------------------------------------------------------- sharpness
    if not m.is_bitonal and m.ink_coverage >= th["sharpness_min_ink_coverage"] and m.stroke_sharpness > 0:
        if m.stroke_sharpness < th["sharpness_severe"]:
            f.append(
                Finding(
                    BLUR,
                    "high",
                    f"Ink edges spread over several pixels (stroke sharpness {m.stroke_sharpness:.3f}).",
                    confidence=0.8,
                    region=m.worst_tile,
                )
            )
        elif m.stroke_sharpness < th["sharpness_min"]:
            f.append(
                Finding(
                    BLUR,
                    "medium",
                    f"Soft ink edges (stroke sharpness {m.stroke_sharpness:.3f}).",
                    confidence=0.6,
                    region=m.worst_tile,
                )
            )

    # ------------------------------------------------------- faint / contrast
    if not near_blank:
        if m.ink_paper_contrast < th["faint_severe_contrast"]:
            f.append(
                Finding(
                    FAINT,
                    "high",
                    f"Ink sits only {m.ink_paper_contrast:.0f} grey levels below the paper; much of "
                    "the writing is likely unrecoverable.",
                    confidence=0.85,
                    region=m.worst_tile,
                )
            )
        elif m.ink_paper_contrast < th["faint_ink_paper_contrast"]:
            f.append(
                Finding(
                    FAINT,
                    "medium",
                    f"Ink/paper separation only {m.ink_paper_contrast:.0f} grey levels.",
                    confidence=0.65,
                    region=m.worst_tile,
                )
            )
        # "Low contrast" sits between comfortable and faint. It is measured on ink-vs-paper
        # separation, not on the page's dynamic range: a sparse page of clean writing on white
        # paper has a small dynamic range and is perfectly readable, and an earlier version of this
        # rule flagged dozens of such pages.
        elif m.ink_paper_contrast < th["low_contrast_ink_paper"]:
            f.append(
                Finding(
                    LOW_CONTRAST,
                    "medium",
                    f"Reduced ink/paper separation ({m.ink_paper_contrast:.0f} grey levels). "
                    "Legible in places but weak; enhancement or a rescan would improve both human "
                    "reading and OCR.",
                    confidence=0.6,
                    region=m.worst_tile,
                )
            )

    # ------------------------------------------------------------- exposure
    if m.median_luma < th["dark_severe_median_luma"]:
        f.append(Finding(DARK, "high", f"Median luminance {m.median_luma:.0f} of 255.", confidence=0.85))
    elif m.median_luma < th["dark_median_luma"]:
        f.append(Finding(DARK, "medium", f"Median luminance {m.median_luma:.0f} of 255.", confidence=0.65))

    # ---------------------------------------------------------------- noise
    if not m.is_bitonal:
        if m.noise_sigma > th["noise_sigma_severe"]:
            f.append(Finding(NOISE, "high", f"Noise sigma {m.noise_sigma:.1f}.", confidence=0.75))
        elif m.noise_sigma > th["noise_sigma"] and m.snr < th["min_snr"]:
            f.append(
                Finding(
                    NOISE,
                    "medium",
                    f"Noise sigma {m.noise_sigma:.1f} against ink contrast "
                    f"{m.ink_paper_contrast:.0f} (SNR {m.snr:.1f}).",
                    confidence=0.6,
                )
            )

    # ------------------------------------------------------------- geometry
    # Orientation is only judged when there is enough writing to judge, and even then the local
    # signal is advisory. Measured against the sample set, image-only orientation detection could
    # not separate a genuinely sideways page from an upright page carrying tall ruled columns
    # (an ENT examination sheet and a bitonal ward chart both looked "rotated"). So a confident
    # local signal raises a rescan, an uncertain one only asks a human to glance, and a configured
    # OCR provider — which reads the glyphs, and is the only thing that can also tell 0° from
    # 180° — overrides both. See docs/EVALUATION.md.
    if m.text_component_count >= th["orientation_min_components"] and m.rotation_deg in (90, 270):
        if m.rotation_confidence >= th["rotation_confident"]:
            f.append(
                Finding(
                    ROTATED,
                    "high",
                    f"Text runs vertically; the page appears rotated by {m.rotation_deg}°.",
                    confidence=round(min(0.95, 0.35 + m.rotation_confidence), 2),
                )
            )
        elif m.rotation_confidence >= th["rotation_uncertain"]:
            f.append(
                Finding(
                    ROTATED,
                    "medium",
                    "Orientation uncertain — the page may be sideways, or may simply carry tall "
                    "ruled columns. Not confirmed; OCR is needed to be sure.",
                    confidence=round(m.rotation_confidence, 2),
                )
            )

    if m.text_component_count >= th["orientation_min_components"]:
        if abs(m.skew_deg) >= th["skew_severe_deg"]:
            f.append(Finding(SKEWED, "high", f"Text skewed {m.skew_deg:+.1f}°.", confidence=0.8))
        elif abs(m.skew_deg) >= th["skew_deg"]:
            f.append(Finding(SKEWED, "low", f"Text skewed {m.skew_deg:+.1f}°.", confidence=0.6))

    # --------------------------------------------------------- illumination
    if m.glare_area_fraction > th["glare_area_fraction"]:
        f.append(
            Finding(
                GLARE,
                "high" if m.glare_area_fraction > th["glare_area_fraction_severe"] else "medium",
                f"{m.glare_area_fraction * 100:.1f}% of the sheet is blown out relative to the "
                "surrounding paper.",
                confidence=0.7,
                region=m.glare_regions[0] if m.glare_regions else None,
            )
        )

    if m.shadow_area_fraction > th["shadow_area_fraction"] or m.illumination_ratio > th["illumination_ratio"]:
        f.append(
            Finding(
                SHADOW,
                "medium",
                f"Uneven lighting: {m.shadow_area_fraction * 100:.0f}% of the sheet in shadow, "
                f"bright/dark ratio {m.illumination_ratio:.1f}.",
                confidence=0.65,
                region=m.shadow_regions[0] if m.shadow_regions else None,
            )
        )

    # ------------------------------------------------------ unreadable areas
    if m.tile_count >= 4 and (m.low_contrast_tiles / m.tile_count) > th["unreadable_tile_fraction"]:
        frac = m.low_contrast_tiles / m.tile_count
        f.append(
            Finding(
                UNREADABLE_REGION,
                "high" if frac > 0.45 else "medium",
                f"{m.low_contrast_tiles} of {m.tile_count} content areas have too little ink/paper "
                "separation to read.",
                confidence=0.7,
                region=m.worst_tile,
            )
        )

    # ----------------------------------------------------------- resolution
    if 0 < m.est_text_height_px < th["min_text_height_px"]:
        detail = f"Estimated character height {m.est_text_height_px:.1f}px"
        detail += f" (≈{m.est_dpi:.0f} dpi equivalent)." if m.est_dpi else "."
        f.append(Finding(LOW_RESOLUTION, "medium", detail, confidence=0.55))

    # -------------------------------------------------------------- cut-off
    if m.cutoff_edges:
        edges = ", ".join(sorted(set(m.cutoff_edges)))
        f.append(
            Finding(
                SUSPECTED_CUTOFF,
                "high" if len(set(m.cutoff_edges)) >= 2 else "medium",
                f"Writing runs into the image edge ({edges}) and the sheet's own edge is not visible "
                "there. Content may continue beyond the capture; this cannot be confirmed from the "
                "image alone.",
                confidence=0.6,
                region=m.cutoff_regions[0] if m.cutoff_regions else None,
            )
        )

    # ------------------------------------------------------- classification
    penalty = sum(_SEV_WEIGHT[x.severity] for x in f)
    if penalty >= th["rescan_severity_score"]:
        overall = "rescan"
    elif penalty >= th["review_severity_score"]:
        overall = "review"
    else:
        overall = "acceptable"

    if any(x.severity == "high" and x.code in _LEGIBILITY_CODES for x in f):
        overall = "rescan"

    score = max(0.0, 1.0 - min(1.0, penalty / 12.0))
    return Judgement(overall, round(score, 3), f, h)


def merge_provider_defects(
    findings: list[Finding], provider_defects: list[dict[str, Any]], provider_name: str
) -> list[Finding]:
    """Fold a provider's own defect list in beside the local measurements.

    Provider findings are additive evidence tagged ``source='provider'`` so a reviewer can always
    see which engine said what. They never replace the local analysis, and a provider that did not
    answer simply contributes nothing.
    """
    mapping = {
        "quality/defect_blurry": BLUR,
        "quality/defect_noisy": NOISE,
        "quality/defect_dark": DARK,
        "quality/defect_faint": FAINT,
        "quality/defect_text_too_small": LOW_RESOLUTION,
        "quality/defect_document_cutoff": SUSPECTED_CUTOFF,
        "quality/defect_text_cutoff": SUSPECTED_CUTOFF,
        "quality/defect_glare": GLARE,
    }
    out = list(findings)
    for d in provider_defects or []:
        code = mapping.get(d.get("type", ""))
        if not code:
            continue
        conf = float(d.get("confidence") or 0.0)
        sev = "high" if conf >= 0.75 else ("medium" if conf >= 0.45 else "low")
        out.append(
            Finding(
                code,
                sev,
                f"{provider_name} reported {d.get('type')} at confidence {conf:.2f}.",
                confidence=conf,
                source="provider",
            )
        )
    return out


def reclassify(findings: list[Finding], thresholds: dict[str, Any] | None = None) -> tuple[str, float]:
    """Recompute the class after provider findings have been merged in."""
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    penalty = sum(_SEV_WEIGHT[x.severity] for x in findings)
    if penalty >= th["rescan_severity_score"]:
        overall = "rescan"
    elif penalty >= th["review_severity_score"]:
        overall = "review"
    else:
        overall = "acceptable"
    if any(x.severity == "high" and x.code in _LEGIBILITY_CODES for x in findings):
        overall = "rescan"
    return overall, round(max(0.0, 1.0 - min(1.0, penalty / 12.0)), 3)
