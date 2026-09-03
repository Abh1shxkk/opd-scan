"""The provider router.

Nothing in this file touches the network: every path under test either refuses before the HTTP
call or reads a class-level capability table.
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.processing.providers import router as provider_router
from app.processing.providers.azure_di import AzureDocIntelligenceProvider
from app.processing.providers.base import (
    ProviderUnconfigured,
    ProviderUnsupported,
)
from app.processing.providers.google_docai import GoogleDocAiProvider
from app.processing.providers.local_tesseract import LocalTesseractProvider

CAPABILITIES = ("ocr", "handwriting", "diagnosis")
PROVIDER_CAPABILITY_KEYS = (
    "quality_provider_signals",
    "handwriting",
    "handwriting_devanagari",
    "diagnosis",
    "ocr",
)


@pytest.fixture()
def no_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    for field in ("ocr_provider", "handwriting_provider", "handwriting_devanagari_provider",
                  "diagnosis_provider"):
        monkeypatch.setattr(settings, field, "none")


# --------------------------------------------------------------- unconfigured


@pytest.mark.parametrize("capability", CAPABILITIES)
def test_analyse_refuses_when_the_capability_has_no_provider(no_providers, capability):
    with pytest.raises(ProviderUnconfigured):
        provider_router.analyse(b"\x89PNG", "image/png", capability)


def test_an_unknown_capability_name_is_also_unconfigured(no_providers):
    with pytest.raises(ProviderUnconfigured):
        provider_router.analyse(b"\x89PNG", "image/png", "astrology")


def test_get_provider_rejects_none_and_unknown_names():
    for name in ("none", "", "not_a_provider"):
        with pytest.raises(ProviderUnconfigured):
            provider_router.get_provider(name)


def test_capability_status_reports_unconfigured_with_a_setup_message(no_providers):
    status = provider_router.capability_status()
    for key in PROVIDER_CAPABILITY_KEYS:
        entry = status[key]
        assert entry["status"] == "unconfigured", key
        assert entry["status"] != "ready"
        assert entry["provider"] is None
        assert entry["setup_required"], f"{key} must say what to do about it"
        assert key in entry["setup_required"]


def test_capability_status_keeps_the_local_engine_separate_from_the_providers(no_providers):
    status = provider_router.capability_status()
    # The local OpenCV engine needs no configuration, and it is reported under its own key so it
    # can never be mistaken for a configured cloud capability.
    assert status["local_quality_engine"]["status"] == "ready"
    assert status["local_quality_engine"]["provider"] == "opencv"
    ready = [k for k, v in status.items() if v.get("status") == "ready"]
    assert ready == ["local_quality_engine"]


def test_a_configured_but_unusable_provider_is_still_unconfigured_not_ready(monkeypatch):
    """Credentials set but cloud processing switched off must not read as 'ready'."""
    monkeypatch.setattr(settings, "ocr_provider", "azure_di")
    monkeypatch.setattr(settings, "azure_di_endpoint", "https://example.invalid")
    monkeypatch.setattr(settings, "azure_di_key", "k")
    monkeypatch.setattr(settings, "allow_cloud_processing", False)
    entry = provider_router.capability_status()["ocr"]
    assert entry["status"] == "unconfigured"
    assert "ALLOW_CLOUD_PROCESSING" in entry["setup_required"]


def test_health_never_raises_and_covers_every_registered_provider():
    report = provider_router.health()
    assert {row["provider"] for row in report} == set(provider_router._REGISTRY)
    assert all("configured" in row for row in report)


# ---------------------------------------------------- handwriting capability


def test_google_does_not_claim_handwritten_devanagari():
    google = GoogleDocAiProvider()
    assert google.supports_handwriting("hi") is False
    assert google.supports_handwriting("hi-IN") is False
    assert google.supports_handwriting("mr") is False
    assert google.supports_handwriting("en") is True


def test_azure_does_claim_handwritten_hindi():
    azure = AzureDocIntelligenceProvider()
    assert azure.supports_handwriting("hi") is True
    assert azure.supports_handwriting("hi-IN") is True
    assert azure.supports_handwriting("en") is True


def test_local_tesseract_declares_no_handwriting_languages():
    tess = LocalTesseractProvider()
    assert tess.handwriting_languages == set()
    for language in ("en", "hi", "mr"):
        assert tess.supports_handwriting(language) is False
    assert tess.health()["provider"] == "local_tesseract"


def test_devanagari_handwriting_on_an_unsupporting_provider_raises_unsupported(monkeypatch):
    monkeypatch.setattr(settings, "handwriting_provider", "google_docai")
    monkeypatch.setattr(settings, "handwriting_devanagari_provider", "none")
    with pytest.raises(ProviderUnsupported) as exc:
        provider_router.analyse(b"\x89PNG", "image/png", "handwriting", ["en:handwritten", "hi:handwritten"])
    assert "azure_di" in str(exc.value), "the error must name the fix"


def test_devanagari_handwriting_is_rerouted_to_the_devanagari_provider(monkeypatch):
    """Azure claims Hindi handwriting, so the router must not raise Unsupported for it."""
    monkeypatch.setattr(settings, "handwriting_provider", "google_docai")
    monkeypatch.setattr(settings, "handwriting_devanagari_provider", "azure_di")
    monkeypatch.setattr(settings, "azure_di_endpoint", None)
    monkeypatch.setattr(settings, "azure_di_key", None)
    # It gets as far as Azure and stops there for a configuration reason, not a capability one.
    with pytest.raises(ProviderUnconfigured) as exc:
        provider_router.analyse(b"\x89PNG", "image/png", "handwriting", ["hi:handwritten"])
    assert "Azure" in str(exc.value)


def test_printed_devanagari_is_not_treated_as_a_handwriting_request(monkeypatch):
    """Only a ':handwritten' hint triggers the Devanagari capability check."""
    monkeypatch.setattr(settings, "ocr_provider", "google_docai")
    monkeypatch.setattr(settings, "google_project_id", None)
    with pytest.raises(ProviderUnconfigured):
        provider_router.analyse(b"\x89PNG", "image/png", "ocr", ["en", "hi"])


@pytest.fixture()
def google_credentialled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enough configuration that the provider gets past its own setup guards."""
    monkeypatch.setattr(settings, "google_project_id", "p")
    monkeypatch.setattr(settings, "google_processor_id", "proc")
    monkeypatch.setattr(settings, "google_credentials_json", "/nonexistent/key.json")
    monkeypatch.setattr(settings, "allow_cloud_processing", True)


