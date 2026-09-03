"""In-process job execution, for running the system without a broker.

Why this exists: with `JOB_EXECUTION=broker` (the default, and the only mode for real deployments)
work is handed to Redis and picked up by a Celery worker. That is correct, and it is also three
extra moving parts before anyone can see the application do anything. On a laptop, a pilot machine
or a demonstration, `JOB_EXECUTION=inline` runs the same jobs on a background thread in the API
process instead — no Redis, no separate worker.

It is the *same* work, through the *same* claim / retry / idempotency bookkeeping in
``services.jobs``. Only the transport differs, so behaviour does not diverge between modes.

Its limits are real and are why it is not the default:

* one worker thread, so throughput is one page at a time;
* the queue lives in this process, so a restart relies on the database sweep to recover;
* it competes with request handling for the same CPU.

Anything past a pilot should use the broker.
"""

from __future__ import annotations

import logging
import queue
import threading

from app.config import settings
from app.models.core import JobKind

logger = logging.getLogger("opd.inline")

_queue: "queue.Queue[tuple[str, JobKind]]" = queue.Queue()
_worker: threading.Thread | None = None
_lock = threading.Lock()


def enabled() -> bool:
    return settings.job_execution == "inline"


def _loop() -> None:
    from app.workers.tasks import run_inline

    while True:
        job_id, kind = _queue.get()
        try:
            run_inline(job_id, kind)
        except Exception as exc:  # noqa: BLE001 - a failed job must not kill the runner
            logger.error("inline job %s (%s) raised %s", job_id[:8], kind.value, type(exc).__name__)
        finally:
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_loop, name="opd-inline-worker", daemon=True)
            _worker.start()


def submit(job_id: str, kind: JobKind) -> None:
    _ensure_worker()
    _queue.put((job_id, kind))


def submit_many(jobs) -> int:  # noqa: ANN001 - iterable of Job rows
    count = 0
    for job in jobs:
        submit(job.id, job.kind)
        count += 1
    return count


def pending() -> int:
    return _queue.qsize()


def drain(timeout: float | None = None) -> None:
    """Block until the queue is empty. Used by tests and the CLI, never by a request handler."""
    if timeout is None:
        _queue.join()
        return
    import time

    deadline = time.time() + timeout
    while time.time() < deadline and _queue.qsize():
        time.sleep(0.1)
