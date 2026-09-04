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


# --------------------------------------------------------- prescription reasoning
#
# A different capability from OcrProvider above: this does not read pixels into text, it reasons
# over text (and optionally the image) an OCR provider already produced. Kept as a separate
# interface rather than another OcrProvider method because the two are genuinely different jobs —
# one transcribes, the other interprets — and the "never invent" rule applies differently to each:
# an OCR provider that cannot read a word must say so; a reasoning provider that is unsure what a
# transcribed word means must say so instead of picking the most plausible drug name.


@dataclass
class MedicineReading:
    name: str
    dose: str
    frequency: str
    duration: str
    general_use: str                    # what it is generally used for — never a diagnosis claim
    confidence: str = "low"             # low | medium | high
    uncertainty: str | None = None


@dataclass
class PrescriptionReasoning:
    language_detected: str | None
    diagnosis_or_notes: str
    possible_interpretation: str
    patient_explanation: str
    medicines: list[MedicineReading] = field(default_factory=list)
    safety_warnings: list[str] = field(default_factory=list)
    uncertainties: list[str] = field(default_factory=list)
    requires_professional_confirmation: bool = True
    model_version: str = ""
    provider: str = ""


class PrescriptionReasoningProvider(ABC):
    """Turns OCR text (plus the source image, for providers that can use it) into a structured,
    conservative reading of a prescription. Never returns a confirmed diagnosis or an instruction to
    start/stop/change medication — that framing is enforced in the prompt/response contract of each
    implementation, not left to the caller to add afterwards."""

    name: str = "abstract"

    @abstractmethod
    def interpret(
        self,
        ocr_text: str,
        image_bytes: bytes,
        mime: str,
        language_hints: list[str] | None = None,
    ) -> PrescriptionReasoning:
        """Raises ProviderUnconfigured / ProviderError. Never raises for "handwriting too poor to
        read" — that is a normal outcome, reported via a low-confidence / unreadable result."""

    @abstractmethod
    def health(self) -> dict[str, Any]:
        """Report whether this provider is configured and reachable. Must not raise."""
