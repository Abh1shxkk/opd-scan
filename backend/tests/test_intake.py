"""Patient intake — one screen, one submit.

Covers the behaviours that would be quietly wrong rather than loudly broken: reusing an admission
instead of duplicating it, refusing a date it cannot read, and never blanking a colleague's entry
on a later partial submit.
"""

from __future__ import annotations

import io

from tests.conftest import make_pdf_bytes


def _form(**overrides) -> dict:
    form = {"mr_number": "MR-1001", "ipd_number": "IPD-55", "patient_name": "A Patient"}
    form.update(overrides)
    return form


def _pdf(name: str = "record.pdf", data: bytes | None = None) -> dict:
    # A fresh PDF each call unless the caller pins the bytes: pymupdf stamps a creation timestamp,
    # so two generated files are never byte-identical and would never look like duplicates.
    return {"files": (name, io.BytesIO(data if data is not None else make_pdf_bytes(pages=1)),
                      "application/pdf")}


def test_intake_records_the_form_and_accepts_the_file(client, auth):
    response = client.post("/api/intake", headers=auth["uploader"],
                           data=_form(department="ENT", disease="Otitis media", icd_code="H66",
                                      consultant_name="Dr S", mobile="9876543210",
                                      admission_date="2026-01-05", discharge_date="2026-01-09"),
                           files=_pdf())
    assert response.status_code == 200
    body = response.json()

    case = body["case"]
    assert case["patient_ref"] == "MR-1001"
    assert case["encounter_ref"] == "IPD-55"
    assert case["department"] == "ENT"
    assert case["icd_code"] == "H66"
    assert case["admission_date"] == "2026-01-05"
    assert case["discharge_date"] == "2026-01-09"

    assert len(body["documents"]) == 1
    assert body["documents"][0]["status"] == "accepted"


def test_an_mr_number_is_required_and_never_inferred(client, auth):
    response = client.post("/api/intake", headers=auth["uploader"],
                           data=_form(mr_number="   "), files=_pdf())
    assert response.status_code == 422
    assert "MR number is required" in response.json()["detail"]


def test_second_upload_for_the_same_ipd_reuses_the_admission(client, auth):
    first = client.post("/api/intake", headers=auth["uploader"], data=_form(), files=_pdf("a.pdf"))
    second = client.post("/api/intake", headers=auth["uploader"], data=_form(), files=_pdf("b.pdf"))

    assert first.json()["case"]["id"] == second.json()["case"]["id"]
    # Both files hang off the one admission rather than creating a second record for it.
    assert second.json()["case"]["document_count"] == 2


def test_a_later_partial_submit_does_not_blank_existing_details(client, auth):
    client.post("/api/intake", headers=auth["uploader"],
                data=_form(department="ENT", consultant_name="Dr S"), files=_pdf("a.pdf"))

    # Someone adds another file without re-typing the clinical details.
    second = client.post("/api/intake", headers=auth["uploader"],
                         data=_form(department="", consultant_name=""), files=_pdf("b.pdf"))

    case = second.json()["case"]
    assert case["department"] == "ENT"
    assert case["consultant_name"] == "Dr S"


def test_an_unreadable_date_is_refused_rather_than_guessed(client, auth):
    response = client.post("/api/intake", headers=auth["uploader"],
                           data=_form(admission_date="05-01-2026"), files=_pdf())
    assert response.status_code == 422
    assert "date of admission" in response.json()["detail"]


def test_discharge_before_admission_is_refused(client, auth):
    response = client.post("/api/intake", headers=auth["uploader"],
                           data=_form(admission_date="2026-01-09", discharge_date="2026-01-05"),
                           files=_pdf())
    assert response.status_code == 422
    assert "before the admission date" in response.json()["detail"]


def test_blank_ipd_falls_back_to_the_mr_number(client, auth):
    """An OPD visit has no admission number; the case still has to be addressable."""
    response = client.post("/api/intake", headers=auth["uploader"],
                           data=_form(ipd_number=""), files=_pdf())
    assert response.json()["case"]["encounter_ref"] == "MR-1001"


def test_the_same_file_twice_is_reported_as_duplicate_not_stored_again(client, auth):
    same_bytes = make_pdf_bytes(pages=1)
    client.post("/api/intake", headers=auth["uploader"], data=_form(),
                files=_pdf("same.pdf", same_bytes))
    second = client.post("/api/intake", headers=auth["uploader"], data=_form(),
                         files=_pdf("same.pdf", same_bytes))

    assert second.json()["documents"][0]["status"] == "duplicate"
    assert second.json()["case"]["document_count"] == 1


def test_lookup_prefills_from_the_last_visit_and_is_honest_when_unknown(client, auth):
    client.post("/api/intake", headers=auth["uploader"],
                data=_form(patient_name="R Kumar", mobile="9876543210"), files=_pdf())

    hit = client.get("/api/intake/lookup?mr_number=MR-1001", headers=auth["uploader"]).json()
    assert hit["found"] is True
    assert hit["case"]["patient_name"] == "R Kumar"
    assert hit["case"]["mobile"] == "9876543210"

    miss = client.get("/api/intake/lookup?mr_number=MR-NOPE", headers=auth["uploader"]).json()
    assert miss["found"] is False
    assert miss["case"] is None


def test_intake_requires_the_uploader_role(client, auth):
    response = client.post("/api/intake", headers=auth["reviewer"], data=_form(), files=_pdf())
    assert response.status_code == 403


def test_options_are_served_for_the_dropdowns(client, auth):
    body = client.get("/api/intake/options", headers=auth["uploader"]).json()
    assert body["departments"] and body["discharge_types"] and body["mlc_types"]
    # "Not MLC" has to be selectable: most records are not medico-legal, and leaving the field
    # blank would make "not applicable" indistinguishable from "nobody filled this in".
    assert "Not MLC" in body["mlc_types"]
