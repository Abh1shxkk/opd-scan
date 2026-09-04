"""Prescription understanding: the Gemini reasoning provider and its wiring into the router.

Nothing here touches the network — every path either refuses before the HTTP call, or exercises
_parse() directly against a response shaped like Gemini's actual JSON-mode output. The behaviours
under test are the safety-contract ones: an uncertain reading stays uncertain (never silently
upgraded to confident), requires_professional_confirmation is read from the model's own JSON not
invented by the parser, and an unconfigured/blocked/malformed response is a refusal or a
ProviderError, never an empty-but-successful result that could read as "nothing to worry about".
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.processing.providers import router as provider_router
from app.processing.providers.base import ProviderError, ProviderUnconfigured
from app.processing.providers.gemini import GeminiPrescriptionProvider


@pytest.fixture()
def gemini_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "allow_cloud_processing", True)


# ------------------------------------------------------------- unconfigured


def test_refuses_without_an_api_key():
    with pytest.raises(ProviderUnconfigured):
        GeminiPrescriptionProvider().interpret("some text", b"\x89PNG", "image/png")


def test_refuses_when_cloud_processing_is_disabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "allow_cloud_processing", False)
    with pytest.raises(ProviderUnconfigured):
        GeminiPrescriptionProvider().interpret("some text", b"\x89PNG", "image/png")


def test_health_reports_unconfigured_without_a_key():
    h = GeminiPrescriptionProvider().health()
    assert h["configured"] is False


# -------------------------------------------------------------------- router


def test_prescription_capability_is_unconfigured_by_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "prescription_reasoning_provider", "none")
    status = provider_router.capability_status()["prescription"]
    assert status["status"] == "unconfigured"
    assert status["provider"] is None


def test_prescription_capability_reports_ready_once_configured(gemini_configured, monkeypatch):
    monkeypatch.setattr(settings, "prescription_reasoning_provider", "gemini")
    status = provider_router.capability_status()["prescription"]
    assert status["status"] == "ready"
    assert status["provider"] == "gemini"


def test_get_reasoning_provider_rejects_none_and_unknown_names():
    with pytest.raises(ProviderUnconfigured):
        provider_router.get_reasoning_provider("none")
    with pytest.raises(ProviderUnconfigured):
        provider_router.get_reasoning_provider("not-a-real-provider")


# --------------------------------------------------------------- parsing


def _payload(text: str) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


def test_parse_keeps_low_confidence_and_uncertainty_verbatim():
    body = """{
        "language_detected": "English",
        "diagnosis_or_notes": "",
        "possible_interpretation": "It looks like a prescription for fever and cough.",
        "patient_explanation": "Two medicines, one for fever and one for cough.",
        "medicines": [
            {"name": "Paracetamol", "dose": "500mg", "frequency": "twice daily", "duration": "5 days",
             "general_use": "commonly used to reduce fever and pain", "confidence": "high"},
            {"name": "Amoxi??illin", "dose": "unclear", "frequency": "unclear", "duration": "",
             "general_use": "an antibiotic, if that reading is correct", "confidence": "low",
             "uncertainty": "The drug name is only partly legible; could be Amoxicillin or a different antibiotic."}
        ],
        "safety_warnings": ["One medicine's dose could not be confirmed."],
        "uncertainties": ["Second medicine name and dose"],
        "requires_professional_confirmation": true
    }"""
    result = GeminiPrescriptionProvider()._parse(_payload(body))

    assert result.language_detected == "English"
    assert len(result.medicines) == 2
    assert result.medicines[0].confidence == "high"
    assert result.medicines[0].uncertainty is None
    assert result.medicines[1].confidence == "low"
    assert "partly legible" in result.medicines[1].uncertainty
    assert result.requires_professional_confirmation is True
    assert result.safety_warnings == ["One medicine's dose could not be confirmed."]


def test_parse_does_not_invent_confirmation_flag_it_defaults_true():
    # A response that omits the field entirely must still err conservative, not permissive.
    body = """{
        "language_detected": "English",
        "possible_interpretation": "Not a prescription.",
        "patient_explanation": "",
        "medicines": [],
        "safety_warnings": [],
        "uncertainties": []
    }"""
    result = GeminiPrescriptionProvider()._parse(_payload(body))
    assert result.requires_professional_confirmation is True
    assert result.medicines == []


def test_parse_raises_provider_error_on_blocked_response():
    with pytest.raises(ProviderError):
        GeminiPrescriptionProvider()._parse({"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}})


def test_parse_raises_provider_error_on_malformed_json():
    with pytest.raises(ProviderError):
        GeminiPrescriptionProvider()._parse(_payload("not valid json"))
