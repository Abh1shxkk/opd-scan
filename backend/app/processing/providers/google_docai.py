"""Google Cloud Document AI — Enterprise Document OCR.

Verified against Google's public documentation, September 2026:

* ``processOptions.ocrConfig.enableImageQualityScores`` returns ``Document.pages[].imageQualityScores``
  with a ``qualityScore`` in 0..1 and, below 0.5, a sorted ``detectedDefects`` list drawn from eight
  types: blurry, noisy, dark, faint, text_too_small, document_cutoff, text_cutoff, glare.
* Handwriting is detected by default at paragraph/block/line/word level; the font-style add-on marks
  handwriting at token level.
* Hindi is supported for **printed** text (`hi`, Devanagari). Google's language table does **not**
  list handwriting support for Hindi — so this provider declares Latin-script handwriting only and
  raises ``ProviderUnsupported`` when asked for handwritten Devanagari, rather than returning a
  confident-looking wrong answer. The router sends those pages to Azure instead.

This module talks to the REST endpoint with httpx rather than pulling in the full Google client
library, to keep the on-premises image small. Authentication uses a service-account key exchanged
for an access token.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx

from app.config import settings
from app.processing.providers.base import (
    Line,
    OcrPage,
    OcrProvider,
    ProviderError,
    ProviderUnconfigured,
    ProviderUnsupported,
    Word,
)

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


class GoogleDocAiProvider(OcrProvider):
    name = "google_docai"
    supports_quality_scores = True
    # Deliberately narrow: only what Google documents as handwriting-capable.
    handwriting_languages = {"en", "fr", "de", "es", "it", "pt", "nl"}
    print_languages = {"en", "hi", "mr", "ne", "sa", "bn", "ta", "te", "kn", "ml", "gu", "pa", "ur"}

    def __init__(self) -> None:
        self._token: str | None = None
        self._token_exp: float = 0.0

    # ------------------------------------------------------------------ auth

    def _configured(self) -> bool:
        return bool(
            settings.google_project_id and settings.google_processor_id and settings.google_credentials_json
        )

    def _access_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        try:
            import jwt as pyjwt

            with open(settings.google_credentials_json, encoding="utf-8") as fh:
                key = json.load(fh)
            now = int(time.time())
            assertion = pyjwt.encode(
                {
                    "iss": key["client_email"],
                    "scope": _SCOPE,
                    "aud": _TOKEN_URL,
                    "iat": now,
                    "exp": now + 3600,
                },
                key["private_key"],
                algorithm="RS256",
            )
            resp = httpx.post(
                _TOKEN_URL,
                data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
                timeout=30,
            )
            resp.raise_for_status()
            payload = resp.json()
            self._token = payload["access_token"]
            self._token_exp = time.time() + float(payload.get("expires_in", 3600))
            return self._token
        except FileNotFoundError as exc:
            raise ProviderUnconfigured(f"Google credentials file not found: {exc}") from exc
        except Exception as exc:
            raise ProviderError(f"Google token exchange failed: {type(exc).__name__}") from exc

    # --------------------------------------------------------------- request

    def _endpoint(self) -> str:
        loc = settings.google_location
        host = "documentai.googleapis.com" if loc == "us" else f"{loc}-documentai.googleapis.com"
        return (
            f"https://{host}/v1/projects/{settings.google_project_id}"
            f"/locations/{loc}/processors/{settings.google_processor_id}:process"
        )

    def analyse_page(self, image_bytes: bytes, mime: str, language_hints: list[str] | None = None) -> OcrPage:
        if not self._configured():
            raise ProviderUnconfigured(
                "Google Document AI is not configured. Set GOOGLE_PROJECT_ID, GOOGLE_PROCESSOR_ID "
                "and GOOGLE_CREDENTIALS_JSON."
            )
        if not settings.allow_cloud_processing:
            raise ProviderUnconfigured(
                "Cloud processing is disabled. Set ALLOW_CLOUD_PROCESSING=true to send pages to a "
                "cloud OCR service."
            )
        hints = [h for h in (language_hints or []) if h]
        # Hints arrive as "hi:handwritten" — the capability suffix must be stripped before the
        # language is read, or this guard silently never fires and the request goes out anyway.
        if any(
            h.split(":")[0].split("-")[0].lower() in {"hi", "mr", "ne", "sa"} and h.endswith(":handwritten")
            for h in hints
        ):
            raise ProviderUnsupported(
                "Google Document AI does not list handwriting support for Devanagari languages."
            )

        body: dict[str, Any] = {
            "rawDocument": {"content": base64.b64encode(image_bytes).decode(), "mimeType": mime},
            "processOptions": {
                "ocrConfig": {
                    "enableImageQualityScores": settings.google_enable_quality_scores,
                    "enableSymbol": False,
                    "premiumFeatures": {"computeStyleInfo": True},
                }
            },
        }
        if hints:
            body["processOptions"]["ocrConfig"]["hints"] = {
                "languageHints": [h.split(":")[0] for h in hints]
            }

        try:
            resp = httpx.post(
                self._endpoint(),
                headers={"Authorization": f"Bearer {self._access_token()}", "Content-Type": "application/json"},
                json=body,
                timeout=settings.provider_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"Google Document AI transport error: {type(exc).__name__}") from exc

        if resp.status_code == 429:
            raise ProviderError("Google Document AI rate limit (429)")
        if resp.status_code >= 400:
            # Response bodies can echo document content; only the status is logged or surfaced.
            raise ProviderError(f"Google Document AI returned HTTP {resp.status_code}")

        return self._parse(resp.json().get("document", {}))

    # ----------------------------------------------------------------- parse

    @staticmethod
    def _text_from_anchor(full_text: str, anchor: dict[str, Any]) -> str:
        out = []
        for seg in anchor.get("textSegments", []) or []:
            start = int(seg.get("startIndex", 0) or 0)
            end = int(seg.get("endIndex", 0) or 0)
            out.append(full_text[start:end])
        return "".join(out)

    @staticmethod
    def _poly(layout: dict[str, Any], w: int, h: int) -> list[list[float]]:
        poly = (layout.get("boundingPoly") or {}).get("normalizedVertices") or []
        if poly:
            return [[float(v.get("x", 0.0)) * w, float(v.get("y", 0.0)) * h] for v in poly]
        poly = (layout.get("boundingPoly") or {}).get("vertices") or []
        return [[float(v.get("x", 0.0)), float(v.get("y", 0.0))] for v in poly]

    def _parse(self, doc: dict[str, Any]) -> OcrPage:
        full_text = doc.get("text", "") or ""
        pages = doc.get("pages") or []
        if not pages:
            return OcrPage(width=0, height=0, full_text=full_text, provider=self.name)
        p = pages[0]
        dim = p.get("dimension") or {}
        w, h = int(dim.get("width", 0) or 0), int(dim.get("height", 0) or 0)

        # token index → handwriting flag, from the style info add-on
        token_hand: dict[int, bool] = {}
        for idx, tok in enumerate(p.get("tokens") or []):
            style = tok.get("styleInfo") or {}
            if "handwritten" in style:
                token_hand[idx] = bool(style.get("handwritten"))

        lines: list[Line] = []
        for ln in p.get("lines") or []:
            layout = ln.get("layout") or {}
            text = self._text_from_anchor(full_text, layout.get("textAnchor") or {})
            lines.append(
                Line(
                    text=text,
                    polygon=self._poly(layout, w, h),
                    confidence=layout.get("confidence"),
                    is_handwritten=None,
                )
            )

        words: list[Word] = []
        for idx, tok in enumerate(p.get("tokens") or []):
            layout = tok.get("layout") or {}
            words.append(
                Word(
                    text=self._text_from_anchor(full_text, layout.get("textAnchor") or {}),
                    polygon=self._poly(layout, w, h),
                    confidence=layout.get("confidence"),
                    is_handwritten=token_hand.get(idx),
                )
            )
        if lines and words:
            lines[0].words = words  # attach; per-line association is done by the caller via geometry

        iq = (p.get("imageQualityScores") or {})
        defects = [
            {"type": d.get("type"), "confidence": d.get("confidence")}
            for d in (iq.get("detectedDefects") or [])
        ]
        langs = [d.get("languageCode") for d in (p.get("detectedLanguages") or []) if d.get("languageCode")]

        orientation = None
        transforms = p.get("transforms") or []
        if transforms:
            orientation = 0  # Document AI de-skews internally; exact angle is not exposed here.

        return OcrPage(
            width=w,
            height=h,
            lines=lines,
            full_text=full_text,
            orientation_deg=orientation,
            languages=langs,
            quality_score=iq.get("qualityScore"),
            detected_defects=defects,
            model_version=str(doc.get("revisions", [{}])[0].get("processor", "") or "enterprise-ocr"),
            provider=self.name,
            raw={"words": [w_.__dict__ for w_ in words]},
        )

    def health(self) -> dict[str, Any]:
        if not self._configured():
            return {
                "provider": self.name,
                "configured": False,
                "reason": "GOOGLE_PROJECT_ID / GOOGLE_PROCESSOR_ID / GOOGLE_CREDENTIALS_JSON not set",
            }
        if not settings.allow_cloud_processing:
            return {"provider": self.name, "configured": False, "reason": "ALLOW_CLOUD_PROCESSING is false"}
        try:
            self._access_token()
            return {"provider": self.name, "configured": True, "reachable": True}
        except Exception as exc:
            return {"provider": self.name, "configured": True, "reachable": False, "reason": type(exc).__name__}
