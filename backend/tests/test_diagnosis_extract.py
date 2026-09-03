"""Diagnosis extraction: what the transcriber must and must not do.

The rules under test come straight from the module docstring of
``app/processing/extract/diagnosis.py``: transcribe what is written against a diagnosis label,
never invent an ICD code, never expand an abbreviation, never promote a qualified diagnosis to a
confirmed one, and never repair an illegible transcription.
"""

from __future__ import annotations

import pytest

from app.processing.extract.diagnosis import (
    STATUS_NOT_FOUND,
    STATUS_PENDING,
    STATUS_UNCERTAIN,
    STATUS_UNREADABLE,
    extract,
)
from app.processing.providers.base import Line, OcrPage

LINE_HEIGHT = 30
LINE_PITCH = 40


def line(text: str, row: int = 0, *, x: int = 60, width: int = 800,
         confidence: float | None = None, handwritten: bool | None = None) -> Line:
    """One OCR line on an imaginary page, laid out row by row."""
    top = 100 + row * LINE_PITCH
    bottom = top + LINE_HEIGHT
    return Line(
        text=text,
        polygon=[[x, top], [x + width, top], [x + width, bottom], [x, bottom]],
        confidence=confidence,
        is_handwritten=handwritten,
    )


def page(*lines: Line) -> OcrPage:
    return OcrPage(
        width=1000,
        height=1400,
        lines=list(lines),
        full_text="\n".join(ln.text for ln in lines),
        model_version="test-model/1",
        provider="test_provider",
    )


def only(candidates):
    assert len(candidates) == 1, [c.raw_text for c in candidates]
    return candidates[0]


# ------------------------------------------------------------------- anchors


def test_final_diagnosis_label_and_value():
    c = only(extract(page(line("Final Diagnosis : Fibroid uterus"))))
    assert c.status == STATUS_PENDING
    assert c.qualifier == "final"
    assert c.raw_text == "Fibroid uterus"
    assert c.cleaned_text == "Fibroid uterus"
    assert c.anchor_label.lower() == "final diagnosis"
    assert c.icd_code_verbatim is None
    assert c.region is not None


def test_provisional_diagnosis_label_sets_the_provisional_qualifier():
    c = only(extract(page(line("Provisional Diagnosis : Acute appendicitis"))))
    assert c.qualifier == "provisional"
    assert c.status == STATUS_PENDING


@pytest.mark.parametrize(
    "label,expected",
    [
        ("Final Diagnosis", "final"),
        ("Provisional Diagnosis", "provisional"),
        ("Pre-operative Diagnosis", "provisional"),
        ("Post-operative Diagnosis", "final"),
        ("Discharge Diagnosis", "final"),
        ("Differential Diagnosis", "differential"),
        ("Diagnosis", "unspecified"),
        ("Impression", "unspecified"),
        ("Deagnosis", "unspecified"),  # the misspelling printed on the ENT sheet
    ],
)
def test_label_qualifiers(label, expected):
    c = only(extract(page(line(f"{label} : Enlarged thyroid"))))
    assert c.qualifier == expected


# ---------------------------------------------------- text beats the label


def test_rule_out_in_the_text_beats_a_final_diagnosis_label():
    c = only(extract(page(line("Final Diagnosis : r/o TB"))))
    assert c.qualifier == "ruled_out", "a rule-out must never be promoted to a confirmed diagnosis"
    assert c.raw_text == "r/o TB"


@pytest.mark.parametrize(
    "value,expected",
    [
        ("K/C/O DM", "past_history"),
        ("?TB", "suspected"),
        ("suspected enteric fever", "suspected"),
        ("H/O jaundice", "past_history"),
        ("D/D pneumonia", "differential"),
        ("r/o malignancy", "ruled_out"),
    ],
)
def test_qualifier_cues_inside_the_value(value, expected):
    c = only(extract(page(line(f"Final Diagnosis : {value}"))))
    assert c.qualifier == expected
    assert c.qualifier != "final"


