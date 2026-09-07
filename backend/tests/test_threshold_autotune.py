"""Bounded, automatic threshold retuning from accumulated "not a defect" corrections.

See services/threshold_autotune.py for the design: not model training, just statistics over real
measurements already stored on QualityResult.raw_metrics_json, with a minimum sample size and a
capped step per run.
"""

from __future__ import annotations

from app.models import PageReview, QualityResult
from app.processing.quality.rules import DEFAULT_THRESHOLDS, SKEWED
from app.services import threshold_autotune
from app.services.settings_store import get_thresholds
from tests.conftest import make_page_version


def _correct_as_false_positive(db, storage, batch, users, *, defect_code: str, metric: dict) -> None:
    pv = make_page_version(db, storage, batch=batch, filename="p.pdf")
    db.add(QualityResult(page_version_id=pv.id, raw_metrics_json=metric))
    db.add(
        PageReview(
            page_version_id=pv.id,
            reviewer_id=users["reviewer"].id,
            action="correct_finding",
            comment="not skewed, the form itself is printed at an angle",
            payload_json={"finding_id": "x", "defect_code": defect_code, "verdict": "not_a_defect"},
        )
    )
    db.commit()


def test_below_minimum_sample_size_changes_nothing(db, storage, batch, users):
    for _ in range(3):  # fewer than _MIN_SAMPLES
        _correct_as_false_positive(db, storage, batch, users, defect_code=SKEWED, metric={"skew_deg": 2.0})

    applied = threshold_autotune.maybe_autotune(db)

    assert applied == []
    assert get_thresholds(db)["skew_deg"] == DEFAULT_THRESHOLDS["skew_deg"]


def test_enough_false_positives_raises_the_threshold_within_bounds(db, storage, batch, users):
    for _ in range(6):
        _correct_as_false_positive(db, storage, batch, users, defect_code=SKEWED, metric={"skew_deg": 2.0})

    applied = threshold_autotune.maybe_autotune(db)

    assert len(applied) == 1
    change = applied[0]
    assert change["defect_code"] == SKEWED
    assert change["threshold"] == "skew_deg"
    assert change["from"] == DEFAULT_THRESHOLDS["skew_deg"]
    # Capped by the 25% max-step bound, not pushed straight to the trigger value.
    assert change["to"] == round(DEFAULT_THRESHOLDS["skew_deg"] * 1.25, 4)

    stored = get_thresholds(db)["skew_deg"]
    assert stored == change["to"]
    assert stored > DEFAULT_THRESHOLDS["skew_deg"]


def test_a_correction_whose_own_measurement_never_crossed_the_threshold_does_not_count(db, storage, batch, users):
    # These reviewers said "not a defect", but the measured skew was already under the threshold —
    # that finding must have fired for some other reason, so it says nothing about this threshold.
    for _ in range(6):
        _correct_as_false_positive(db, storage, batch, users, defect_code=SKEWED, metric={"skew_deg": 0.2})

    applied = threshold_autotune.maybe_autotune(db)

    assert applied == []
    assert get_thresholds(db)["skew_deg"] == DEFAULT_THRESHOLDS["skew_deg"]
