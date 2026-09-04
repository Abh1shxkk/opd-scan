"""Turning a stored upload into logical pages and their first version.

The original file is read but never written to. Each page produces three derived objects — a
full-resolution render, a bounded preview and a thumbnail — under a separate key prefix, so an
enhanced or annotated image can never be mistaken for the scan itself.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import settings
from app.core.audit import log_info
from app.core.storage import get_storage
from app.models import Document, LogicalPage, PageVersion
from app.models.core import CaptureProfile, ColourMode, IngestStatus, JobKind
from app.processing import ingest
from app.services import jobs as job_service

ORIGINAL_PREFIX = "originals"
RENDER_PREFIX = "renders"
PREVIEW_PREFIX = "previews"
THUMB_PREFIX = "thumbs"


def original_key(document_id: str, filename: str) -> str:
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    return f"{ORIGINAL_PREFIX}/{document_id[:2]}/{document_id}.{suffix}"


def _derived_key(prefix: str, page_version_id: str, ext: str = "png") -> str:
    return f"{prefix}/{page_version_id[:2]}/{page_version_id}.{ext}"


def _encode_render(image, bits_per_component: int | None):  # noqa: ANN001, ANN201
    """Encode the analysis/display render.

    A 1-bit source is always kept lossless: JPEG on bitonal material both grows the file and
    introduces ringing exactly where the ink is. Everything else follows RENDER_FORMAT.
    """
    if bits_per_component == 1 or settings.render_format == "png":
        return ingest.encode_png(image), "png"
    return ingest.encode_jpeg(image, settings.render_jpeg_quality), "jpg"


def ingest_document(
    db: Session,
    doc: Document,
    on_progress: Callable[[int, int], bool] | None = None,
    default_stages: list[str] | None = None,
) -> Document:
    """Split ``doc`` into logical pages and queue analysis for each.

    ``on_progress(done, total)`` may return False to request a clean stop at the next page boundary,
    which is how cancellation works without killing a worker mid-write.

    ``default_stages`` is forwarded to ``queue_page_stages`` for every page — ``None`` keeps its own
    default (quality, handwriting, diagnosis, matching every scan-QC upload); pass ``[]`` for a
    caller that runs its own stages synchronously right after (the standalone prescription analyzer
    does this, to avoid queuing scan-QC work nothing there will ever look at).
    """
    storage = get_storage()
    doc.ingest_status = IngestStatus.running
    doc.ingest_error = None
    db.add(doc)
    db.commit()

    local_path = storage.open_path(doc.storage_key_original)

    try:
        total, _warnings = ingest.probe_container(local_path, doc.original_filename)
    except ingest.IngestRejected as exc:
        doc.ingest_status = {
            "password_protected": IngestStatus.password_protected,
            "corrupted": IngestStatus.corrupted,
        }.get(exc.reason_code, IngestStatus.rejected)
        doc.ingest_error = exc.message
        db.add(doc)
        db.commit()
        return doc

    doc.page_count = total
    db.add(doc)
    db.commit()

    existing = {p.ordinal: p for p in doc.pages}
    done = 0
    queued_jobs: list[str] = []

    for rendered in ingest.iter_pages(
        local_path, doc.original_filename, settings.render_dpi, settings.read_printed_page_labels
    ):
        ordinal = rendered.index + 1

        page = existing.get(ordinal)
        if page is None:
            page = LogicalPage(
                document_id=doc.id,
                ordinal=ordinal,
                source_page_index=rendered.index,
                printed_page_label=rendered.printed_label,
            )
            db.add(page)
            db.flush()
        elif rendered.printed_label and not page.printed_page_label:
            page.printed_page_label = rendered.printed_label
            db.add(page)

        # Re-ingest must not silently create a second "version 1" of the same page.
        if page.active_version is not None:
            done += 1
            continue

        h, w = rendered.image.shape[:2]
        version = PageVersion(
            logical_page_id=page.id,
            version_no=1,
            is_active=True,
            width=w,
            height=h,
            created_by=doc.uploaded_by,
            colour_mode=(
                ColourMode.bitonal if rendered.source_bits_per_component == 1 else ColourMode.colour
            ),
            capture_profile=CaptureProfile.unknown,
            storage_key_render="",
        )
        db.add(version)
        db.flush()

        render_bytes, render_ext = _encode_render(rendered.image, rendered.source_bits_per_component)
        render_key = _derived_key(RENDER_PREFIX, version.id, render_ext)
        preview_key = _derived_key(PREVIEW_PREFIX, version.id, "jpg")
        thumb_key = _derived_key(THUMB_PREFIX, version.id, "jpg")

        storage.put_bytes(render_key, render_bytes)
        storage.put_bytes(preview_key, ingest.encode_jpeg(ingest.make_preview(rendered.image)))
        storage.put_bytes(thumb_key, ingest.encode_jpeg(ingest.make_thumbnail(rendered.image)))

        version.storage_key_render = render_key
        version.storage_key_thumb = thumb_key
        db.add(version)
        db.commit()

        for job in job_service.queue_page_stages(db, version.id, stages=default_stages):
            queued_jobs.append(job.id)
        db.commit()

        done += 1
        if on_progress and not on_progress(done, total):
            log_info("ingest stopped on request", document_id=doc.id, pages_done=done)
            doc.ingest_status = IngestStatus.pending
            db.add(doc)
            db.commit()
            return doc

    doc.ingest_status = IngestStatus.completed
    db.add(doc)
    db.commit()

    _dispatch(queued_jobs)
    return doc


def _dispatch(job_ids: list[str]) -> None:
    """Hand queued jobs to the broker if one is reachable; otherwise leave them queued.

    Jobs left queued are not lost — the beat sweeper and the startup dispatcher pick them up. This
    is why the API never blocks on the broker being healthy.
    """
    if not job_ids:
        return
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import Job
        from app.services import inline_runner

        db = SessionLocal()
        try:
            jobs = list(db.execute(select(Job).where(Job.id.in_(job_ids))).scalars())
        finally:
            db.close()

        if inline_runner.enabled():
            inline_runner.submit_many(jobs)
            return

        from app.workers import tasks as worker_tasks

        for job in jobs:
            worker_tasks.dispatch(job)
    except Exception:  # noqa: BLE001 - broker unavailable is a degraded mode, not a failure
        return


def add_replacement_version(
    db: Session,
    page: LogicalPage,
    image,  # noqa: ANN001 - numpy array
    created_by: str | None,
    bits_per_component: int | None = None,
) -> PageVersion:
    """Attach a rescan to an existing logical page.

    The previous version is deactivated but kept: version history is preserved and only the active
    version is ever counted in totals or exports.
    """
    storage = get_storage()
    current = page.active_version
    next_no = (max((v.version_no for v in page.versions), default=0)) + 1

    h, w = image.shape[:2]
    version = PageVersion(
        logical_page_id=page.id,
        version_no=next_no,
        is_active=True,
        replaces_version_id=current.id if current else None,
        width=w,
        height=h,
        created_by=created_by,
        colour_mode=ColourMode.bitonal if bits_per_component == 1 else ColourMode.colour,
        capture_profile=CaptureProfile.unknown,
        storage_key_render="",
    )
    if current:
        current.is_active = False
        db.add(current)
    db.add(version)
    db.flush()

    render_bytes, render_ext = _encode_render(image, bits_per_component)
    render_key = _derived_key(RENDER_PREFIX, version.id, render_ext)
    storage.put_bytes(render_key, render_bytes)
    storage.put_bytes(_derived_key(PREVIEW_PREFIX, version.id, "jpg"),
                      ingest.encode_jpeg(ingest.make_preview(image)))
    thumb_key = _derived_key(THUMB_PREFIX, version.id, "jpg")
    storage.put_bytes(thumb_key, ingest.encode_jpeg(ingest.make_thumbnail(image)))
    version.storage_key_render = render_key
    version.storage_key_thumb = thumb_key
    version.created_at = datetime.now(timezone.utc)
    db.add(version)
    db.commit()

    ids = [j.id for j in job_service.queue_page_stages(db, version.id)]
    db.commit()
    _dispatch(ids)
    return version


def queue_ingest(db: Session, doc: Document) -> str:
    job = job_service.enqueue(db, JobKind.ingest, document_id=doc.id)
    db.commit()
    _dispatch([job.id])
    return job.id
