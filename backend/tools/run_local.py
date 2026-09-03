"""Run the whole pipeline over real files without a broker, and print what happened.

This is the end-to-end flow in one command: upload → split into pages → analyse → review → export.
Jobs are executed inline in this process, using exactly the same claim/retry/idempotency
bookkeeping the Celery worker uses, so behaviour does not diverge between the two modes.

    python -m tools.run_local /path/to/scans --batch "Ward 2 backlog" --encounter IP140922101

With no AI provider configured, the local quality engine still runs on every page, and handwriting
and diagnosis are recorded as ``unconfigured`` — never as "none found".
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.core.storage import get_storage, sha256_file  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Batch, Case, Document, Job, PageVersion, User  # noqa: E402
from app.models.core import IngestStatus, JobKind, JobState, Role  # noqa: E402
from app.processing import ingest  # noqa: E402
from app.services import ingest_service  # noqa: E402
from app.services import jobs as job_service  # noqa: E402
from app.services.query import PageFilters, dashboard_counts, page_rows  # noqa: E402
from app.workers.tasks import run_inline  # noqa: E402


def drain(db, limit: int = 100_000) -> Counter:
    """Execute every queued job inline until none remain."""
    outcomes: Counter = Counter()
    for _ in range(limit):
        job = db.execute(
            select(Job).where(Job.state == JobState.queued).order_by(Job.queued_at).limit(1)
        ).scalar_one_or_none()
        if job is None:
            break
        outcomes[run_inline(job.id, job.kind)] += 1
        db.expire_all()
    return outcomes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="a file or a directory of files")
    ap.add_argument("--batch", default="Local run")
    ap.add_argument("--encounter", default=None, help="encounter reference; per-file stem if omitted")
    ap.add_argument("--patient", default="")
    ap.add_argument("--csv", default="", help="write the export CSV here")
    args = ap.parse_args()

    src = Path(args.source)
    files = sorted(p for p in (src.iterdir() if src.is_dir() else [src]) if p.is_file())
    if not files:
        print("No input files found.", file=sys.stderr)
        return 2

    db = SessionLocal()
    storage = get_storage()
    try:
        actor = db.execute(select(User).where(User.role == Role.admin)).scalars().first()
        if actor is None:
            print("No admin user exists. Run tools.seed first.", file=sys.stderr)
            return 2

        batch = Batch(name=args.batch, created_by=actor.id)
        db.add(batch)
        db.commit()

        for path in files:
            try:
                ingest.validate_upload(path.name, path.stat().st_size)
                pages, _ = ingest.probe_container(str(path), path.name)
            except ingest.IngestRejected as exc:
                print(f"REJECTED  {path.name}: [{exc.reason_code}] {exc.message}")
                continue

            encounter = args.encounter or path.stem
            case = db.execute(
                select(Case).where(Case.batch_id == batch.id, Case.encounter_ref == encounter)
            ).scalar_one_or_none()
            if case is None:
                case = Case(batch_id=batch.id, patient_ref=args.patient, encounter_ref=encounter)
                db.add(case)
                db.commit()

            doc = Document(
                batch_id=batch.id,
                case_id=case.id,
                original_filename=path.name,
                sha256=sha256_file(str(path)),
                mime=ingest.sniff_stream_mime(path.name),
                byte_size=path.stat().st_size,
                page_count=pages,
                uploaded_by=actor.id,
                ingest_status=IngestStatus.pending,
                storage_key_original="",
            )
            db.add(doc)
            db.flush()
            key = ingest_service.original_key(doc.id, path.name)
            with open(path, "rb") as fh:
                storage.put_stream(key, fh)
            doc.storage_key_original = key
            db.add(doc)
            db.commit()

            job = job_service.enqueue(db, JobKind.ingest, document_id=doc.id)
            db.commit()
            print(f"UPLOADED  {path.name}  ({pages} pages)  job={job.id[:8]}")

        print("\nprocessing...")
        outcomes = drain(db)
        print("job outcomes:", dict(outcomes))

        f = PageFilters(batch_id=batch.id)
        counts = dashboard_counts(db, f)
        totals = counts["totals"]
        print("\n--- dashboard ---")
        print("active pages     :", totals["pages_active"])
        print("quality          :", totals["quality"])
        print("handwriting      :", totals["handwriting"])
        print("diagnosis        :", totals["diagnosis"])
        print("awaiting review  :", totals["awaiting_review"])
        print("overlaps         :", counts["overlaps"])
        print("defects          :", {d["code"]: d["pages"] for d in counts["defects"]})

        rows = page_rows(db, f)
        print(f"\nexport rows: {len(rows)} (must equal active pages: {totals['pages_active']})")
        if args.csv:
            from app.services.reports import export_csv

            Path(args.csv).write_bytes(export_csv(rows))
            print("wrote", args.csv)

        stuck = db.execute(
            select(PageVersion).join(PageVersion.logical_page).where(PageVersion.is_active.is_(True))
        ).scalars().all()
        unchecked = [pv for pv in stuck if pv.quality is None]
        if unchecked:
            print(f"\nWARNING: {len(unchecked)} active pages have no quality result.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
