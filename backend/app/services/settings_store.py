"""Runtime-configurable settings held in the database.

Quality thresholds live here rather than in the environment so a site can retune them from the
Settings screen without a redeploy, and so every change is attributable. The defaults come from
``rules.DEFAULT_THRESHOLDS``; only keys that exist there can be overridden, which stops a typo in
the UI from silently disabling a check.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models import Setting
from app.processing.quality.rules import DEFAULT_THRESHOLDS

THRESHOLDS_KEY = "quality.thresholds"
CHECKLIST_DEFAULT_KEY = "completeness.default_checklist_id"
RETENTION_KEY = "retention"


def _get(db: Session, key: str) -> dict[str, Any] | None:
    row = db.get(Setting, key)
    return dict(row.value_json) if row else None


def _put(db: Session, key: str, value: dict[str, Any], actor_id: str | None) -> None:
    row = db.get(Setting, key)
    if row is None:
        row = Setting(key=key, value_json=value, updated_by=actor_id)
        db.add(row)
    else:
        row.value_json = value
        row.updated_by = actor_id
        row.updated_at = datetime.now(timezone.utc)


def get_thresholds(db: Session) -> dict[str, Any]:
    stored = _get(db, THRESHOLDS_KEY) or {}
    # Unknown keys are dropped: a threshold the engine does not read would be a silent no-op that
    # looks like a working control on the Settings screen.
    clean = {k: v for k, v in stored.items() if k in DEFAULT_THRESHOLDS}
    return {**DEFAULT_THRESHOLDS, **clean}


def set_thresholds(db: Session, values: dict[str, Any], actor_id: str | None) -> dict[str, Any]:
    rejected = sorted(set(values) - set(DEFAULT_THRESHOLDS))
    accepted: dict[str, Any] = {}
    for key, value in values.items():
        if key not in DEFAULT_THRESHOLDS:
            continue
        try:
            accepted[key] = type(DEFAULT_THRESHOLDS[key])(value)
        except (TypeError, ValueError):
            rejected.append(key)
    _put(db, THRESHOLDS_KEY, accepted, actor_id)
    return {"applied": {**DEFAULT_THRESHOLDS, **accepted}, "rejected": sorted(set(rejected))}


def get_retention(db: Session) -> dict[str, Any]:
    return _get(db, RETENTION_KEY) or {"originals_days": 0, "derivatives_days": 0, "audit_days": 0}


def set_retention(db: Session, values: dict[str, Any], actor_id: str | None) -> dict[str, Any]:
    allowed = {"originals_days", "derivatives_days", "audit_days"}
    clean = {k: int(v) for k, v in values.items() if k in allowed}
    # Audit records outlive the documents they describe; a zero here means "keep forever" and the
    # UI says so. Nothing in this codebase deletes audit rows automatically.
    _put(db, RETENTION_KEY, clean, actor_id)
    return get_retention(db)
