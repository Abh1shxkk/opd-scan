"""Invariants of the judgement layer.

These build :class:`PageMetrics` by hand so the rules can be exercised without any image
processing. Each test pins down one promise made in the module docstring of
``app/processing/quality/rules.py``.
"""

from __future__ import annotations

import pytest

from app.processing.quality.metrics import PageMetrics, Region
from app.processing.quality.rules import (
    BITONAL_LOSS,
    BLUR,
    DARK,
    DEFECT_LABELS,
    DEFECT_ORDER,
    FAINT,
    NOISE,
    ROTATED,
    SKEWED,
    SUSPECTED_CUTOFF,
    UNREADABLE_REGION,
    Finding,
    judge,
    reclassify,
    thresholds_hash,
)

# Thresholds that switch the *score* route to classification off entirely, so a test can prove that
# a single high-severity legibility finding forces a rescan on its own rather than by arithmetic.
SCORE_ROUTE_DISABLED = {"rescan_severity_score": 1000.0, "review_severity_score": 999.0}


def clean_metrics(**overrides) -> PageMetrics:
    """A page with nothing wrong with it. Every test starts here and breaks one thing."""
    m = PageMetrics(
        width=1240,
        height=1754,
        aspect=1240 / 1754,
        orientation="portrait",
        unique_levels=180,
        is_bitonal=False,
        colour_mode="colour",
        paper_level=246.0,
        ink_level=96.0,
        ink_paper_contrast=150.0,
        median_luma=240.0,
        stroke_sharpness=3.9,
        noise_sigma=0.5,
        snr=300.0,
        ink_coverage=0.09,
        text_ink_coverage=0.09,
        text_component_count=430,
        est_text_height_px=23.0,
        est_dpi=207.0,
        skew_deg=0.0,
        rotation_deg=0,
        rotation_confidence=0.0,
        tile_count=30,
        low_contrast_tiles=0,
    )
    for key, value in overrides.items():
        setattr(m, key, value)
    return m


def codes(judgement) -> list[str]:
    return [f.code for f in judgement.findings]


# --------------------------------------------------------------------- baseline


def test_clean_metrics_are_acceptable_with_no_findings():
    j = judge(clean_metrics())
    assert j.overall == "acceptable"
    assert j.findings == []
    assert j.score == 1.0


# ----------------------------------------------------------------------- failed


@pytest.mark.parametrize(
    "broken",
    [
        {"error": "cv2.error: something exploded"},
        {"width": 0},
        {"height": 0},
        {"width": 0, "height": 0, "error": "empty image"},
    ],
    ids=["error-set", "zero-width", "zero-height", "both"],
)
def test_unmeasurable_page_is_failed_never_acceptable(broken):
    j = judge(clean_metrics(**broken))
    assert j.overall == "failed"
    assert j.overall != "acceptable"
    assert j.score == 0.0
    # A page that could not be measured must not carry findings that imply it was.
    assert j.findings == []


def test_error_wins_even_when_every_other_metric_looks_perfect():
    perfect = clean_metrics()
    assert judge(perfect).overall == "acceptable"
    perfect.error = "MemoryError: allocation failed"
    assert judge(perfect).overall == "failed"


# ------------------------------------------------------------------------ blank


def test_blank_page_is_its_own_class_with_no_findings():
    m = clean_metrics(text_ink_coverage=0.0, text_component_count=0, ink_coverage=0.0)
    j = judge(m)
    assert j.overall == "blank"
    assert j.overall not in ("acceptable", "rescan", "review")
    assert j.findings == [], "a blank page must not be described as blurred, faint or anything else"
    assert j.score == 1.0


def test_blank_beats_every_other_defect_on_a_normally_exposed_page():
    """An empty but properly exposed sheet is blank, whatever else the metrics say about it."""
    m = clean_metrics(
        text_ink_coverage=0.0,
        text_component_count=0,
        ink_paper_contrast=2.0,
        median_luma=238.0,
        skew_deg=20.0,
    )
    j = judge(m)
    assert j.overall == "blank"
    assert j.findings == []


