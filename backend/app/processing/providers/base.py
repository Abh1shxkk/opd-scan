"""Pluggable AI provider interface.

Three rules hold for every implementation:

1. **An unconfigured provider says so.** It raises ``ProviderUnconfigured`` and the caller records
   an ``unconfigured`` status. It never returns an empty result that would read as "no handwriting
   found" or "no diagnosis on this page".
2. **A failure is a failure.** Network errors, timeouts and quota rejections raise
   ``ProviderError``; the page keeps a ``failed`` status and is retried or surfaced, never silently
   downgraded to a clean result.
3. **Nothing is invented.** Providers return what the model returned, with coordinates and
   confidences as given. Any normalisation is lossless and reversible.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


class ProviderUnconfigured(RuntimeError):
    """Raised when credentials or model files for a capability are absent.

    The caller must surface this as a setup requirement and withhold the result.
    """


class ProviderError(RuntimeError):
    """Raised for transport, quota, timeout and malformed-response failures."""


class ProviderUnsupported(RuntimeError):
    """Raised when a provider cannot do what was asked (e.g. handwritten Devanagari on a provider
    whose language table does not list it). Distinct from a failure: retrying will not help."""


@dataclass
class Word:
    text: str
    polygon: list[list[float]]        # [[x, y], ...] in page pixel coordinates
    confidence: float | None = None
    is_handwritten: bool | None = None
    script: str | None = None         # "latin" | "devanagari" | None when unknown


@dataclass
class Line:
    text: str
    polygon: list[list[float]]
    words: list[Word] = field(default_factory=list)
    confidence: float | None = None
    is_handwritten: bool | None = None


@dataclass
class OcrPage:
    width: int
    height: int
    lines: list[Line] = field(default_factory=list)
    full_text: str = ""
    orientation_deg: int | None = None      # provider-reported page rotation, when available
    languages: list[str] = field(default_factory=list)
    quality_score: float | None = None
    detected_defects: list[dict[str, Any]] = field(default_factory=list)
    model_version: str = ""
    provider: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class OcrProvider(ABC):
    """Any engine that can read a page image."""

    name: str = "abstract"
    supports_quality_scores: bool = False
    #: BCP-47 tags whose *handwriting* this provider claims to read.
    handwriting_languages: set[str] = set()
    #: BCP-47 tags whose *printed* text this provider claims to read.
    print_languages: set[str] = set()

    @abstractmethod
    def analyse_page(self, image_bytes: bytes, mime: str, language_hints: list[str] | None = None) -> OcrPage:
        """Read one page. Raises ProviderUnconfigured / ProviderError / ProviderUnsupported."""

    @abstractmethod
    def health(self) -> dict[str, Any]:
        """Report whether this provider is configured and reachable. Must not raise."""

    def supports_handwriting(self, language: str) -> bool:
        return language.split("-")[0].lower() in {lang.split("-")[0].lower() for lang in self.handwriting_languages}
