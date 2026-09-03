"""Azure AI Document Intelligence — prebuilt-read.

Verified against Microsoft's public language-support tables, September 2026: the Read model lists
Hindi (`hi`) under **handwritten**-supported languages as well as printed. That is the reason this
provider exists alongside Google — Google's table does not list handwriting support for Hindi, and
the case files in scope carry handwritten Devanagari progress notes.

Azure returns handwriting as ``analyzeResult.styles[]`` entries with ``isHandwritten`` and character
``spans``. Spans index into the concatenated content string, so they are mapped back onto words here
to produce polygons. No equivalent of Google's image-quality scores exists, so quality analysis for
Azure-routed pages comes from the local engine alone — which is what happens for every page anyway.
"""

from __future__ import annotations

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
    Word,
)

_API_VERSION = "2024-11-30"


class AzureDocIntelligenceProvider(OcrProvider):
    name = "azure_di"
    supports_quality_scores = False
    handwriting_languages = {
        "en", "hi", "ar", "zh-Hans", "zh-Hant", "fr", "de", "it", "ja", "ko", "pt", "ru", "es", "tr",
        "af", "ast", "awa", "az", "be", "bg", "ca", "cs",
    }
    print_languages = {"en", "hi", "mr", "ne", "sa", "ur", "bn", "ta", "te", "kn", "ml", "gu", "pa"}

    def _configured(self) -> bool:
        return bool(settings.azure_di_endpoint and settings.azure_di_key)

    def analyse_page(self, image_bytes: bytes, mime: str, language_hints: list[str] | None = None) -> OcrPage:
        if not self._configured():
            raise ProviderUnconfigured(
                "Azure Document Intelligence is not configured. Set AZURE_DI_ENDPOINT and AZURE_DI_KEY."
            )
        if not settings.allow_cloud_processing:
            raise ProviderUnconfigured(
                "Cloud processing is disabled. Set ALLOW_CLOUD_PROCESSING=true to send pages to a "
                "cloud OCR service."
            )

        base = settings.azure_di_endpoint.rstrip("/")
        url = f"{base}/documentintelligence/documentModels/prebuilt-read:analyze?api-version={_API_VERSION}"
        headers = {"Ocp-Apim-Subscription-Key": settings.azure_di_key, "Content-Type": mime}
        try:
            resp = httpx.post(url, headers=headers, content=image_bytes, timeout=settings.provider_timeout_seconds)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Azure DI transport error: {type(exc).__name__}") from exc

        if resp.status_code == 429:
            raise ProviderError("Azure DI rate limit (429)")
        if resp.status_code not in (200, 202):
            raise ProviderError(f"Azure DI returned HTTP {resp.status_code}")

        result = resp.json() if resp.status_code == 200 else self._poll(resp.headers.get("operation-location", ""))
        return self._parse(result)

    def _poll(self, op_url: str) -> dict[str, Any]:
        if not op_url:
            raise ProviderError("Azure DI accepted the request but returned no operation-location")
        headers = {"Ocp-Apim-Subscription-Key": settings.azure_di_key}
        deadline = time.time() + settings.provider_timeout_seconds
        delay = 1.0
        while time.time() < deadline:
            time.sleep(delay)
            delay = min(delay * 1.5, 5.0)
            try:
                r = httpx.get(op_url, headers=headers, timeout=30)
            except httpx.HTTPError as exc:
                raise ProviderError(f"Azure DI poll error: {type(exc).__name__}") from exc
            if r.status_code >= 400:
                raise ProviderError(f"Azure DI poll returned HTTP {r.status_code}")
            body = r.json()
            status = body.get("status")
            if status == "succeeded":
                return body
            if status == "failed":
                raise ProviderError("Azure DI analysis failed")
        raise ProviderError("Azure DI analysis timed out")

    @staticmethod
    def _poly(obj: dict[str, Any]) -> list[list[float]]:
        pts = obj.get("polygon") or []
        return [[float(pts[i]), float(pts[i + 1])] for i in range(0, len(pts) - 1, 2)]

    def _parse(self, body: dict[str, Any]) -> OcrPage:
        ar = body.get("analyzeResult") or body
        pages = ar.get("pages") or []
        if not pages:
            return OcrPage(width=0, height=0, provider=self.name)
        p = pages[0]

        # Handwritten character spans → offsets, so words can be flagged individually.
        hand_spans: list[tuple[int, int]] = []
        for st in ar.get("styles") or []:
            if st.get("isHandwritten"):
                for sp in st.get("spans") or []:
                    off = int(sp.get("offset", 0))
                    hand_spans.append((off, off + int(sp.get("length", 0))))

        def _is_hand(span: dict[str, Any] | None) -> bool | None:
            if not span or not hand_spans:
                return None if not hand_spans else False
            off = int(span.get("offset", 0))
            end = off + int(span.get("length", 0))
            return any(off < he and end > hs for hs, he in hand_spans)

        words: list[Word] = []
        for wd in p.get("words") or []:
            words.append(
                Word(
                    text=wd.get("content", ""),
                    polygon=self._poly(wd),
                    confidence=wd.get("confidence"),
                    is_handwritten=_is_hand(wd.get("span")),
                )
            )

        lines: list[Line] = []
        for ln in p.get("lines") or []:
            spans = ln.get("spans") or [{}]
            lines.append(
                Line(
                    text=ln.get("content", ""),
                    polygon=self._poly(ln),
                    confidence=None,
                    is_handwritten=_is_hand(spans[0] if spans else None),
                )
            )
        if lines and words:
            lines[0].words = words

        langs = [d.get("locale") for d in (ar.get("languages") or []) if d.get("locale")]
        angle = p.get("angle")
        orientation = None
        if angle is not None:
            a = float(angle) % 360
            orientation = min((0, 90, 180, 270), key=lambda t: min(abs(a - t), 360 - abs(a - t)))

        return OcrPage(
            width=int(p.get("width", 0) or 0),
            height=int(p.get("height", 0) or 0),
            lines=lines,
            full_text=ar.get("content", "") or "",
            orientation_deg=orientation,
            languages=langs,
            quality_score=None,
            detected_defects=[],
            model_version=str(ar.get("modelId", "prebuilt-read")),
            provider=self.name,
            raw={"words": [w.__dict__ for w in words], "unit": p.get("unit", "pixel")},
        )

    def health(self) -> dict[str, Any]:
        if not self._configured():
            return {"provider": self.name, "configured": False, "reason": "AZURE_DI_ENDPOINT / AZURE_DI_KEY not set"}
        if not settings.allow_cloud_processing:
            return {"provider": self.name, "configured": False, "reason": "ALLOW_CLOUD_PROCESSING is false"}
        return {"provider": self.name, "configured": True, "reachable": None}