def test_a_uniformly_dark_frame_is_a_failed_capture_not_a_blank_page():
    """A scanner lid left open produces no content and no light.

    Reporting that as "blank" with a perfect score is the one way this classifier could hide a
    total capture failure, so darkness is checked before blankness.
    """
    m = clean_metrics(text_ink_coverage=0.0, text_component_count=0, median_luma=8.0)
    j = judge(m)
    assert j.overall == "rescan"
    assert j.score == 0.0
    assert {f.code for f in j.findings} == {"dark"}
    assert "failed capture" in j.findings[0].detail


def test_near_blank_is_a_finding_not_a_class():
    m = clean_metrics(text_ink_coverage=0.010, text_component_count=60)
    j = judge(m)
    assert j.overall != "blank"
    assert "near_blank" in codes(j)
    detail = next(f.detail for f in j.findings if f.code == "near_blank")
    assert "may be intentional" in detail.lower()


# ------------------------------------------------------------------ handwriting


def test_handwriting_is_not_a_defect_code():
    """Handwriting is a separate axis. It must never appear in the quality vocabulary."""
    from app.models.core import HandwritingCategory, HandwritingStatus

    for code in DEFECT_ORDER:
        assert "hand" not in code.lower(), code
    for code, label in DEFECT_LABELS.items():
        assert "handwrit" not in label.lower(), (code, label)

    hw_vocabulary = {m.value for m in HandwritingCategory} | {m.value for m in HandwritingStatus}
    assert hw_vocabulary.isdisjoint(set(DEFECT_ORDER))


def test_no_metric_combination_produces_a_handwriting_finding():
    for broken in (
        {"stroke_sharpness": 0.9},
        {"ink_paper_contrast": 5.0},
        {"median_luma": 20.0},
        {"noise_sigma": 40.0, "snr": 0.5},
        {"rotation_deg": 90, "rotation_confidence": 0.9},
        {"glare_area_fraction": 0.5},
        {"cutoff_edges": ["left", "top"]},
        {"is_bitonal": True},
    ):
        for code in codes(judge(clean_metrics(**broken))):
            assert "hand" not in code.lower()


# ------------------------------------------------------- legibility → rescan


LEGIBILITY_CASES = {
    BLUR: {"stroke_sharpness": 0.9},
    FAINT: {"ink_paper_contrast": 20.0},
    DARK: {"median_luma": 60.0},
    UNREADABLE_REGION: {"tile_count": 10, "low_contrast_tiles": 6},
    ROTATED: {"rotation_deg": 90, "rotation_confidence": 0.8},
}


@pytest.mark.parametrize("code,overrides", sorted(LEGIBILITY_CASES.items()))
def test_single_high_severity_legibility_defect_forces_rescan(code, overrides):
    j = judge(clean_metrics(**overrides), SCORE_ROUTE_DISABLED)
    high = [f for f in j.findings if f.severity == "high"]
    assert [f.code for f in high] == [code], f"expected exactly one high {code}, got {codes(j)}"
    # The score route is switched off by SCORE_ROUTE_DISABLED, so this can only come from the
    # legibility override.
    assert j.overall == "rescan"


def test_a_high_severity_non_legibility_defect_does_not_force_rescan():
    """The override is specific: skew is a high-severity defect but not a legibility one."""
    j = judge(clean_metrics(skew_deg=8.0), SCORE_ROUTE_DISABLED)
    assert [(f.code, f.severity) for f in j.findings] == [(SKEWED, "high")]
    assert j.overall == "acceptable"


def test_reclassify_applies_the_same_legibility_override():
    findings = [Finding(BLUR, "high", "provider said so", source="provider")]
    overall, score = reclassify(findings, SCORE_ROUTE_DISABLED)
    assert overall == "rescan"
    assert 0.0 <= score <= 1.0


# ---------------------------------------------------------------- bitonal


def test_bitonal_source_reports_loss_and_suppresses_blur_and_noise():
    m = clean_metrics(is_bitonal=True, colour_mode="bitonal", stroke_sharpness=0.9,
                      noise_sigma=40.0, snr=0.5)
    j = judge(m)
    found = codes(j)
    assert BITONAL_LOSS in found
    assert BLUR not in found, "a 1-bit page has no meaningful stroke sharpness"
    assert NOISE not in found, "a 1-bit page has no meaningful noise sigma"
    detail = next(f.detail for f in j.findings if f.code == BITONAL_LOSS)
    assert "black and white" in detail.lower()


