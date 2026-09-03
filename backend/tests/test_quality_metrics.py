"""The measurement layer, run on synthetic images built with numpy/cv2.

No binary fixtures: every image here is generated deterministically in the test, so a failure
always points at the code rather than at a checked-in file nobody can inspect.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.processing.quality import metrics as qm
from app.processing.quality import rules as qr
from tests.conftest import blank_page_image, text_page_image


def crushed_contrast(image: np.ndarray, factor: float, paper: float = 246.0) -> np.ndarray:
    """Pull the ink towards the paper level without touching anything else."""
    out = paper - (paper - image.astype(np.float32)) * factor
    return out.clip(0, 255).astype(np.uint8)


@pytest.fixture(scope="module")
def clean_page() -> np.ndarray:
    return text_page_image()


# ---------------------------------------------------------------- a clean page


def test_clean_synthetic_text_page_is_acceptable(clean_page):
    m = qm.measure(clean_page)
    assert m.error is None
    assert (m.width, m.height) == (clean_page.shape[1], clean_page.shape[0])
    assert m.orientation == "portrait"
    assert m.colour_mode == "grey"  # written as an equal-channel BGR image
    assert m.ink_coverage > 0.01
    assert m.text_component_count > 100

    j = qr.judge(m)
    assert j.overall == "acceptable", f"unexpected findings: {[(f.code, f.severity) for f in j.findings]}"
    assert j.findings == []


def test_measure_reports_geometry_and_ink_statistics(clean_page):
    m = qm.measure(clean_page)
    assert m.paper_level > m.ink_level
    assert m.ink_paper_contrast == pytest.approx(m.paper_level - m.ink_level, abs=1e-6)
    assert m.p95 >= m.p05
    assert m.dynamic_range == pytest.approx(m.p95 - m.p05, abs=1e-6)
    assert 0.0 < m.ink_coverage < 1.0
    assert m.est_text_height_px > 0
    assert m.cutoff_edges == []


# --------------------------------------------------------------------- blur


def test_blur_lowers_stroke_sharpness_monotonically(clean_page):
    sharp = qm.measure(clean_page).stroke_sharpness
    assert sharp > 0
    previous = sharp
    for sigma in (1.0, 2.0, 3.0, 4.0):
        value = qm.measure(cv2.GaussianBlur(clean_page, (0, 0), sigma)).stroke_sharpness
        assert value < previous, f"sharpness did not fall at sigma={sigma}"
        previous = value
    assert previous < sharp / 2


def test_a_visibly_blurred_page_is_no_longer_acceptable(clean_page):
    blurred = cv2.GaussianBlur(clean_page, (0, 0), 4.0)
    assert qr.judge(qm.measure(blurred)).overall != "acceptable"


def test_blur_defect_is_reachable_on_a_blurred_page(clean_page):
    for sigma in (2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 17.0, 18.0):
        blurred = cv2.GaussianBlur(clean_page, (0, 0), sigma)
        if qr.BLUR in [f.code for f in qr.judge(qm.measure(blurred)).findings]:
            return
    pytest.fail("no amount of Gaussian blur produced a 'blur' finding")


# ------------------------------------------------------------- faint / contrast


def test_crushing_contrast_towards_the_paper_level_reports_faint(clean_page):
    faint = crushed_contrast(clean_page, 0.15)
    m = qm.measure(faint)
    baseline = qm.measure(clean_page)

    assert m.ink_paper_contrast < baseline.ink_paper_contrast / 3
    j = qr.judge(m)
    found = {f.code for f in j.findings}
    assert qr.FAINT in found or qr.LOW_CONTRAST in found
    assert j.overall in ("review", "rescan")


def test_mildly_reduced_contrast_reports_low_contrast_before_faint(clean_page):
    m = qm.measure(crushed_contrast(clean_page, 0.4))
    found = {f.code for f in qr.judge(m).findings}
    assert qr.LOW_CONTRAST in found
    assert qr.FAINT not in found


def test_contrast_reduction_is_ordered(clean_page):
    values = [qm.measure(crushed_contrast(clean_page, k)).ink_paper_contrast
              for k in (1.0, 0.6, 0.4, 0.2)]
    assert values == sorted(values, reverse=True)


# --------------------------------------------------------------------- blank


def test_all_white_page_is_blank():
    m = qm.measure(blank_page_image())
    assert m.error is None
    assert m.text_ink_coverage < 0.001
    j = qr.judge(m)
    assert j.overall == "blank"
    assert j.findings == []


# ------------------------------------------------------------------ robustness


@pytest.mark.parametrize(
    "name,image",
    [
        ("1x1", np.zeros((1, 1, 3), np.uint8)),
        ("all-black", np.zeros((600, 400, 3), np.uint8)),
        ("pure-noise", np.random.default_rng(20240101).integers(0, 256, (600, 400, 3), dtype=np.uint8)),
        ("three-channel", text_page_image(width=300, height=400)),
        ("single-channel", cv2.cvtColor(text_page_image(width=300, height=400), cv2.COLOR_BGR2GRAY)),
        ("tall-sliver", np.full((400, 3, 3), 200, np.uint8)),
        ("four-channel", cv2.cvtColor(text_page_image(width=300, height=400), cv2.COLOR_BGR2BGRA)),
    ],
)
def test_measure_never_raises_and_never_records_an_error(name, image):
    m = qm.measure(image)
    assert isinstance(m, qm.PageMetrics)
    assert m.error is None, f"{name} produced error {m.error!r}"
    # Whatever came back must be judgeable without exploding either.
    assert qr.judge(m).overall in ("acceptable", "review", "rescan", "blank", "failed")


def test_measure_returns_failed_metrics_for_an_empty_array():
    m = qm.measure(np.zeros((0, 0, 3), np.uint8))
    assert m.error == "empty image"
    assert qr.judge(m).overall == "failed"


def test_measure_returns_failed_metrics_for_none():
    m = qm.measure(None)
    assert m.error is not None
    assert qr.judge(m).overall == "failed"


@pytest.mark.parametrize(
    "image",
    [
        text_page_image(width=400, height=500),
        cv2.cvtColor(text_page_image(width=400, height=500), cv2.COLOR_BGR2GRAY),
        np.zeros((50, 50, 3), np.uint8),
    ],
    ids=["colour", "grey", "black"],
)
def test_measure_does_not_mutate_its_input(image):
    before = image.copy()
    qm.measure(image)
    assert np.array_equal(image, before), "measure() wrote into the caller's array"


# ------------------------------------------------------------------- bitonal


def test_bitonal_is_taken_from_the_source_depth_not_the_render(clean_page):
    """An anti-aliased render of a 1-bit scan looks like grey; only the container knows."""
    rendered = qm.measure(clean_page)
    assert rendered.is_bitonal is False
    assert rendered.colour_mode != "bitonal"

    declared = qm.measure(clean_page, source_bits_per_component=1)
    assert declared.is_bitonal is True
    assert declared.colour_mode == "bitonal"
    assert qr.BITONAL_LOSS in [f.code for f in qr.judge(declared).findings]


def test_a_two_level_image_is_detected_as_bitonal_without_a_declaration():
    page = text_page_image(paper=255, ink=0, thickness=3)
    hard = (cv2.cvtColor(page, cv2.COLOR_BGR2GRAY) > 128).astype(np.uint8) * 255
    m = qm.measure(cv2.cvtColor(hard, cv2.COLOR_GRAY2BGR))
    assert m.unique_levels <= 3
    assert m.is_bitonal is True


# ------------------------------------------------------------------ metadata


def test_engine_version_is_exposed_and_metrics_serialise_to_json(clean_page):
    assert qm.ENGINE_VERSION.startswith("quality-engine/")
    payload = qm.measure(clean_page).to_json()
    assert isinstance(payload, dict)
    assert payload["width"] > 0
    assert payload["worst_tile"] is None or set(payload["worst_tile"]) == {"x", "y", "w", "h"}
    for key in ("glare_regions", "shadow_regions", "cutoff_regions"):
        assert isinstance(payload[key], list)
        assert all(set(r) == {"x", "y", "w", "h"} for r in payload[key])