# ----------------------------------------------------------------- ICD codes


def test_icd_code_on_the_page_is_carried_verbatim():
    candidates = extract(
        page(
            line("Final Diagnosis : Carcinoma cervix", row=0),
            line("I.C.D. Code : C53.9", row=1),
        )
    )
    c = only(candidates)
    assert c.icd_code_verbatim == "C53.9"


def test_a_malformed_icd_code_is_still_carried_exactly_as_written():
    c = only(
        extract(
            page(
                line("Final Diagnosis : Anaemia", row=0),
                line("International Code of Disease : D5", row=1),
            )
        )
    )
    assert c.icd_code_verbatim == "D5"


def test_no_icd_code_is_invented_when_the_page_carries_none():
    c = only(extract(page(line("Final Diagnosis : Iron deficiency anaemia"))))
    assert c.icd_code_verbatim is None


def test_an_icd_code_far_from_the_entry_is_not_attached():
    candidates = extract(
        page(
            line("Final Diagnosis : Anaemia", row=0),
            line("Treatment plan follows", row=1),
            line("Ward notes continued", row=2),
            line("Observations recorded", row=3),
            line("Nursing handover", row=4),
            line("I.C.D. Code : C53.9", row=12),
        )
    )
    assert only(candidates).icd_code_verbatim is None


# ------------------------------------------------------------ abbreviations


def test_ambiguous_abbreviations_are_flagged_and_never_expanded():
    c = only(extract(page(line("Final Diagnosis : AUB with TAH BSO"))))
    assert c.ambiguous_abbreviations == ["AUB", "BSO", "TAH"]
    assert c.raw_text == "AUB with TAH BSO"
    assert c.cleaned_text == "AUB with TAH BSO"
    for abbreviation in ("AUB", "TAH", "BSO"):
        assert abbreviation in c.cleaned_text
    assert "abnormal uterine" not in c.cleaned_text.lower()
    assert "hysterectomy" not in c.cleaned_text.lower()
    assert "not expanded" in c.note.lower()


def test_a_value_without_known_abbreviations_flags_nothing():
    c = only(extract(page(line("Final Diagnosis : Fibroid uterus"))))
    assert c.ambiguous_abbreviations == []


# --------------------------------------------------- raw vs cleaned text


def test_raw_text_is_preserved_and_every_cleaning_step_is_named():
    c = only(extract(page(line("Final Diagnosis:   Chronic  liver   disease"))))
    assert c.raw_text == "Chronic  liver   disease"
    assert c.cleaned_text == "Chronic liver disease"
    assert c.cleaning_applied == ["collapsed repeated spaces"]
    # Cleaning may only touch whitespace and punctuation, never the words themselves.
    assert c.raw_text.split() == c.cleaned_text.split()


def test_wrapped_value_lines_are_joined_and_the_join_is_recorded():
    c = only(
        extract(
            page(
                line("Final Diagnosis :", row=0),
                line("Chronic obstructive", row=1),
                line("pulmonary disease", row=2),
            )
        )
    )
    assert "\n" in c.raw_text
    assert c.cleaned_text == "Chronic obstructive pulmonary disease"
    assert "joined wrapped lines" in c.cleaning_applied
    assert c.raw_text.split() == c.cleaned_text.split()


def test_nothing_is_recorded_as_applied_when_nothing_was_changed():
    c = only(extract(page(line("Final Diagnosis : Dengue fever"))))
    assert c.cleaning_applied == []
    assert c.raw_text == c.cleaned_text


# ---------------------------------------------------------------- not found


def test_a_page_with_no_diagnosis_label_returns_nothing():
    result = extract(
        page(
            line("Patient reference : 4471", row=0),
            line("Complaints : fever, cough", row=1),
            line("Treatment : paracetamol", row=2),
        )
    )
    assert result == [], "caller maps an empty list to not_found; a candidate must not be invented"


def test_an_empty_page_returns_nothing():
    assert extract(page()) == []
    assert extract(page(line("   ", row=0))) == []


