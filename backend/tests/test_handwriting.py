"""Handwriting detection statuses.

The load-bearing rule: a missing, empty or flagless provider response is never reported as
"no handwriting". ``none_detected`` may only come from a response that actually carried tokens
and actually said none of them were handwritten.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.processing.extract.handwriting import (
    CATEGORY_CONFIDENCE_FLOOR,
    MODEL_LOGIC_VERSION,
    detect,
)
from app.processing.providers.base import Line, OcrPage, Word


def word_dict(text: str, x: int, y: int, w: int, h: int, *, hand: bool | None = None,
              confidence: float | None = None) -> dict:
    """A provider word exactly as the Google/Azure adapters store it in ``OcrPage.raw``."""
    return {
        "text": text,
        "polygon": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        "confidence": confidence,
        "is_handwritten": hand,
    }


def page(words: list[dict] | None = None, lines: list[Line] | None = None,
         provider: str = "azure_di") -> OcrPage:
    raw = {} if words is None else {"words": words}
    return OcrPage(
        width=1000,
        height=1400,
        lines=lines or [],
        model_version="prebuilt-read",
        provider=provider,
        raw=raw,
    )


# ------------------------------------------------------------------- failures


def test_a_page_with_no_tokens_at_all_is_failed_not_none_detected():
    result = detect(page())
    assert result.status == "failed"
    assert result.status != "none_detected"
    assert result.regions == []
    assert result.error and "could not be assessed" in result.error
    assert result.provider == "azure_di"
    assert MODEL_LOGIC_VERSION in result.model_version


def test_an_explicitly_empty_word_list_is_also_failed():
    assert detect(page(words=[])).status == "failed"


# ---------------------------------------------------------------- unsupported


def test_a_provider_that_returns_no_handwriting_flags_is_unsupported():
    words = [
        word_dict("Patient", 100, 100, 120, 30, hand=None),
        word_dict("stable", 240, 100, 100, 30, hand=None),
    ]
    result = detect(page(words))
    assert result.status == "unsupported"
    assert result.status != "none_detected"
    assert result.regions == []
    assert "not a finding of 'no handwriting'" in result.error


def test_unsupported_is_reported_even_when_flags_are_explicitly_false_for_some_words():
    """Some words flagged False and some not flagged at all is still an incomplete answer."""
    words = [
        word_dict("Patient", 100, 100, 120, 30, hand=False),
        word_dict("stable", 240, 100, 100, 30, hand=None),
    ]
    assert detect(page(words)).status == "unsupported"


# --------------------------------------------------------------- none detected


def test_words_flagged_false_only_are_none_detected():
    words = [
        word_dict("Patient", 100, 100, 120, 30, hand=False),
        word_dict("stable", 240, 100, 100, 30, hand=False),
    ]
    result = detect(page(words))
    assert result.status == "none_detected"
    assert result.regions == []
    assert result.error is None


def test_words_can_arrive_on_lines_instead_of_in_raw():
    line = Line(
        text="Patient stable",
        polygon=[[100, 100], [400, 100], [400, 130], [100, 130]],
        words=[
            Word(text="Patient", polygon=[[100, 100], [220, 100], [220, 130], [100, 130]],
                 is_handwritten=False),
        ],
    )
    assert detect(page(words=None, lines=[line])).status == "none_detected"


# -------------------------------------------------------------------- detected


def test_handwritten_words_produce_regions():
    words = [
        word_dict("Printed", 100, 100, 120, 30, hand=False),
        word_dict("advised", 100, 200, 130, 32, hand=True, confidence=0.82),
        word_dict("review", 250, 200, 110, 32, hand=True, confidence=0.78),
    ]
    result = detect(page(words))
    assert result.status == "detected"
    assert len(result.regions) == 1, "adjacent words on one line become one region"
    region = result.regions[0]
    assert region.polygon[0] == [100, 200]
    assert region.polygon[2] == [360, 232]
    assert region.confidence == pytest.approx(0.80, abs=1e-6)
    assert region.category == "note"
    assert region.category_confidence >= CATEGORY_CONFIDENCE_FLOOR


def test_words_far_apart_become_separate_regions():
    words = [
        word_dict("advised", 100, 200, 130, 32, hand=True),
        word_dict("consultant", 100, 900, 200, 32, hand=True),
    ]
    result = detect(page(words))
    assert result.status == "detected"
    assert len(result.regions) == 2


def test_a_low_confidence_category_is_reported_as_uncertain():
    """A wide-ish short scrawl scores below the floor, so the guess is withheld."""
    words = [word_dict("abcde", 100, 600, 60, 30, hand=True)]
    result = detect(page(words))
    assert result.status == "detected"
    region = result.regions[0]
    assert region.category == "uncertain"
    assert region.category_confidence < CATEGORY_CONFIDENCE_FLOOR
    # The raw score is kept so the reason for withholding is auditable.
    assert region.category_confidence > 0.0


def test_a_confident_category_survives():
    words = [word_dict("Continue same treatment", 100, 600, 400, 30, hand=True)]
    region = detect(page(words)).regions[0]
    assert region.category == "note"
    assert region.category_confidence >= CATEGORY_CONFIDENCE_FLOOR


def test_every_serialised_category_is_a_known_model_value():
    from app.models.core import HandwritingCategory

    words = [
        word_dict("Continue same treatment", 100, 600, 400, 30, hand=True),
        word_dict("abcde", 100, 900, 60, 30, hand=True),
        word_dict("x", 100, 1200, 20, 20, hand=True),
    ]
    for region in detect(page(words)).regions:
        payload = region.to_json()
        HandwritingCategory(payload["category"])  # raises if the heuristic invents a category
        assert set(payload) == {"category", "category_confidence", "confidence", "polygon",
                                "script_hint"}


def test_mixed_flags_with_at_least_one_handwritten_word_is_detected_not_unsupported():
    words = [
        word_dict("Printed", 100, 100, 120, 30, hand=None),
        word_dict("scrawl", 100, 200, 130, 32, hand=True),
    ]
    assert detect(page(words)).status == "detected"


# ----------------------------------------------------------------- script hint


@pytest.mark.parametrize(
    "text,expected",
    [
        ("advised review", "latin"),
        ("निदान बुखार", "devanagari"),
        ("बुखार fever", "mixed"),
        ("1234 5678", "unknown"),
    ],
)
def test_script_hint(text, expected):
    words = []
    x = 100
    for token in text.split():
        words.append(word_dict(token, x, 300, 40 * len(token), 30, hand=True))
        x += 40 * len(token) + 10
    regions = detect(page(words)).regions
    assert len(regions) == 1, "the words were meant to merge into one region"
    assert regions[0].script_hint == expected


def test_devanagari_and_latin_on_separate_regions_keep_separate_hints():
    words = [
        word_dict("निदान", 100, 200, 120, 30, hand=True),
        word_dict("fever", 100, 900, 120, 30, hand=True),
    ]
    hints = sorted(r.script_hint for r in detect(page(words)).regions)
    assert hints == ["devanagari", "latin"]


# ------------------------------------------------------------------ with image


def test_passing_an_image_does_not_change_the_status():
    image = np.full((1400, 1000, 3), 240, np.uint8)
    words = [word_dict("advised review", 100, 200, 300, 40, hand=True)]
    with_image = detect(page(words), image)
    without_image = detect(page(words))
    assert with_image.status == without_image.status == "detected"
    assert len(with_image.regions) == len(without_image.regions) == 1
