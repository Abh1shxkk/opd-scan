"""Application configuration.

Everything that could differ between a laptop, an on-prem hospital server and a cloud
deployment lives here. Nothing in this file contains a secret; secrets arrive through the
environment (see .env.example).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- core -------------------------------------------------------------
    app_name: str = "OPD Scan QC"
    environment: Literal["dev", "staging", "prod"] = "dev"
    secret_key: str = Field(default="change-me-in-production", min_length=8)
    access_token_minutes: int = 12 * 60
    api_prefix: str = "/api"
    cors_origins: str = "http://localhost:5173"

    # --- database / queue -------------------------------------------------
    database_url: str = "postgresql+psycopg://opd:opd@localhost:5432/opd"
    redis_url: str = "redis://localhost:6379/0"
    # "broker" hands work to Redis for a Celery worker to run — the only mode for a real
    # deployment. "inline" runs the same jobs on a background thread inside the API process, so a
    # laptop trial needs neither Redis nor a separate worker. Same bookkeeping either way; the
    # inline path is single-threaded and shares CPU with request handling, so it is for pilots only.
    job_execution: Literal["broker", "inline"] = "broker"

    # --- storage ----------------------------------------------------------
    # "local" writes to storage_root; "s3" uses any S3-compatible endpoint (MinIO included).
    storage_backend: Literal["local", "s3"] = "local"
    storage_root: str = "./var/storage"
    s3_endpoint_url: str | None = None
    s3_bucket: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_server_side_encryption: str | None = "AES256"

    # --- upload limits (configurable per requirement 1) -------------------
    max_upload_mb: int = 200
    max_pages_per_document: int = 500
    allowed_extensions: str = "pdf,jpg,jpeg,png,tif,tiff"

    # --- rendering --------------------------------------------------------
    render_dpi: int = 150
    thumb_max_px: int = 320
    preview_max_px: int = 2000
    # Renders are the analysis input and the viewer's source. JPEG at quality 95 was measured
    # against PNG on the pilot files: identical page classifications, metric drift well inside the
    # thresholds, and about one fifth of the storage (≈1 MB vs ≈5 MB per page). At 1,000 pages/day
    # that is the difference between ~1 GB and ~9 GB a day. Bitonal sources always use PNG, where
    # JPEG would be both larger and destructive. Set to "png" to keep renders lossless throughout.
    render_format: Literal["jpeg", "png"] = "jpeg"
    render_jpeg_quality: int = 95
    # Reading the pre-printed page number off each form powers sequence-gap detection. It needs
    # Tesseract and costs roughly a quarter of a second per page.
    read_printed_page_labels: bool = True

    # --- AI providers -----------------------------------------------------
    # Router policy: which provider handles which capability.
    # "none" means the capability is UNCONFIGURED and results are withheld, never faked.
    ocr_provider: Literal["none", "google_docai", "azure_di", "local_tesseract"] = "none"
    handwriting_provider: Literal["none", "google_docai", "azure_di"] = "none"
    handwriting_devanagari_provider: Literal["none", "azure_di"] = "none"
    diagnosis_provider: Literal["none", "google_docai", "azure_di"] = "none"

    # Comma-separated language codes expected in scanned documents at this deployment. Drives the
    # OCR/handwriting language hints; a language not listed here is never assumed for a page.
    document_languages: str = "en"

    google_project_id: str | None = None
    google_location: str = "us"
    google_processor_id: str | None = None
    google_credentials_json: str | None = None  # path to a service-account key file
    google_enable_quality_scores: bool = True

    azure_di_endpoint: str | None = None
    azure_di_key: str | None = None

    provider_timeout_seconds: int = 120
    provider_max_attempts: int = 3
    provider_rate_limit_per_minute: int = 120

    # --- privacy / retention ---------------------------------------------
    # Cloud processing is an explicit deployment choice, not a default.
    allow_cloud_processing: bool = False
    log_patient_text: bool = False  # must stay false outside local debugging
    retention_days_originals: int = 0  # 0 = keep indefinitely
    retention_days_derivatives: int = 0
    allow_training_use: bool = False  # never enabled by this codebase

    @property
    def allowed_ext_set(self) -> set[str]:
        return {e.strip().lower().lstrip(".") for e in self.allowed_extensions.split(",") if e.strip()}

    @property
    def document_languages_list(self) -> list[str]:
        return [lang.strip().lower() for lang in self.document_languages.split(",") if lang.strip()]

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
