"""Settings, thresholds, checklists and capability reporting."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.core import audit
from app.core.rbac import current_user, require_admin
from app.db import get_db
from app.models import Checklist, ChecklistItem, User
from app.processing.providers import router as provider_router
from app.processing.quality.rules import DEFAULT_THRESHOLDS, DEFECT_LABELS
from app.schemas.api import ChecklistIn, ThresholdsIn
from app.services import settings_store

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/thresholds")
def get_thresholds(db: Session = Depends(get_db), _: User = Depends(current_user)):
    return {
        "thresholds": settings_store.get_thresholds(db),
        "defaults": DEFAULT_THRESHOLDS,
        "defect_labels": DEFECT_LABELS,
    }


@router.put("/thresholds")
def put_thresholds(payload: ThresholdsIn, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    result = settings_store.set_thresholds(db, payload.values, actor.id)
    audit.record(db, actor_id=actor.id, action="settings.thresholds", entity_type="settings",
                 meta={"changed": sorted(payload.values)})
    db.commit()
    if result["rejected"]:
        result["note"] = (
            "These keys were ignored because the quality engine does not read them: "
            + ", ".join(result["rejected"])
        )
    return result


@router.get("/capabilities")
def capabilities(db: Session = Depends(get_db), _: User = Depends(current_user)):
    """What is actually working, and precisely what is needed to enable what is not.

    An unconfigured capability is reported as unconfigured. It is never reported as a result.
    """
    caps = provider_router.capability_status()
    return {
        "capabilities": caps,
        "providers": provider_router.health(),
        "deployment": {
            "cloud_processing_enabled": settings.allow_cloud_processing,
            "storage_backend": settings.storage_backend,
            "training_use_of_uploads": False,
            "note": (
                "Cloud processing is an explicit deployment choice and is off unless "
                "ALLOW_CLOUD_PROCESSING is set. Uploaded patient records are never used to train or "
                "fine-tune a model by this system."
            ),
        },
        "retention": settings_store.get_retention(db),
        "limits": {
            "max_upload_mb": settings.max_upload_mb,
            "max_pages_per_document": settings.max_pages_per_document,
            "allowed_extensions": sorted(settings.allowed_ext_set),
            "render_dpi": settings.render_dpi,
        },
    }


@router.put("/retention")
def put_retention(payload: dict, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    result = settings_store.set_retention(db, payload, actor.id)
    audit.record(db, actor_id=actor.id, action="settings.retention", entity_type="settings")
    db.commit()
    return result


# --------------------------------------------------------------- checklists

checklists = APIRouter(prefix="/checklists", tags=["checklists"])


@checklists.get("")
def list_checklists(db: Session = Depends(get_db), _: User = Depends(current_user)):
    out = []
    for c in db.execute(select(Checklist).order_by(Checklist.name)).scalars():
        out.append(
            {
                "id": c.id,
                "name": c.name,
                "is_active": c.is_active,
                "items": [
                    {"id": i.id, "doc_type": i.doc_type, "min_pages": i.min_pages, "required": i.required}
                    for i in c.items
                ],
            }
        )
    return out


@checklists.post("", status_code=201)
def create_checklist(payload: ChecklistIn, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    if db.execute(select(Checklist).where(Checklist.name == payload.name)).scalar_one_or_none():
        raise HTTPException(409, "A checklist with that name already exists")
    c = Checklist(name=payload.name, is_active=payload.is_active)
    db.add(c)
    db.flush()
    for item in payload.items:
        db.add(ChecklistItem(checklist_id=c.id, doc_type=item.doc_type, min_pages=item.min_pages,
                             required=item.required))
    audit.record(db, actor_id=actor.id, action="checklist.create", entity_type="checklist", entity_id=c.id)
    db.commit()
    return {"id": c.id}


@checklists.put("/{checklist_id}")
def update_checklist(checklist_id: str, payload: ChecklistIn, db: Session = Depends(get_db),
                     actor: User = Depends(require_admin)):
    c = db.get(Checklist, checklist_id)
    if not c:
        raise HTTPException(404, "Checklist not found")
    c.name = payload.name
    c.is_active = payload.is_active
    for old in list(c.items):
        db.delete(old)
    db.flush()
    for item in payload.items:
        db.add(ChecklistItem(checklist_id=c.id, doc_type=item.doc_type, min_pages=item.min_pages,
                             required=item.required))
    audit.record(db, actor_id=actor.id, action="checklist.update", entity_type="checklist", entity_id=c.id)
    db.commit()
    return {"id": c.id}


@checklists.delete("/{checklist_id}", status_code=204)
def delete_checklist(checklist_id: str, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    c = db.get(Checklist, checklist_id)
    if not c:
        raise HTTPException(404, "Checklist not found")
    audit.record(db, actor_id=actor.id, action="checklist.delete", entity_type="checklist", entity_id=c.id)
    db.delete(c)
    db.commit()