def test_the_same_metrics_without_the_bitonal_flag_do_report_blur_and_noise():
    m = clean_metrics(is_bitonal=False, stroke_sharpness=0.9, noise_sigma=40.0, snr=0.5)
    found = codes(judge(m))
    assert BLUR in found
    assert NOISE in found
    assert BITONAL_LOSS not in found


# -------------------------------------------------------------- thresholds


def test_classification_changes_when_thresholds_change():
    # 3.0 sits above the shipped medium threshold (2.0) and below a stricter site's, so the same
    # page moves between all three classes purely by configuration.
    m = clean_metrics(stroke_sharpness=3.0)
    assert judge(m).overall == "acceptable"
    assert BLUR not in codes(judge(m))

    stricter = judge(m, {"sharpness_min": 3.5})
    assert BLUR in codes(stricter)
    assert stricter.overall == "review"

    much_stricter = judge(m, {"sharpness_severe": 3.5, "sharpness_min": 3.6})
    assert much_stricter.overall == "rescan"


def test_a_loosened_threshold_can_clear_a_defect():
    m = clean_metrics(ink_paper_contrast=30.0)
    assert FAINT in codes(judge(m))
    assert FAINT not in codes(judge(m, {"faint_ink_paper_contrast": 10.0,
                                        "faint_severe_contrast": 5.0,
                                        "low_contrast_ink_paper": 10.0}))


def test_thresholds_hash_is_stable_for_equal_thresholds_and_differs_otherwise():
    m = clean_metrics()
    default_hash = judge(m).thresholds_hash
    assert judge(m).thresholds_hash == default_hash
    assert judge(m, {}).thresholds_hash == default_hash

    changed = judge(m, {"sharpness_min": 0.5}).thresholds_hash
    assert changed != default_hash
    assert judge(m, {"sharpness_min": 0.5}).thresholds_hash == changed
    # Same values written in a different order must still hash the same.
    assert thresholds_hash({"a": 1, "b": 2}) == thresholds_hash({"b": 2, "a": 1})
    assert thresholds_hash({"a": 1}) != thresholds_hash({"a": 2})


def test_unknown_threshold_keys_are_carried_into_the_hash_but_change_no_verdict():
    m = clean_metrics()
    j = judge(m, {"not_a_real_threshold": 1.0})
    assert j.overall == "acceptable"
    assert j.thresholds_hash != judge(m).thresholds_hash


# ------------------------------------------------------------------ cut-off


def test_cutoff_is_phrased_as_a_suspicion():
    m = clean_metrics(cutoff_edges=["left"], cutoff_regions=[Region(0, 100, 40, 900)])
    j = judge(m)
    cut = next(f for f in j.findings if f.code == SUSPECTED_CUTOFF)
    assert "cannot be confirmed" in cut.detail
    assert "may continue" in cut.detail.lower()
    assert cut.region is not None and cut.region.as_dict()["h"] == 900
    assert DEFECT_LABELS[SUSPECTED_CUTOFF].lower().startswith("suspected")


def test_cutoff_on_two_edges_is_more_severe_than_one():
    one = judge(clean_metrics(cutoff_edges=["left"]))
    two = judge(clean_metrics(cutoff_edges=["left", "top"]))
    assert next(f.severity for f in one.findings if f.code == SUSPECTED_CUTOFF) == "medium"
    assert next(f.severity for f in two.findings if f.code == SUSPECTED_CUTOFF) == "high"
    # ...but cut-off is not a legibility code, so on its own it does not force a rescan.
    assert judge(clean_metrics(cutoff_edges=["left", "top"]), SCORE_ROUTE_DISABLED).overall != "rescan"


# --------------------------------------------------------------- housekeeping


def test_every_finding_serialises_with_a_human_label():
    m = clean_metrics(ink_paper_contrast=20.0, cutoff_edges=["left"], is_bitonal=True)
    for finding in judge(m).findings:
        payload = finding.to_json()
        assert payload["label"] == DEFECT_LABELS[finding.code]
        assert payload["severity"] in ("low", "medium", "high")
        assert payload["detail"].strip()


def test_score_falls_as_findings_accumulate():
    good = judge(clean_metrics()).score
    fair = judge(clean_metrics(skew_deg=2.0)).score
    bad = judge(clean_metrics(ink_paper_contrast=20.0, median_luma=60.0, skew_deg=8.0)).score
    assert good > fair > bad >= 0.0
