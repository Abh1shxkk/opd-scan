"""Test bootstrap.

Everything in this file happens **before** ``app`` is imported for the first time, because
``app.config.settings``, ``app.db.engine`` and ``app.core.storage`` are all module-level singletons
built at import time. The environment is pointed at a throwaway SQLite file and a throwaway storage
root, and a hard guard below refuses to run if either still points inside the repository — the real
``backend/var/`` must never be touched by the suite.
"""

from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# --------------------------------------------------------------------- isolation

# Reused if this module is somehow imported twice, so a second import can never point the suite
# at a different database than the one the fixtures created.
_TMP_ROOT = Path(os.environ.setdefault("OPD_TEST_TMP", tempfile.mkdtemp(prefix="opd-tests-")))
_DB_PATH = _TMP_ROOT / "test.db"
_STORAGE_ROOT = _TMP_ROOT / "storage"
_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


@atexit.register
def _cleanup() -> None:
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)


# Environment variables outrank the repository's .env in pydantic-settings, so these win.
os.environ.update(
    {
        "ENVIRONMENT": "dev",
        "SECRET_KEY": "test-secret-key-not-for-production",
        "DATABASE_URL": f"sqlite:///{_DB_PATH}",
        "STORAGE_BACKEND": "local",
        "STORAGE_ROOT": str(_STORAGE_ROOT),
        "REDIS_URL": "memory://",
        "ALLOW_CLOUD_PROCESSING": "false",
        "OCR_PROVIDER": "none",
        "HANDWRITING_PROVIDER": "none",
        "HANDWRITING_DEVANAGARI_PROVIDER": "none",
        "DIAGNOSIS_PROVIDER": "none",
        # Reading printed page labels shells out to tesseract; off here so ingest is fast and
        # deterministic regardless of what is installed on the machine.
        "READ_PRINTED_PAGE_LABELS": "false",
        "LOG_PATIENT_TEXT": "false",
    }
)

import numpy as np  # noqa: E402
import pytest  # noqa: E402

from app.config import settings  # noqa: E402

# --- the guard. If any of this is false the suite would write into the developer's real data.
if str(_TMP_ROOT) not in settings.database_url:
    raise RuntimeError(f"test isolation failed: database_url is {settings.database_url!r}")
if str(_TMP_ROOT) not in str(Path(settings.storage_root)):
    raise RuntimeError(f"test isolation failed: storage_root is {settings.storage_root!r}")
if "var" in Path(settings.storage_root).parts:
    raise RuntimeError("test isolation failed: storage_root points at backend/var")

from app.core.security import create_access_token, hash_password  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import (  # noqa: E402,F401
    Batch,
    Case,
    Document,
    LogicalPage,
    PageVersion,
    User,
)
from app.models.core import CaptureProfile, ColourMode, Role  # noqa: E402
from app.processing import ingest  # noqa: E402
from app.services import ingest_service  # noqa: E402

# bcrypt at 12 rounds costs ~0.3 s a call; every test user shares one precomputed hash.
TEST_PASSWORD = "correct-horse-battery"
_PASSWORD_HASH = hash_password(TEST_PASSWORD)


# --------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def fresh_database() -> None:
    """A clean schema and a clean storage root for every test."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    for child in _STORAGE_ROOT.iterdir():
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink()
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def no_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never talk to a message broker. Jobs stay queued and the tests run them explicitly."""
    monkeypatch.setattr(ingest_service, "_dispatch", lambda job_ids: None)


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def storage():
    from app.core.storage import get_storage

    return get_storage()


# --------------------------------------------------------------------- users


def make_user(db, email: str, role: Role) -> User:
    user = User(email=email, full_name=email.split("@")[0], password_hash=_PASSWORD_HASH, role=role)
    db.add(user)
    db.commit()
    return user


@pytest.fixture()
def users(db) -> dict[str, User]:
    return {
        "admin": make_user(db, "admin@example.test", Role.admin),
        "uploader": make_user(db, "uploader@example.test", Role.uploader),
        "reviewer": make_user(db, "reviewer@example.test", Role.reviewer),
    }


@pytest.fixture()
def auth(users) -> dict[str, dict[str, str]]:
    """Ready-made Authorization headers, one per role."""
    return {
        name: {"Authorization": f"Bearer {create_access_token(u.id, u.role.value)}"}
        for name, u in users.items()
    }


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    # Deliberately not used as a context manager: the lifespan hook tries to re-dispatch queued
    # jobs to the broker, which has nothing to do with what these tests exercise.
    return TestClient(app)


