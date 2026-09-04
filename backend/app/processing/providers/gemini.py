"""Google Gemini — prescription interpretation.

This is the *reasoning* half of prescription understanding, not the reading half. The text passed
in ``ocr_text`` is already transcribed by an OCR provider (Google Document AI or Azure DI, whichever
this deployment has configured for ``diagnosis_provider`` / ``ocr_provider``) — Gemini is given that
text plus the source image and asked to structure it, never to re-read handwriting on its own that
the OCR stage already gave up on.

``responseSchema`` forces the model to answer in exactly the shape below, which is what makes the
safety contract enforceable: every medicine reading carries its own confidence and an optional
uncertainty note, ``requires_professional_confirmation`` is part of the schema (not a default we
apply after the fact), and the prompt explicitly forbids inventing a name/dose/instruction that is
not actually present in the text, and forbids stating a confirmed diagnosis.

Talks to the REST endpoint with httpx, matching google_docai.py, rather than pulling in the
google-generativeai SDK.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx

from app.config import settings
from app.processing.providers.base import (
    MedicineReading,
    PrescriptionReasoning,
    PrescriptionReasoningProvider,
    ProviderError,
    ProviderUnconfigured,
)

_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "language_detected": {"type": "STRING"},
        "diagnosis_or_notes": {"type": "STRING"},
        "possible_interpretation": {"type": "STRING"},
        "patient_explanation": {"type": "STRING"},
        "medicines": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "dose": {"type": "STRING"},
                    "frequency": {"type": "STRING"},
                    "duration": {"type": "STRING"},
                    "general_use": {"type": "STRING"},
                    "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                    "uncertainty": {"type": "STRING"},
                },
                "required": ["name", "dose", "frequency", "duration", "confidence"],
            },
        },
        "safety_warnings": {"type": "ARRAY", "items": {"type": "STRING"}},
        "uncertainties": {"type": "ARRAY", "items": {"type": "STRING"}},
        "requires_professional_confirmation": {"type": "BOOLEAN"},
    },
    "required": [
        "language_detected",
        "possible_interpretation",
        "patient_explanation",
        "medicines",
        "safety_warnings",
        "uncertainties",
        "requires_professional_confirmation",
    ],
}

_PROMPT = """You are helping a patient understand a doctor's handwritten prescription. You are NOT \
a doctor and this is NOT a diagnosis.

You are given:
1. Text already transcribed from the prescription by an OCR system (may be incomplete or contain \
errors where handwriting was hard to read).
2. The original prescription image, for context only.

Rules you must follow exactly:
- Only report a medicine, dose, frequency or duration if it is actually present in the OCR text or \
clearly legible in the image. NEVER invent a plausible-sounding drug name, dose or instruction.
- If a medicine name, dose, frequency or duration is unclear, illegible, or you are guessing between \
two readings, set its "confidence" to "low" and explain the ambiguity in "uncertainty". Do not \
silently pick one reading.
- "general_use" must describe what the medicine is generally used for in general terms (e.g. "commonly \
used to reduce fever and pain"). Never state or imply what the patient's diagnosis is — you do not \
know their diagnosis from a medicine list alone.
- "possible_interpretation" is your reading of what the prescription appears to say, phrased as an \
interpretation ("it looks like..."), never as a certainty.
- "patient_explanation" is a short, plain-language summary a non-medical person can understand.
- "safety_warnings" must flag anything that looks unclear, unusual, incomplete (e.g. a dose or \
duration missing), or potentially risky if misread (e.g. a dose that looks unusually high). Leave it \
empty only if nothing stands out.
- "uncertainties" lists every specific word, dose or instruction you could not confidently read.
- Set "requires_professional_confirmation" to true whenever any medicine has confidence below "high", \
or when anything is unclear — which is expected for most handwritten prescriptions. Only set it false \
if every field was clearly, unambiguously legible.
- If the image is not a prescription at all, or has no medicines on it, return an empty "medicines" \
list and say so plainly in "possible_interpretation".
- Never tell the patient to start, stop, or change any medication. That instruction is out of scope \
for you entirely.

