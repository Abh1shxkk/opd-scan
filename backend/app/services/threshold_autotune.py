"""Automatically retune scan-quality thresholds from reviewer corrections.

Not machine learning — the quality engine is deterministic (see processing/quality/rules.py), so
there is no model to train. What this does instead is statistical: every "this is not a defect"
correction is tied back to the exact numeric measurement that triggered the finding (stored in
``QualityResult.raw_metrics_json`` at analysis time), and once enough of those accumulate for one
threshold, the threshold is nudged just past the false-positive cluster so the same mistake stops
recurring — automatically, with no admin action required.

Three guardrails keep this from running away with itself:

1. **A minimum sample size** (``_MIN_SAMPLES``) — one or two corrections are noise, not a pattern.
2. **A bounded step per run** (``_BOUNDS``) — a threshold can only move a fraction of the way toward
   the suggested value per adjustment, and never past a hard floor/ceiling, so one bad batch of
   corrections cannot single-handedly gut detection.
3. **A full audit trail** — every automatic change is recorded via ``audit.record`` with the old and
   new value and which corrections drove it, exactly like a human-made change on the Settings screen,
   so it is always visible and always reversible by an admin.

Only the "primary" tier of each check is tunable (e.g. ``skew_deg``, not ``skew_severe_deg``) — a
"high severity" finding is rarely disputed for a good reason, and leaving that tier fixed keeps a
hard backstop in place no matter what the primary tier drifts to.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import audit
from app.models import PageReview, QualityResult
from app.processing.quality.rules import BLUR, DARK, FAINT, GLARE, LOW_CONTRAST, NOISE, SHADOW, SKEWED
from app.services.settings_store import get_thresholds, set_thresholds

_MIN_SAMPLES = 5

# code -> [(raw_metrics_json key, threshold key, direction)]
# direction "higher_bad": the finding fires when metric > threshold, so false positives push the
# threshold UP. "lower_bad": the finding fires when metric < threshold, so false positives push it
# DOWN.
_TUNABLE: dict[str, list[tuple[str, str, str]]] = {
    BLUR: [("stroke_sharpness", "sharpness_min", "lower_bad")],
    FAINT: [("ink_paper_contrast", "faint_ink_paper_contrast", "lower_bad")],
    LOW_CONTRAST: [("ink_paper_contrast", "low_contrast_ink_paper", "lower_bad")],
    DARK: [("median_luma", "dark_median_luma", "lower_bad")],
    NOISE: [("noise_sigma", "noise_sigma", "higher_bad")],
    SKEWED: [("skew_deg", "skew_deg", "higher_bad")],  # compared as abs() below
    GLARE: [("glare_area_fraction", "glare_area_fraction", "higher_bad")],
    SHADOW: [
        ("shadow_area_fraction", "shadow_area_fraction", "higher_bad"),
        ("illumination_ratio", "illumination_ratio", "higher_bad"),
    ],
}

# threshold key -> (hard floor, hard ceiling, max fractional step per run)
_BOUNDS: dict[str, tuple[float, float, float]] = {
    "sharpness_min": (1.0, 3.5, 0.20),
    "faint_ink_paper_contrast": (20.0, 60.0, 0.20),
    "low_contrast_ink_paper": (40.0, 90.0, 0.20),
    "dark_median_luma": (60.0, 150.0, 0.20),
    "noise_sigma": (1.5, 8.0, 0.25),
    "skew_deg": (0.5, 6.0, 0.25),
    "glare_area_fraction": (0.005, 0.10, 0.30),
    "shadow_area_fraction": (0.05, 0.30, 0.30),
    "illumination_ratio": (1.5, 4.0, 0.20),
}


def _false_positive_page_ids(db: Session, code: str) -> list[str]:
    rows = db.execute(
        select(PageReview.page_version_id, PageReview.payload_json)
        .where(PageReview.action == "correct_finding")
        .order_by(PageReview.created_at.desc())
        .limit(500)
    ).all()
    return [
        r.page_version_id
        for r in rows
        if r.payload_json.get("defect_code") == code and r.payload_json.get("verdict") == "not_a_defect"
    ]


def _next_value(direction: str, current: float, contributing: list[float], bounds: tuple[float, float, float]) -> float:
    floor, ceiling, max_step = bounds
    contributing.sort()
    if direction == "higher_bad":
        # Move just past the 80th-percentile trigger value, capped by the per-run step and ceiling.
        target = contributing[int(len(contributing) * 0.8)] * 1.05
        stepped = min(target, current * (1 + max_step))
        return round(min(stepped, ceiling), 4)
    target = contributing[int(len(contributing) * 0.2)] * 0.95
    stepped = max(target, current * (1 - max_step))
    return round(max(stepped, floor), 4)


def maybe_autotune(db: Session) -> list[dict[str, Any]]:
    """Called after every "correct this finding" review. Applies at most one bounded adjustment per
    tunable threshold per call, and returns what it changed (empty most of the time — there simply
    aren't enough matching corrections yet)."""
    current = get_thresholds(db)
    updates: dict[str, float] = {}
    applied: list[dict[str, Any]] = []

    for code, mappings in _TUNABLE.items():
        fp_page_ids = _false_positive_page_ids(db, code)
        if len(fp_page_ids) < _MIN_SAMPLES:
            continue

        metric_rows = db.execute(
            select(QualityResult.page_version_id, QualityResult.raw_metrics_json)
            .where(QualityResult.page_version_id.in_(fp_page_ids))
        ).all()
        metrics_by_page = {r.page_version_id: (r.raw_metrics_json or {}) for r in metric_rows}

        for metric_key, threshold_key, direction in mappings:
            cur_th = current.get(threshold_key)
            bounds = _BOUNDS.get(threshold_key)
            if cur_th is None or bounds is None:
                continue

            contributing: list[float] = []
            for pid in fp_page_ids:
                mv = (metrics_by_page.get(pid) or {}).get(metric_key)
                if mv is None:
                    continue
                mv = abs(mv) if metric_key == "skew_deg" else mv
                if (direction == "higher_bad" and mv > cur_th) or (direction == "lower_bad" and mv < cur_th):
                    contributing.append(mv)

            if len(contributing) < _MIN_SAMPLES:
                continue

            new_th = _next_value(direction, cur_th, contributing, bounds)
            if abs(new_th - cur_th) < 1e-9:
                continue

            updates[threshold_key] = new_th
            applied.append({
                "defect_code": code,
                "threshold": threshold_key,
                "from": cur_th,
                "to": new_th,
                "sample_size": len(contributing),
            })

    if not updates:
        return []

    set_thresholds(db, {**current, **updates}, actor_id=None)
    # This session is created with autoflush=False (see db.py), so a caller reading the setting
    # back through this same session before its own commit would otherwise still see the old value.
    db.flush()
    audit.record(
        db, actor_id=None, action="settings.thresholds.autotune", entity_type="settings",
        meta={"changes": updates, "detail": applied},
    )
    return applied
