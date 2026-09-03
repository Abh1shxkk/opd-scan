# syntax=docker/dockerfile:1
#
# Backend image — used unchanged by the api, worker and beat services.
# The three differ only in the command they run, so they share one image and
# one build cache.
#
# Stage 1 compiles wheels (needs a toolchain); stage 2 carries only the runtime
# libraries and runs as a non-root user.

# --------------------------------------------------------------------------- #
# Stage 1 — build wheels
# --------------------------------------------------------------------------- #
FROM python:3.12-slim-bookworm AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt ./
RUN python -m pip install --upgrade pip wheel \
 && python -m pip wheel --wheel-dir /wheels -r requirements.txt


# --------------------------------------------------------------------------- #
# Stage 2 — runtime
# --------------------------------------------------------------------------- #
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    # Keep OpenCV and BLAS single-threaded. Parallelism comes from running
    # several Celery workers, not from each one spawning a thread per core;
    # without this the box thrashes at high concurrency.
    OPENCV_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        # --- OpenCV / Pillow / PyMuPDF runtime ---------------------------- #
        # opencv-python-headless needs glib; libgl1 and libgomp cover the
        # non-headless fallback and the OpenMP-backed routines.
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
        libjpeg62-turbo \
        libpng16-16 \
        libtiff6 \
        libopenjp2-7 \
        libfreetype6 \
        # --- PostgreSQL client library ------------------------------------ #
        libpq5 \
        # --- Local OCR provider ------------------------------------------- #
        # English and Hindi traineddata. Without tesseract-ocr-hin the local
        # provider reports Hindi as unavailable rather than guessing.
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-hin \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-index --find-links=/wheels -r /tmp/requirements.txt \
 && rm -rf /wheels /tmp/requirements.txt

# --- non-root user -------------------------------------------------------- #
# Fixed uid/gid so that a bind-mounted host directory can be chowned to match.
RUN groupadd --gid 10001 opd \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin opd \
 && mkdir -p /app /var/lib/opd/storage \
 && chown -R opd:opd /app /var/lib/opd

WORKDIR /app

# Copied explicitly rather than with `COPY . /app`.
#
# Docker reads the .dockerignore that sits in the BUILD CONTEXT root, and this
# image's context is ./backend, not the repository root — so the repository's
# root .dockerignore does not filter this copy. Listing the two source trees by
# name is what actually guarantees that a developer's backend/.env, .venv, var/
# storage directory or stray sample scans cannot end up in a layer.
#
# alembic.ini is needed in the image: the compose stack runs `alembic upgrade head`
# from a one-shot migrate service before the API or the workers start.
COPY --chown=opd:opd alembic.ini /app/alembic.ini
COPY --chown=opd:opd app/   /app/app/
COPY --chown=opd:opd tools/ /app/tools/

USER opd

EXPOSE 8000

# Liveness only — it proves the process is answering, not that the queue is
# healthy. Compose overrides this for the worker and beat services.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