# --------------------------------------------------------------------- images


def text_page_image(
    width: int = 1240,
    height: int = 1754,
    paper: int = 246,
    ink: int = 30,
    scale: float = 0.9,
    thickness: int = 2,
    line: str = "Patient presented with fever and cough for three days",
) -> np.ndarray:
    """A synthetic, clean, printed-looking page. Deterministic — no randomness anywhere."""
    import cv2

    img = np.full((height, width, 3), paper, np.uint8)
    y = 120
    while y < height - 120:
        cv2.putText(img, line, (90, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (ink, ink, ink),
                    thickness, cv2.LINE_AA)
        y += 55
    return img


def blank_page_image(width: int = 1240, height: int = 1754, level: int = 250) -> np.ndarray:
    return np.full((height, width, 3), level, np.uint8)


def make_pdf_bytes(pages: int = 3, texts: list[str] | None = None) -> bytes:
    """Build a small real PDF in memory rather than checking a binary fixture into the repo."""
    import pymupdf

    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        body = texts[i] if texts and i < len(texts) else f"Case sheet page {i + 1}"
        page.insert_text((72, 120), body, fontsize=18)
        page.insert_text((72, 160), "Final Diagnosis : recorded on the paper form", fontsize=14)
    data = doc.tobytes()
    doc.close()
    return data


# --------------------------------------------------------------------- records


@pytest.fixture()
def batch(db, users) -> Batch:
    b = Batch(name="Ward A – March", note="", created_by=users["uploader"].id)
    db.add(b)
    db.commit()
    return b


def attach_version(db, storage, page: LogicalPage, image: np.ndarray | None = None) -> PageVersion:
    """Add an active version to an existing logical page, with a real render in storage."""
    img = image if image is not None else text_page_image(width=600, height=800)
    pv = PageVersion(
        logical_page_id=page.id,
        version_no=1,
        is_active=True,
        width=img.shape[1],
        height=img.shape[0],
        colour_mode=ColourMode.colour,
        capture_profile=CaptureProfile.unknown,
        storage_key_render="",
    )
    db.add(pv)
    db.flush()
    render_key = f"renders/{pv.id[:2]}/{pv.id}.png"
    thumb_key = f"thumbs/{pv.id[:2]}/{pv.id}.jpg"
    storage.put_bytes(render_key, ingest.encode_png(img))
    storage.put_bytes(thumb_key, ingest.encode_jpeg(ingest.make_thumbnail(img)))
    pv.storage_key_render = render_key
    pv.storage_key_thumb = thumb_key
    db.add(pv)
    db.commit()
    return pv


def make_document(db, *, batch: Batch, filename: str, case: Case | None = None) -> Document:
    doc = Document(
        batch_id=batch.id,
        case_id=case.id if case else None,
        original_filename=filename,
        sha256=f"sha-{filename}",
        mime="application/pdf",
        byte_size=1024,
        page_count=1,
        storage_key_original=f"originals/x/{filename}",
    )
    db.add(doc)
    db.flush()
    return doc


def make_page_version(
    db,
    storage,
    *,
    batch: Batch,
    filename: str = "case.pdf",
    ordinal: int = 1,
    image: np.ndarray | None = None,
    case: Case | None = None,
    printed_label: str | None = None,
    document: Document | None = None,
) -> PageVersion:
    """A document → logical page → active page version, with a real render in storage."""
    doc = document or make_document(db, batch=batch, filename=filename, case=case)
    page = LogicalPage(document_id=doc.id, ordinal=ordinal, source_page_index=ordinal - 1,
                       printed_page_label=printed_label)
    db.add(page)
    db.flush()
    return attach_version(db, storage, page, image)


@pytest.fixture()
def sample_page(db, storage, batch) -> PageVersion:
    return make_page_version(db, storage, batch=batch)


# --------------------------------------------------------------------- jobs


def run_queued_jobs(max_rounds: int = 6) -> int:
    """Run every queued job in this process, the way a worker would.

    Ingest queues further jobs, so this loops until the queue drains.
    """
    from sqlalchemy import select

    from app.models import Job
    from app.models.core import JobState
    from app.workers import tasks as worker_tasks

    ran = 0
    for _ in range(max_rounds):
        session = SessionLocal()
        try:
            queued = session.execute(
                select(Job.id, Job.kind).where(Job.state == JobState.queued).order_by(Job.queued_at)
            ).all()
        finally:
            session.close()
        if not queued:
            break
        for job_id, kind in queued:
            worker_tasks.run_inline(job_id, kind)
            ran += 1
    return ran
