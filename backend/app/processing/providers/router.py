"""Chooses which provider handles which page, and enforces the rate limit.

The router exists because no single provider covers this workload. Google Enterprise Document OCR
brings image-quality scores and good printed multilingual OCR; Azure Document Intelligence is the
one of the two that documents **handwritten Hindi**. A deployment can also run neither.

The router never substitutes a provider that cannot do the job. If handwritten Devanagari is needed
and no configured provider claims that capability, the caller gets ``ProviderUnsupported`` and the
page is recorded as unsupported — not as "no handwriting found".
"""

from __future__ import annotations

import threading
import time
from typing import Any

from app.config import settings
from app.processing.providers.azure_di import AzureDocIntelligenceProvider
from app.processing.providers.base import (
    OcrPage,
    OcrProvider,
    PrescriptionReasoningProvider,
    ProviderError,
    ProviderUnconfigured,
    ProviderUnsupported,
)
from app.processing.providers.gemini import GeminiPrescriptionProvider
from app.processing.providers.google_docai import GoogleDocAiProvider
from app.processing.providers.local_tesseract import LocalTesseractProvider

_REGISTRY: dict[str, type[OcrProvider]] = {
    "google_docai": GoogleDocAiProvider,
    "azure_di": AzureDocIntelligenceProvider,
    "local_tesseract": LocalTesseractProvider,
}

_REASONING_REGISTRY: dict[str, type[PrescriptionReasoningProvider]] = {
    "gemini": GeminiPrescriptionProvider,
}

_instances: dict[str, OcrProvider] = {}
_reasoning_instances: dict[str, PrescriptionReasoningProvider] = {}
_lock = threading.Lock()


def get_provider(name: str) -> OcrProvider:
    if name in ("none", "", None):
        raise ProviderUnconfigured("No provider selected for this capability.")
    cls = _REGISTRY.get(name)
    if cls is None:
        raise ProviderUnconfigured(f"Unknown provider '{name}'.")
    with _lock:
        if name not in _instances:
            _instances[name] = cls()
        return _instances[name]


def get_reasoning_provider(name: str) -> PrescriptionReasoningProvider:
    if name in ("none", "", None):
        raise ProviderUnconfigured("No provider selected for this capability.")
    cls = _REASONING_REGISTRY.get(name)
    if cls is None:
        raise ProviderUnconfigured(f"Unknown provider '{name}'.")
    with _lock:
        if name not in _reasoning_instances:
            _reasoning_instances[name] = cls()
        return _reasoning_instances[name]


class _RateLimiter:
    """Simple token bucket shared by all provider calls in this process."""

    def __init__(self, per_minute: int) -> None:
        self.capacity = max(1, per_minute)
        self.tokens = float(self.capacity)
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self, timeout: float = 60.0) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.capacity / 60.0)
                self.updated = now
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.2)


_limiter = _RateLimiter(settings.provider_rate_limit_per_minute)


def analyse(
    image_bytes: bytes,
    mime: str,
    capability: str,
    language_hints: list[str] | None = None,
) -> OcrPage:
    """Run one page through the provider configured for ``capability``.

    ``capability`` is one of ``ocr``, ``handwriting``, ``diagnosis``. Language hints may carry a
    ``:handwritten`` suffix (e.g. ``hi:handwritten``) so a provider can refuse work it cannot do.
    """
    name = {
        "ocr": settings.ocr_provider,
        "handwriting": settings.handwriting_provider,
        "diagnosis": settings.diagnosis_provider,
    }.get(capability, "none")

    hints = language_hints or []
    needs_devanagari_handwriting = any(
        h.split(":")[0].split("-")[0].lower() in {"hi", "mr", "ne", "sa"} and h.endswith(":handwritten")
        for h in hints
    )
    if needs_devanagari_handwriting and settings.handwriting_devanagari_provider != "none":
        name = settings.handwriting_devanagari_provider

    provider = get_provider(name)

    if needs_devanagari_handwriting and not provider.supports_handwriting("hi"):
        raise ProviderUnsupported(
            f"Provider '{provider.name}' does not document handwriting support for Devanagari. "
            "Set HANDWRITING_DEVANAGARI_PROVIDER=azure_di to route these pages to a provider that does."
        )

    if not _limiter.acquire():
        raise ProviderError("Local provider rate limit exceeded; try again later.")

    return provider.analyse_page(image_bytes, mime, hints)


def health() -> list[dict[str, Any]]:
    out = []
    for name in _REGISTRY:
        try:
            out.append(get_provider(name).health())
        except Exception as exc:  # health must never raise
            out.append({"provider": name, "configured": False, "reason": type(exc).__name__})
    for name in _REASONING_REGISTRY:
        try:
            out.append(get_reasoning_provider(name).health())
        except Exception as exc:  # health must never raise
            out.append({"provider": name, "configured": False, "reason": type(exc).__name__})
    return out


def capability_status() -> dict[str, dict[str, Any]]:
    """What the UI shows on Settings: which capability is live, and why not when it isn't."""
    result: dict[str, dict[str, Any]] = {}
    mapping = {
        "quality_provider_signals": settings.ocr_provider,
        "handwriting": settings.handwriting_provider,
        "handwriting_devanagari": settings.handwriting_devanagari_provider,
        "diagnosis": settings.diagnosis_provider,
        "ocr": settings.ocr_provider,
    }
    for capability, provider_name in mapping.items():
        if provider_name == "none":
            result[capability] = {
                "status": "unconfigured",
                "provider": None,
                "setup_required": f"No provider selected for '{capability}'.",
            }
            continue
        try:
            h = get_provider(provider_name).health()
        except Exception as exc:
            result[capability] = {"status": "unconfigured", "provider": provider_name, "setup_required": str(exc)}
            continue
        result[capability] = {
            "status": "ready" if h.get("configured") else "unconfigured",
            "provider": provider_name,
            "setup_required": None if h.get("configured") else h.get("reason"),
            "detail": h,
        }

    reasoning_name = settings.prescription_reasoning_provider
    if reasoning_name == "none":
        result["prescription"] = {
            "status": "unconfigured",
            "provider": None,
            "setup_required": "No provider selected for 'prescription'.",
        }
    else:
        try:
            h = get_reasoning_provider(reasoning_name).health()
            result["prescription"] = {
                "status": "ready" if h.get("configured") else "unconfigured",
                "provider": reasoning_name,
                "setup_required": None if h.get("configured") else h.get("reason"),
                "detail": h,
            }
        except Exception as exc:
            result["prescription"] = {
                "status": "unconfigured", "provider": reasoning_name, "setup_required": str(exc),
            }

    result["local_quality_engine"] = {"status": "ready", "provider": "opencv", "setup_required": None}
    return result
