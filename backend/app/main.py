"""FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import admin, auth, dashboard, diagnoses, pages, records, reports
from app.config import settings
from app.core.audit import redact

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("opd")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN201, ARG001
    # Any work left queued by a previous run is pushed to the broker at startup, so a restart picks
    # up where it stopped without an operator intervening. A missing broker is a degraded mode, not
    # a failure to boot.
    try:
        from app.workers.tasks import dispatch_queued

        count = dispatch_queued(limit=500)
        if count:
            logger.info("re-dispatched %s queued jobs at startup", count)
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not re-dispatch queued jobs at startup: %s", type(exc).__name__)
    yield


app = FastAPI(
    title="AI Patient Record Scan Quality & Diagnosis Extraction System",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):  # noqa: ANN001, ANN201
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    # Patient images and exports must not be cached by intermediaries.
    if request.url.path.startswith("/api/") and request.method == "GET":
        response.headers.setdefault("Cache-Control", "private, no-store")
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):  # noqa: ANN201, ARG001
    # Error bodies must never leak document content back to the client or into the log.
    logger.exception(redact(f"unhandled error on {request.url.path}: {type(exc).__name__}"))
    return JSONResponse(status_code=500, content={"detail": "An internal error occurred."})


for router in (auth.router, records.router, pages.router, diagnoses.router, dashboard.router,
               reports.router, admin.router, admin.checklists):
    app.include_router(router, prefix=settings.api_prefix)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "environment": settings.environment}