def test_google_refuses_handwritten_devanagari_at_the_provider_level_too(google_credentialled):
    """Belt and braces: the provider itself refuses, not only the router."""
    with pytest.raises(ProviderUnsupported):
        GoogleDocAiProvider().analyse_page(b"\x89PNG", "image/png", ["hi-IN:handwritten"])


def test_google_refuses_the_hint_form_the_pipeline_actually_sends(google_credentialled):
    from app.services.pipeline import _language_hints

    hints = _language_hints(handwritten=True)
    assert "hi:handwritten" in hints
    with pytest.raises(ProviderUnsupported):
        GoogleDocAiProvider().analyse_page(b"\x89PNG", "image/png", hints)


def test_cloud_providers_refuse_when_cloud_processing_is_disabled(monkeypatch):
    monkeypatch.setattr(settings, "allow_cloud_processing", False)
    monkeypatch.setattr(settings, "google_project_id", "p")
    monkeypatch.setattr(settings, "google_processor_id", "proc")
    monkeypatch.setattr(settings, "google_credentials_json", "/nonexistent/key.json")
    monkeypatch.setattr(settings, "azure_di_endpoint", "https://example.invalid")
    monkeypatch.setattr(settings, "azure_di_key", "k")
    with pytest.raises(ProviderUnconfigured):
        GoogleDocAiProvider().analyse_page(b"x", "image/png", ["en"])
    with pytest.raises(ProviderUnconfigured):
        AzureDocIntelligenceProvider().analyse_page(b"x", "image/png", ["en"])


# ------------------------------------------------------------------ registry


def test_provider_instances_are_reused():
    a = provider_router.get_provider("azure_di")
    b = provider_router.get_provider("azure_di")
    assert a is b


def test_quality_score_support_is_declared_honestly():
    assert GoogleDocAiProvider.supports_quality_scores is True
    assert AzureDocIntelligenceProvider.supports_quality_scores is False
    assert LocalTesseractProvider.supports_quality_scores is False
