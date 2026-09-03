"""Handwriting detection and region annotation.

The provider tells us *which words are handwritten*. This module turns that into regions a reviewer
can see, and makes a cautious attempt at categorising each one.

Two behaviours are deliberate and load-bearing:

* **Every page is checked**, including pages the quality engine called acceptable. Clean scans
  carry handwriting too — in the sample case files the diagnosis itself is handwritten on an
  otherwise crisp printed form.
* **A missing or failed model response is never reported as "no handwriting."** The caller receives
  a status of ``unconfigured``, ``failed`` or ``unsupported``; only an actual successful analysis
  that found nothing produces ``none_detected``.

Categorisation (note / signature / stamp / tick / correction) is a heuristic over geometry, stroke
statistics and colour. It is right often enough to be useful for triage and wrong often enough that
anything below a confidence floor is labelled ``uncertain`` rather than guessed. In particular a
signature is *not* assumed for every isolated scrawl near the foot of a page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from app.processing.providers.base import OcrPage, Word

MODEL_LOGIC_VERSION = "handwriting-regions/1.0.0"

CATEGORY_CONFIDENCE_FLOOR = 0.55


@dataclass
class HandwritingRegionResult:
    category: str
    category_confidence: float
    confidence: float | None
    polygon: list[list[float]]
    script_hint: str = "unknown"
    text: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "category_confidence": round(self.category_confidence, 3),
            "confidence": self.confidence,
            "polygon": [[float(x), float(y)] for x, y in self.polygon],
            "script_hint": self.script_hint,
        }


@dataclass
class HandwritingResultData:
    status: str                       # detected | none_detected | failed | unconfigured | unsupported
    regions: list[HandwritingRegionResult] = field(default_factory=list)
    model_version: str = ""
    provider: str | None = None
    error: str | None = None


def _script_of(text: str) -> str:
    if not text:
        return "unknown"
    deva = sum(1 for ch in text if "ऀ" <= ch <= "ॿ")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if deva and latin:
        return "mixed"
    if deva:
        return "devanagari"
    if latin:
        return "latin"
    return "unknown"


def _bbox(poly: list[list[float]]) -> tuple[int, int, int, int]:
    xs = [p[0] for p in poly] or [0]
    ys = [p[1] for p in poly] or [0]
    return int(min(xs)), int(min(ys)), int(max(xs) - min(xs)), int(max(ys) - min(ys))


def _merge_words(words: list[Word], gap_factor: float = 1.6) -> list[list[Word]]:
    """Group handwritten words into regions by proximity on the same text line."""
    boxes = [(_bbox(w.polygon), w) for w in words if w.polygon]
    if not boxes:
        return []
    heights = [b[0][3] for b in boxes if b[0][3] > 0]
    med_h = float(np.median(heights)) if heights else 10.0
    boxes.sort(key=lambda t: (round(t[0][1] / max(med_h, 1.0)), t[0][0]))

    groups: list[list[Word]] = []
    current: list[Word] = []
    prev: tuple[int, int, int, int] | None = None
    for (x, y, w, h), word in boxes:
        if prev is None:
            current = [word]
        else:
            px, py, pw, ph = prev
            same_line = abs(y - py) < med_h * 1.0
            near = (x - (px + pw)) < med_h * gap_factor
            if same_line and near:
                current.append(word)
            else:
                groups.append(current)
                current = [word]
        prev = (x, y, w, h)
    if current:
        groups.append(current)
    return groups


def _classify(group: list[Word], image: np.ndarray | None) -> tuple[str, float]:
    """Heuristic category with an explicit confidence. Below the floor, everything is 'uncertain'."""
    text = " ".join(w.text for w in group).strip()
    polys = [p for w in group for p in w.polygon]
    if not polys:
        return "uncertain", 0.0
    x, y, w, h = _bbox(polys)
    if w <= 0 or h <= 0:
        return "uncertain", 0.0
    aspect = w / max(h, 1)
    n_chars = len(text.replace(" ", ""))

    # Tick marks: tiny, roughly square, essentially no recognised text.
    if n_chars <= 1 and 0.4 < aspect < 2.5 and h < 60:
        return "tick", 0.62

    # Stamps: rectangular or circular ink block with a hard outline and often non-blue colour.
    if image is not None and h > 30 and w > 30:
        crop = image[max(y, 0) : y + h, max(x, 0) : x + w]
        if crop.size:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
            edges = cv2.Canny(gray, 60, 160)
            border = float(np.count_nonzero(edges[0:2, :]) + np.count_nonzero(edges[-2:, :])) / max(w, 1)
            if border > 0.5 and 0.6 < aspect < 4.0:
                return "stamp", 0.58

    # Corrections: struck-through or overwritten short fragments sitting inside printed text.
    if n_chars and n_chars <= 4 and aspect > 3.0:
        return "correction", 0.56

    # Signatures: cursive, wide-and-short, and little or no recognisable text. A scrawl that the OCR
    # engine could not read is the strongest available cue; position on the page is not used, because
    # notes appear at the foot of these forms as often as signatures do.
    if aspect > 2.5 and n_chars <= 3:
        return "signature", 0.60
    if aspect > 1.8 and n_chars <= 6 and h > 20:
        return "signature", 0.50  # below the floor → will be reported as uncertain

    if n_chars >= 4:
        return "note", 0.75

    return "uncertain", 0.0


def detect(page: OcrPage, image: np.ndarray | None = None) -> HandwritingResultData:
    """Turn a successful provider response into handwriting regions.

    Callers must map ``ProviderUnconfigured`` / ``ProviderError`` / ``ProviderUnsupported`` to the
    matching status *before* calling this; reaching here means the provider answered.
    """
    words: list[Word] = []
    for w in page.raw.get("words", []) or []:
        if isinstance(w, dict):
            words.append(
                Word(
                    text=w.get("text", ""),
                    polygon=w.get("polygon") or [],
                    confidence=w.get("confidence"),
                    is_handwritten=w.get("is_handwritten"),
                )
            )
        else:
            words.append(w)
    if not words:
        for ln in page.lines:
            words.extend(ln.words)

    flagged = [w for w in words if w.is_handwritten is True]

    if not words:
        # The provider returned a page with no tokens at all. That is not the same as a page with
        # no handwriting on it, and must not be recorded as one.
        return HandwritingResultData(
            status="failed",
            model_version=f"{page.model_version}+{MODEL_LOGIC_VERSION}",
            provider=page.provider,
            error="Provider returned no tokens for this page; handwriting could not be assessed.",
        )

    if any(w.is_handwritten is None for w in words) and not flagged:
        return HandwritingResultData(
            status="unsupported",
            model_version=f"{page.model_version}+{MODEL_LOGIC_VERSION}",
            provider=page.provider,
            error=(
                "The configured provider did not return handwriting flags for this page, so "
                "handwriting could not be assessed. This is not a finding of 'no handwriting'."
            ),
        )

    if not flagged:
        return HandwritingResultData(
            status="none_detected",
            model_version=f"{page.model_version}+{MODEL_LOGIC_VERSION}",
            provider=page.provider,
        )

    regions: list[HandwritingRegionResult] = []
    for group in _merge_words(flagged):
        polys = [p for w in group for p in w.polygon]
        x, y, w, h = _bbox(polys)
        text = " ".join(g.text for g in group).strip()
        category, cat_conf = _classify(group, image)
        if cat_conf < CATEGORY_CONFIDENCE_FLOOR:
            category = "uncertain"
        confs = [g.confidence for g in group if g.confidence is not None]
        regions.append(
            HandwritingRegionResult(
                category=category,
                category_confidence=cat_conf,
                confidence=float(np.mean(confs)) if confs else None,
                polygon=[[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
                script_hint=_script_of(text),
                text=text,
            )
        )

    return HandwritingResultData(
        status="detected",
        regions=regions,
        model_version=f"{page.model_version}+{MODEL_LOGIC_VERSION}",
        provider=page.provider,
    )
