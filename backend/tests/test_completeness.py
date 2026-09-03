"""Completeness: a different question from scan quality, with a different default answer.

The default is "Completeness not verified" and it is never upgraded merely because the uploaded
files processed cleanly.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.models import Case, Checklist, ChecklistItem
from app.services import completeness as completeness_service
from app.services.completeness import (
    NOT_VERIFIED_MESSAGE,
    STATUS_INCOMPLETE,
    STATUS_NOT_VERIFIED,
    STATUS_VERIFIED,
)
from tests.conftest import attach_version, make_page_version, text_page_image


def distinct_page(seed: int) -> np.ndarray:
    """A page that is visually unlike every other page produced here."""
    img = text_page_image(width=600, height=800, line=f"Ward note number {seed}")
    cv2.rectangle(img, (40, 40 + seed * 60), (560, 120 + seed * 60), (10, 10, 10), -1)
    cv2.circle(img, (300, 400), 40 + seed * 30, (20, 20, 20), -1)
    return img


def slightly_different(image: np.ndarray) -> np.ndarray:
    """The same sheet scanned again: a touch brighter and a pixel off, but the same page."""
    shifted = np.roll(image, 2, axis=1)
    return cv2.convertScaleAbs(shifted, alpha=1.0, beta=4)


@pytest.fixture()
def case(db, batch) -> Case:
    c = Case(batch_id=batch.id, patient_ref="P-100", encounter_ref="E-100")
    db.add(c)
    db.commit()
    return c


def labelled_document(db, storage, batch, case, labels: list[tuple[str, int]]):
    """One document whose logical pages carry the given pre-printed page labels."""
    from app.models import LogicalPage

    from tests.conftest import make_document

    doc = make_document(db, batch=batch, filename="case-sheet.pdf", case=case)
    for ordinal, (label, seed) in enumerate(labels, start=1):
        page = LogicalPage(document_id=doc.id, ordinal=ordinal, source_page_index=ordinal - 1,
                           printed_page_label=label)
        db.add(page)
        db.flush()
        attach_version(db, storage, page, distinct_page(seed))
    db.commit()
    return doc


def make_checklist(db, name: str, items: list[tuple[str, int, bool]]) -> Checklist:
    checklist = Checklist(name=name)
    db.add(checklist)
    db.flush()
    for doc_type, min_pages, required in items:
        db.add(ChecklistItem(checklist_id=checklist.id, doc_type=doc_type, min_pages=min_pages,
                             required=required))
    db.commit()
    return checklist


# ------------------------------------------------------------- the default


def test_summarise_with_no_result_at_all_is_the_not_verified_message():
    summary = completeness_service.summarise(None)
    assert summary["status"] == STATUS_NOT_VERIFIED
    assert summary["label"] == "Completeness not verified"
    assert summary["findings"] == {}


def test_a_case_without_a_checklist_is_not_verified(db, storage, batch, case):
    make_page_version(db, storage, batch=batch, case=case, filename="ward-notes.pdf", ordinal=1,
                      image=distinct_page(1))

    result = completeness_service.compute(db, case)
    db.commit()

    assert result.status == STATUS_NOT_VERIFIED
    summary = completeness_service.summarise(result)
    assert summary["label"] == NOT_VERIFIED_MESSAGE
    assert summary["label"] == "Completeness not verified"
    assert any("cannot be verified" in note for note in result.findings_json["notes"])
    assert result.findings_json["uploaded_pages"] == 1


def test_clean_processing_never_upgrades_a_case_to_complete(db, storage, batch, case):
    """Files that processed perfectly say nothing about the files nobody scanned."""
    for i in range(3):
        make_page_version(db, storage, batch=batch, case=case, filename=f"doc-{i}.pdf",
                          ordinal=1, image=distinct_page(i))
    result = completeness_service.compute(db, case)
    assert result.status == STATUS_NOT_VERIFIED
    assert result.status != STATUS_VERIFIED


# -------------------------------------------------------------- duplicates


def test_near_identical_pages_are_reported_as_duplicates(db, storage, batch, case):
    original = distinct_page(1)
    make_page_version(db, storage, batch=batch, case=case, filename="notes.pdf", ordinal=1,
                      image=original)
    make_page_version(db, storage, batch=batch, case=case, filename="notes-rescan.pdf", ordinal=2,
                      image=slightly_different(original))

    findings = completeness_service.compute(db, case).findings_json

    assert len(findings["duplicates"]) == 1
    duplicate = findings["duplicates"][0]
    assert duplicate["ordinal"] == 2
    assert duplicate["duplicate_of_ordinal"] == 1
    assert "near-identical" in duplicate["note"]
    # The finding is phrased as a possibility, not a verdict.
    assert "may be" in duplicate["note"].lower()


def test_visually_different_pages_are_not_duplicates(db, storage, batch, case):
    for i in (1, 2, 3):
        make_page_version(db, storage, batch=batch, case=case, filename=f"doc-{i}.pdf",
                          ordinal=i, image=distinct_page(i))

    assert completeness_service.compute(db, case).findings_json["duplicates"] == []


def test_duplicates_are_computed_even_without_a_checklist(db, storage, batch, case):
    original = distinct_page(4)
    make_page_version(db, storage, batch=batch, case=case, filename="a.pdf", ordinal=1, image=original)
    make_page_version(db, storage, batch=batch, case=case, filename="b.pdf", ordinal=2,
                      image=slightly_different(original))

    result = completeness_service.compute(db, case)
    assert result.status == STATUS_NOT_VERIFIED
    assert len(result.findings_json["duplicates"]) == 1


# ----------------------------------------------------------- sequence gaps


def test_a_gap_in_the_printed_page_numbers_is_reported_with_the_missing_numbers(db, storage, batch, case):
    labelled_document(db, storage, batch, case, [("(1)", 1), ("(2)", 2), ("(5)", 3)])

    gaps = completeness_service.compute(db, case).findings_json["sequence_gaps"]

    assert len(gaps) == 1
    assert gaps[0]["found_range"] == [1, 5]
    assert gaps[0]["missing_numbers"] == [3, 4]
    assert "cannot be known" in gaps[0]["note"], "the system must not claim what was on those pages"


def test_consecutive_printed_labels_produce_no_gap(db, storage, batch, case):
    labelled_document(db, storage, batch, case, [("(7)", 1), ("(8)", 2), ("(9)", 3)])

    assert completeness_service.compute(db, case).findings_json["sequence_gaps"] == []


def test_too_few_labels_to_judge_produces_no_gap(db, storage, batch, case):
    labelled_document(db, storage, batch, case, [("(1)", 1), ("(9)", 2)])

    assert completeness_service.compute(db, case).findings_json["sequence_gaps"] == []


# ------------------------------------------------------------- checklists


def test_a_missing_required_document_type_makes_the_case_incomplete(db, storage, batch, case):
    checklist = make_checklist(db, "OPD standard", [("discharge_summary", 1, True),
                                                    ("consent_form", 1, True)])
    case.checklist_id = checklist.id
    db.add(case)
    db.commit()

    make_page_version(db, storage, batch=batch, case=case, filename="consent_form.pdf", ordinal=1,
                      image=distinct_page(1))

    result = completeness_service.compute(db, case)

    assert result.status == STATUS_INCOMPLETE
    missing = result.findings_json["missing"]
    assert [m["doc_type"] for m in missing] == ["discharge_summary"]
    assert missing[0]["found_pages"] == 0
    assert completeness_service.summarise(result)["label"] == "Incomplete against the attached checklist"


def test_a_document_type_with_too_few_pages_is_also_missing(db, storage, batch, case):
    checklist = make_checklist(db, "OPD standard", [("discharge_summary", 3, True)])
    case.checklist_id = checklist.id
    db.add(case)
    db.commit()

    make_page_version(db, storage, batch=batch, case=case, filename="discharge_summary.pdf",
                      ordinal=1, image=distinct_page(1))

    result = completeness_service.compute(db, case)
    assert result.status == STATUS_INCOMPLETE
    assert result.findings_json["missing"][0] == {
        "doc_type": "discharge_summary", "expected_min_pages": 3, "found_pages": 1,
    }


def test_a_satisfied_checklist_is_verified_but_says_what_it_cannot_see(db, storage, batch, case):
    checklist = make_checklist(db, "OPD standard", [("discharge_summary", 1, True)])
    case.checklist_id = checklist.id
    db.add(case)
    db.commit()

    make_page_version(db, storage, batch=batch, case=case, filename="discharge_summary.pdf",
                      ordinal=1, image=distinct_page(1))

    result = completeness_service.compute(db, case)
    assert result.status == STATUS_VERIFIED
    assert result.findings_json["missing"] == []
    assert result.findings_json["checklist"]["name"] == "OPD standard"
    assert any("never scanned" in note for note in result.findings_json["notes"])
    assert completeness_service.summarise(result)["label"] == "Complete against the attached checklist"


def test_an_optional_document_type_does_not_make_a_case_incomplete(db, storage, batch, case):
    checklist = make_checklist(db, "OPD standard", [("discharge_summary", 1, True),
                                                    ("physiotherapy_note", 1, False)])
    case.checklist_id = checklist.id
    db.add(case)
    db.commit()

    make_page_version(db, storage, batch=batch, case=case, filename="discharge_summary.pdf",
                      ordinal=1, image=distinct_page(1))

    assert completeness_service.compute(db, case).status == STATUS_VERIFIED


def test_recomputing_updates_the_existing_row_rather_than_adding_one(db, storage, batch, case):
    from app.models import CompletenessResult

    make_page_version(db, storage, batch=batch, case=case, filename="a.pdf", ordinal=1,
                      image=distinct_page(1))
    first = completeness_service.compute(db, case)
    db.commit()
    second = completeness_service.compute(db, case)
    db.commit()

    assert first.id == second.id
    assert db.query(CompletenessResult).count() == 1