OCR text:
---
{ocr_text}
---

Respond with JSON matching the required schema only."""


class GeminiPrescriptionProvider(PrescriptionReasoningProvider):
    name = "gemini"

    def _configured(self) -> bool:
        return bool(settings.gemini_api_key)

    def _endpoint(self) -> str:
        model = settings.gemini_model
        return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def interpret(
        self,
        ocr_text: str,
        image_bytes: bytes,
        mime: str,
        language_hints: list[str] | None = None,
    ) -> PrescriptionReasoning:
        if not self._configured():
            raise ProviderUnconfigured(
                "Gemini is not configured. Set GEMINI_API_KEY to enable prescription interpretation."
            )
        if not settings.allow_cloud_processing:
            raise ProviderUnconfigured(
                "Cloud processing is disabled. Set ALLOW_CLOUD_PROCESSING=true to send pages to a "
                "cloud AI service."
            )

        body: dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": _PROMPT.format(ocr_text=ocr_text or "(no text was transcribed)")},
                        {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode()}},
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": _RESPONSE_SCHEMA,
                "temperature": 0.1,
            },
        }

        try:
            resp = httpx.post(
                self._endpoint(),
                params={"key": settings.gemini_api_key},
                json=body,
                timeout=settings.provider_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"Gemini transport error: {type(exc).__name__}") from exc

        if resp.status_code == 429:
            raise ProviderError("Gemini rate limit (429)")
        if resp.status_code >= 400:
            # Response bodies can echo prompt content; only the status is logged or surfaced.
            raise ProviderError(f"Gemini returned HTTP {resp.status_code}")

        return self._parse(resp.json())

    def _parse(self, payload: dict[str, Any]) -> PrescriptionReasoning:
        candidates = payload.get("candidates") or []
        if not candidates:
            reason = payload.get("promptFeedback", {}).get("blockReason", "no candidates returned")
            raise ProviderError(f"Gemini returned no result: {reason}")

        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderError(f"Gemini response was not valid JSON: {exc}") from exc

        medicines = [
            MedicineReading(
                name=m.get("name", ""),
                dose=m.get("dose", ""),
                frequency=m.get("frequency", ""),
                duration=m.get("duration", ""),
                general_use=m.get("general_use", ""),
                confidence=m.get("confidence", "low"),
                uncertainty=m.get("uncertainty"),
            )
            for m in data.get("medicines", [])
        ]

        return PrescriptionReasoning(
            language_detected=data.get("language_detected"),
            diagnosis_or_notes=data.get("diagnosis_or_notes", ""),
            possible_interpretation=data.get("possible_interpretation", ""),
            patient_explanation=data.get("patient_explanation", ""),
            medicines=medicines,
            safety_warnings=list(data.get("safety_warnings", [])),
            uncertainties=list(data.get("uncertainties", [])),
            requires_professional_confirmation=bool(data.get("requires_professional_confirmation", True)),
            model_version=settings.gemini_model,
            provider=self.name,
        )

    def health(self) -> dict[str, Any]:
        if not self._configured():
            return {"provider": self.name, "configured": False, "reason": "GEMINI_API_KEY not set"}
        if not settings.allow_cloud_processing:
            return {"provider": self.name, "configured": False, "reason": "ALLOW_CLOUD_PROCESSING is false"}
        try:
            resp = httpx.get(
                f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}",
                params={"key": settings.gemini_api_key},
                timeout=10,
            )
            return {"provider": self.name, "configured": True, "reachable": resp.status_code == 200}
        except Exception as exc:  # noqa: BLE001 - health must never raise
            return {"provider": self.name, "configured": True, "reachable": False, "reason": type(exc).__name__}