def test_a_label_with_no_value_is_reported_as_not_found_with_a_note():
    c = only(
        extract(
            page(
                line("Final Diagnosis :", row=0),
                # Far below the label: too distant to be a continuation of it.
                line("Signature of consultant", row=8),
            )
        )
    )
    assert c.status == STATUS_NOT_FOUND
    assert c.raw_text == ""
    assert c.cleaned_text == ""
    assert "no value was read" in c.note


# --------------------------------------------------------------- unreadable


def test_a_garbled_value_is_unreadable_and_carries_no_cleaned_text():
    c = only(extract(page(line("Final Diagnosis : ###$%^&*", confidence=0.2))))
    assert c.status == STATUS_UNREADABLE
    assert c.cleaned_text == ""
    assert c.raw_text == "###$%^&*", "the raw transcription is kept so a human can compare it"
    assert c.region is not None
    assert "Read the highlighted region" in c.note


def test_a_low_confidence_but_legible_value_is_uncertain_not_unreadable():
    c = only(extract(page(line("Final Diagnosis : Pulmonary tuberculosis", confidence=0.45))))
    assert c.status == STATUS_UNCERTAIN
    assert c.cleaned_text == "Pulmonary tuberculosis"
    assert "Confirm against the image" in c.note


def test_a_confidence_below_the_legibility_floor_is_unreadable_even_if_the_words_look_fine():
    c = only(extract(page(line("Final Diagnosis : Pulmonary tuberculosis", confidence=0.2))))
    assert c.status == STATUS_UNREADABLE
    assert c.cleaned_text == ""


def test_a_handwritten_value_is_flagged_for_confirmation():
    c = only(extract(page(line("Final Diagnosis : Fibroid uterus", handwritten=True))))
    assert c.is_handwritten is True
    assert c.status == STATUS_PENDING
    assert "confirm the transcription" in c.note.lower()


# --------------------------------------------------------------- multiplicity


def test_multiple_diagnoses_on_one_line_stay_separate_candidates():
    candidates = extract(page(line("Final Diagnosis : Anaemia; Hypothyroidism")))
    assert [c.raw_text for c in candidates] == ["Anaemia", "Hypothyroidism"]
    assert {c.anchor_label.lower() for c in candidates} == {"final diagnosis"}
    # Each keeps its own status and qualifier rather than being merged into one string.
    assert all(c.status == STATUS_PENDING for c in candidates)
    assert all(c.qualifier == "final" for c in candidates)
    assert len({id(c) for c in candidates}) == 2


def test_a_qualifier_applies_only_to_the_piece_that_carries_it():
    candidates = extract(page(line("Diagnosis : Anaemia; r/o tuberculosis")))
    by_text = {c.raw_text: c.qualifier for c in candidates}
    assert by_text["Anaemia"] == "unspecified"
    assert by_text["r/o tuberculosis"] == "ruled_out"


def test_two_diagnosis_labels_on_one_page_produce_two_entries():
    candidates = extract(
        page(
            line("Provisional Diagnosis : Acute appendicitis", row=0),
            line("Final Diagnosis : Perforated appendix", row=6),
        )
    )
    assert len(candidates) == 2
    assert {c.qualifier for c in candidates} == {"provisional", "final"}


# ---------------------------------------------------------------- payload


def test_candidate_serialises_with_every_audit_field():
    c = only(extract(page(line("Final Diagnosis : AUB  with TAH"))))
    payload = c.to_json()
    for key in (
        "status", "anchor_label", "raw_text", "cleaned_text", "qualifier", "icd_code_verbatim",
        "region", "confidence", "is_handwritten", "cleaning_applied", "ambiguous_abbreviations",
        "note",
    ):
        assert key in payload
    assert payload["raw_text"] == "AUB  with TAH"
    assert payload["cleaning_applied"] == ["collapsed repeated spaces"]
    assert payload["ambiguous_abbreviations"] == ["AUB", "TAH"]
