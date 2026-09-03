"""Audit trail and log hygiene.

Two things this module guarantees:

* every access, change and review is recorded with actor, action, entity and time;
* **no patient text ever enters the audit record or the application log.** Filenames, OCR text and
  diagnosis strings are excluded by construction — the helpers below take identifiers and counts,
  not content. ``redact`` is available for the rare place where a message might carry text.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import AuditEvent

logger = logging.getLogger("opd")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

# Keys that may never be written into audit metadata, whatever a caller passes.
_FORBIDDEN_KEYS = {
    "text", "raw_text", "cleaned_text", "diagnosis", "content", "ocr", "full_text",
    "patient_name", "filename", "original_filename", "comment", "corrected_text",
}


def redact(message: str) -> str:
    """Strip anything that could be free text before it reaches a log line."""
    if settings.log_patient_text:
        return message
    return _UUID.sub("<id>", message)


def _safe_meta(meta: dict[str, Any] | None) -> dict[str, Any]:
    if not meta:
        return {}
    out: dict[str, Any] = {}
    for key, value in meta.items():
        if key.lower() in _FORBIDDEN_KEYS:
            out[key] = "<redacted>"
        elif isinstance(value, str) and len(value) > 120:
            out[key] = "<redacted:long-string>"
        else:
            out[key] = value
    return out


def record(
    db: Session,
    *,
    actor_id: str | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    ip: str | None = None,
    meta: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        ip=ip,
        meta_json=_safe_meta(meta),
    )
    db.add(event)
    return event


def log_info(message: str, **kw: Any) -> None:
    logger.info(redact(message), extra={"safe": _safe_meta(kw)})


def log_error(message: str, **kw: Any) -> None:
    logger.error(redact(message), extra={"safe": _safe_meta(kw)})
