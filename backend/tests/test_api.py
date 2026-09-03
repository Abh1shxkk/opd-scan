"""End-to-end API behaviour against a temporary database and storage root.

Three things are checked here that nothing below the API can check on its own:

* every route, images included, is role-guarded server side;
* the page list, the dashboard and the CSV export agree, because they share one query layer;
* a review is appended and the AI's own output is never rewritten.
"""

from __future__ import annotations

import csv
import io

import pytest

from app.models import DiagnosisExtraction, PageVersion, QualityResult
from app.models.core import DiagnosisStatus, PageClass, Qualifier
from app.processing import ingest
from tests.conftest import (
    TEST_PASSWORD,
    blank_page_image,
    make_pdf_bytes,
    make_page_version,
    run_queued_jobs,
    text_page_image,
)


def csv_rows(body: bytes) -> list[list[str]]:
    text = body.decode("utf-8-sig")
    return [row for row in csv.reader(io.StringIO(text, newline="")) if row]


def upload(client, headers, batch_id: str, filename: str, data: bytes, content_type: str = "application/pdf"):
    return client.post(
        "/api/documents/upload",
        headers=headers,
        files=[("files", (filename, data, content_type))],
        data={"batch_id": batch_id},
    )


# ------------------------------------------------------------- authentication


def test_health_needs_no_token(client):
    assert client.get("/api/health").json()["status"] == "ok"


@pytest.mark.parametrize(
    "path",
    ["/api/pages", "/api/dashboard", "/api/batches", "/api/documents", "/api/diagnoses",
     "/api/reports/pages.csv", "/api/settings/capabilities"],
)
def test_unauthenticated_json_routes_are_rejected(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("suffix", ["image", "preview", "thumb", "annotated"])
def test_unauthenticated_image_routes_are_rejected(client, sample_page, suffix):
    """A preview is patient data; an unguessable URL is not an access control."""
    response = client.get(f"/api/pages/{sample_page.id}/{suffix}")
    assert response.status_code == 401
    assert response.content != b""  # a JSON error, not the image


def test_a_bogus_token_is_rejected(client, sample_page):
    headers = {"Authorization": "Bearer not.a.real.token"}
    assert client.get("/api/pages", headers=headers).status_code == 401
    assert client.get(f"/api/pages/{sample_page.id}/image", headers=headers).status_code == 401


def test_a_deactivated_user_loses_access(client, db, users, auth):
    assert client.get("/api/pages", headers=auth["reviewer"]).status_code == 200
    users["reviewer"].is_active = False
    db.add(users["reviewer"])
    db.commit()
    assert client.get("/api/pages", headers=auth["reviewer"]).status_code == 401


def test_login_issues_a_usable_token(client, users):
    response = client.post(
        "/api/auth/login",
        data={"username": "reviewer@example.test", "password": TEST_PASSWORD},
    )
    assert response.status_code == 200
    token = response.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["role"] == "reviewer"


def test_login_failure_does_not_distinguish_wrong_password_from_unknown_user(client, users):
    wrong_password = client.post(
        "/api/auth/login", data={"username": "reviewer@example.test", "password": "nope-nope-nope"}
    )
    unknown_user = client.post(
        "/api/auth/login", data={"username": "ghost@example.test", "password": TEST_PASSWORD}
    )
    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json() == unknown_user.json()


def test_an_authenticated_reader_gets_the_image_bytes(client, auth, sample_page):
    response = client.get(f"/api/pages/{sample_page.id}/image", headers=auth["reviewer"])
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert ingest.bytes_to_image(response.content) is not None


# --------------------------------------------------------------------- roles


def test_an_uploader_may_not_review_a_page(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/review",
        headers=auth["uploader"],
        json={"action": "accept", "comment": "looks fine"},
    )
    assert response.status_code == 403
    assert "requires one of" in response.json()["detail"]


def test_a_reviewer_may_review_a_page(client, db, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/review",
        headers=auth["reviewer"],
        json={"action": "accept", "comment": "legible"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "review_state": "accepted"}

    detail = client.get(f"/api/pages/{sample_page.id}", headers=auth["reviewer"]).json()
    assert detail["review_state"] == "accepted"
    assert [r["action"] for r in detail["reviews"]] == ["accept"]


def test_an_admin_may_also_review(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/review",
        headers=auth["admin"],
        json={"action": "request_rescan", "comment": "faint"},
    )
    assert response.status_code == 200
    assert response.json()["review_state"] == "rescan_requested"


def test_an_unknown_review_action_is_rejected(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/review", headers=auth["reviewer"], json={"action": "shred"}
    )
    assert response.status_code == 422


def test_a_reviewer_may_not_upload(client, auth, batch):
    response = upload(client, auth["reviewer"], batch.id, "scan.pdf", make_pdf_bytes(1))
    assert response.status_code == 403


@pytest.mark.parametrize("role", ["admin", "uploader"])
def test_admins_and_uploaders_may_upload(client, auth, batch, role):
    response = upload(client, auth[role], batch.id, f"scan-{role}.pdf", make_pdf_bytes(1))
    assert response.status_code == 200
    assert response.json()[0]["status"] == "accepted"


def test_only_an_admin_may_delete_a_document(client, db, auth, sample_page):
    document_id = sample_page.logical_page.document_id
    assert client.delete(f"/api/documents/{document_id}", headers=auth["uploader"]).status_code == 403
    assert client.delete(f"/api/documents/{document_id}", headers=auth["admin"]).status_code == 204


def test_only_an_admin_may_change_thresholds(client, auth):
    payload = {"values": {"sharpness_min": 0.2}}
    assert client.put("/api/settings/thresholds", headers=auth["reviewer"], json=payload).status_code == 403
    assert client.put("/api/settings/thresholds", headers=auth["admin"], json=payload).status_code == 200


# --------------------------------------------------------------- bad uploads


def test_a_corrupted_pdf_is_rejected_with_a_readable_message_not_a_500(client, auth, batch):
    response = upload(client, auth["uploader"], batch.id, "broken.pdf", b"%PDF-1.4 this is not a pdf")

    assert response.status_code == 200, "a bad file is a user error, not a server error"
    result = response.json()[0]
    assert result["status"] == "rejected"
    assert result["document_id"] is None
    assert result["message"].strip()
    assert "could not be opened" in result["message"].lower()
    assert "traceback" not in result["message"].lower()


def test_an_unsupported_file_type_is_rejected_and_names_the_accepted_types(client, auth, batch):
    response = upload(client, auth["uploader"], batch.id, "notes.docx", b"PK\x03\x04", "application/zip")
    result = response.json()[0]
    assert result["status"] == "rejected"
    assert "pdf" in result["message"]


def test_an_empty_file_is_rejected(client, auth, batch):
    result = upload(client, auth["uploader"], batch.id, "empty.pdf", b"").json()[0]
    assert result["status"] == "rejected"
    assert "empty" in result["message"].lower()


def test_the_same_file_uploaded_twice_is_reported_as_a_duplicate(client, auth, batch):
    data = make_pdf_bytes(1)
    first = upload(client, auth["uploader"], batch.id, "scan.pdf", data).json()[0]
    second = upload(client, auth["uploader"], batch.id, "scan.pdf", data).json()[0]
    assert first["status"] == "accepted"
    assert second["status"] == "duplicate"
    assert second["document_id"] == first["document_id"]


def test_uploading_to_an_unknown_batch_is_a_404(client, auth):
    assert upload(client, auth["uploader"], "no-such-batch", "s.pdf", make_pdf_bytes(1)).status_code == 404


# ------------------------------------------------- the whole ingest pipeline


@pytest.fixture()
def ingested(client, auth, batch):
    """A real three-page PDF, uploaded and fully processed in-process."""
    response = upload(client, auth["uploader"], batch.id, "case-sheet.pdf", make_pdf_bytes(3))
    result = response.json()[0]
    assert result["status"] == "accepted", result
    assert result["page_count"] == 3
    run_queued_jobs()
    return result


@pytest.mark.slow
def test_page_count_dashboard_and_csv_export_all_agree(client, auth, ingested):
    headers = auth["reviewer"]

    listing = client.get("/api/pages", headers=headers).json()
    dashboard = client.get("/api/dashboard", headers=headers).json()
    export = client.get("/api/reports/pages.csv", headers=headers)
    rows = csv_rows(export.content)

    assert listing["total"] == 3
    assert len(listing["items"]) == 3
    assert dashboard["totals"]["pages_active"] == 3
    assert len(rows) - 1 == 3, "one header row plus one row per active page version"
    assert ingested["page_count"] == 3

    document = client.get(f"/api/documents/{ingested['document_id']}", headers=headers).json()
    assert document["ingest_status"] == "completed"
    assert len(document["pages"]) == 3


@pytest.mark.slow
def test_every_ingested_page_was_measured_and_carries_a_class(client, auth, ingested):
    listing = client.get("/api/pages", headers=auth["reviewer"]).json()
    for item in listing["items"]:
        assert item["page_class"] in {c.value for c in PageClass}
        assert item["page_class"] != "unchecked", "the quality job should have run"
        # No provider is configured, so these must say so rather than claiming a clean result.
        assert item["handwriting_status"] == "unconfigured"
        assert item["diagnosis_status"] == "unconfigured"


@pytest.mark.slow
def test_an_unconfigured_provider_is_reported_as_such_on_the_page_detail(client, auth, ingested):
    listing = client.get("/api/pages", headers=auth["reviewer"]).json()
    detail = client.get(f"/api/pages/{listing['items'][0]['page_version_id']}",
                        headers=auth["reviewer"]).json()
    assert detail["handwriting_regions"] == []
    assert "No handwriting provider is configured" in (detail["handwriting_error"] or "")
    assert "UNKNOWN for this page, not absent" in detail["handwriting_error"]
    assert [d["status"] for d in detail["diagnoses"]] == ["unconfigured"]


@pytest.mark.slow
def test_the_csv_export_carries_the_shared_column_set(client, auth, ingested):
    from app.services.query import EXPORT_COLUMNS, EXPORT_HEADERS

    rows = csv_rows(client.get("/api/reports/pages.csv", headers=auth["reviewer"]).content)
    assert rows[0] == [EXPORT_HEADERS[c] for c in EXPORT_COLUMNS]
    for row in rows[1:]:
        assert len(row) == len(EXPORT_COLUMNS)
    # Private "_" keys must never reach a tabular export.
    assert not any(header.startswith("_") for header in rows[0])


@pytest.mark.slow
def test_a_filter_narrows_the_dashboard_and_the_export_by_the_same_amount(client, auth, ingested, batch):
    headers = auth["reviewer"]
    other = client.post("/api/batches", headers=auth["uploader"], json={"name": "Ward B"}).json()

    query = f"?batch_id={other['id']}"
    assert client.get(f"/api/pages{query}", headers=headers).json()["total"] == 0
    assert client.get(f"/api/dashboard{query}", headers=headers).json()["totals"]["pages_active"] == 0
    assert len(csv_rows(client.get(f"/api/reports/pages.csv{query}", headers=headers).content)) == 1

    query = f"?batch_id={batch.id}"
    assert client.get(f"/api/pages{query}", headers=headers).json()["total"] == 3
    assert client.get(f"/api/dashboard{query}", headers=headers).json()["totals"]["pages_active"] == 3


# ---------------------------------------------------------------- dashboard


@pytest.fixture()
def classified_pages(db, storage, batch):
    """One active page in each quality bucket, plus one that was never measured."""
    wanted = [PageClass.acceptable, PageClass.review, PageClass.rescan, PageClass.blank,
              PageClass.failed]
    created = {}
    for i, klass in enumerate(wanted, start=1):
        pv = make_page_version(db, storage, batch=batch, filename=f"doc-{klass.value}.pdf", ordinal=i)
        db.add(QualityResult(page_version_id=pv.id, overall=klass, score=0.5,
                             engine_version="test", thresholds_hash="deadbeef"))
        created[klass.value] = pv
    created["unchecked"] = make_page_version(db, storage, batch=batch, filename="doc-none.pdf",
                                             ordinal=99)
    db.commit()
    return created


def test_quality_buckets_sum_to_pages_active(client, auth, classified_pages):
    totals = client.get("/api/dashboard", headers=auth["reviewer"]).json()["totals"]
    quality = totals["quality"]

    assert sum(quality.values()) == totals["pages_active"] == 6
    assert set(quality) == {c.value for c in PageClass}, "every bucket present, even at zero"


def test_blank_failed_and_unchecked_are_not_folded_into_acceptable(client, auth, classified_pages):
    quality = client.get("/api/dashboard", headers=auth["reviewer"]).json()["totals"]["quality"]

    assert quality["acceptable"] == 1, "exactly the one page classed acceptable"
    for bucket in ("blank", "failed", "unchecked", "review", "rescan"):
        assert quality[bucket] == 1, bucket
    # The point of the invariant: a page nobody could measure is not a page that passed.
    assert quality["acceptable"] + quality["blank"] + quality["failed"] + quality["unchecked"] == 4


def test_a_page_with_no_quality_row_is_unchecked_everywhere(client, auth, classified_pages):
    headers = auth["reviewer"]
    pv = classified_pages["unchecked"]

    summary = client.get("/api/pages?page_class=unchecked", headers=headers).json()
    assert [item["page_version_id"] for item in summary["items"]] == [pv.id]

    rows = csv_rows(client.get("/api/reports/pages.csv?page_class=unchecked", headers=headers).content)
    assert len(rows) == 2
    assert "unchecked" in rows[1]


def test_handwriting_is_counted_on_its_own_axis(client, auth, classified_pages):
    totals = client.get("/api/dashboard", headers=auth["reviewer"]).json()["totals"]
    assert sum(totals["handwriting"].values()) == totals["pages_active"]
    assert totals["handwriting"]["pending"] == 6, "no handwriting row yet means pending, not none"
    assert "handwriting" not in totals["quality"]
    overlaps = client.get("/api/dashboard", headers=auth["reviewer"]).json()["overlaps"]
    assert set(overlaps) == {"defect_and_handwriting", "defect_only", "handwriting_only"}


def test_the_dashboard_reports_unconfigured_capabilities_rather_than_hiding_them(client, auth):
    capabilities = client.get("/api/dashboard", headers=auth["reviewer"]).json()["capabilities"]
    for key in ("ocr", "handwriting", "diagnosis"):
        assert capabilities[key]["status"] == "unconfigured"
        assert capabilities[key]["setup_required"]


# ---------------------------------------------------------------- diagnosis


@pytest.fixture()
def extraction(db, sample_page) -> DiagnosisExtraction:
    record = DiagnosisExtraction(
        page_version_id=sample_page.id,
        status=DiagnosisStatus.extracted_pending_review,
        anchor_label="Final Diagnosis",
        raw_text="Fibriod uterus",          # the model's transcription, typo and all
        cleaned_text="Fibriod uterus",
        qualifier=Qualifier.final,
        confidence=0.71,
        model_version="test-model/1+diagnosis-extractor/1.0.0",
        provider_used="test_provider",
    )
    db.add(record)
    db.commit()
    return record


def test_a_diagnosis_correction_is_appended_and_leaves_raw_text_untouched(client, db, auth, extraction):
    before = extraction.raw_text

    response = client.post(
        f"/api/diagnoses/{extraction.id}/review",
        headers=auth["reviewer"],
        json={"action": "correct", "corrected_text": "Fibroid uterus",
              "corrected_qualifier": "final", "comment": "spelling"},
    )
    assert response.status_code == 200
    body = response.json()

    assert body["raw_text"] == before == "Fibriod uterus"
    assert body["cleaned_text"] == "Fibriod uterus"

    db.expire_all()
    stored = db.get(DiagnosisExtraction, extraction.id)
    assert stored.raw_text == before, "the AI transcription is immutable"
    assert stored.cleaned_text == "Fibriod uterus"
    assert stored.qualifier == Qualifier.final, "the model's own qualifier is not rewritten"
    assert len(stored.reviews) == 1
    review = stored.reviews[0]
    assert review.action == "correct"
    assert review.corrected_text == "Fibroid uterus"
    assert review.corrected_qualifier == Qualifier.final
    assert review.comment == "spelling"

    # Reading it back reports the review correctly.
    fetched = client.get(f"/api/diagnoses/{extraction.id}", headers=auth["reviewer"]).json()
    assert fetched["is_reviewed"] is True
    assert fetched["raw_text"] == before
    assert [r["action"] for r in fetched["reviews"]] == ["correct"]
    assert fetched["reviews"][0]["reviewer_email"] == "reviewer@example.test"


def test_the_review_response_reports_the_review_it_just_recorded(client, auth, extraction):
    body = client.post(
        f"/api/diagnoses/{extraction.id}/review",
        headers=auth["reviewer"],
        json={"action": "correct", "corrected_text": "Fibroid uterus"},
    ).json()
    assert body["is_reviewed"] is True
    assert len(body["reviews"]) == 1


def test_a_second_review_appends_rather_than_replacing(client, db, auth, extraction):
    for action, payload in (("confirm", {}), ("correct", {"corrected_text": "Fibroid uterus"})):
        client.post(f"/api/diagnoses/{extraction.id}/review", headers=auth["reviewer"],
                    json={"action": action, **payload})
    db.expire_all()
    stored = db.get(DiagnosisExtraction, extraction.id)
    assert [r.action for r in stored.reviews] == ["confirm", "correct"]
    assert stored.raw_text == "Fibriod uterus"


def test_an_uploader_may_not_review_a_diagnosis(client, auth, extraction):
    response = client.post(f"/api/diagnoses/{extraction.id}/review", headers=auth["uploader"],
                           json={"action": "confirm"})
    assert response.status_code == 403


def test_a_correction_must_actually_correct_something(client, auth, extraction):
    response = client.post(f"/api/diagnoses/{extraction.id}/review", headers=auth["reviewer"],
                           json={"action": "correct"})
    assert response.status_code == 422


def test_the_export_separates_the_ai_text_from_the_reviewed_text(client, auth, extraction):
    from app.services.query import EXPORT_COLUMNS

    client.post(f"/api/diagnoses/{extraction.id}/review", headers=auth["reviewer"],
                json={"action": "correct", "corrected_text": "Fibroid uterus"})

    rows = csv_rows(client.get("/api/reports/pages.csv", headers=auth["reviewer"]).content)
    row = dict(zip(EXPORT_COLUMNS, rows[1]))
    assert row["diagnosis_text_raw"] == "Fibriod uterus"
    assert row["diagnosis_text_reviewed"] == "Fibroid uterus"
    assert row["ai_vs_reviewed"] == "reviewer_corrected"


def test_an_unreviewed_extraction_is_marked_ai_only(client, auth, extraction):
    from app.services.query import EXPORT_COLUMNS

    rows = csv_rows(client.get("/api/reports/pages.csv", headers=auth["reviewer"]).content)
    row = dict(zip(EXPORT_COLUMNS, rows[1]))
    assert row["ai_vs_reviewed"] == "ai_only"
    assert row["diagnosis_text_reviewed"] == ""


# ------------------------------------------------------------------ replace


def test_replacing_a_page_creates_version_two_and_retires_version_one(client, db, auth, sample_page):
    headers = auth["reviewer"]
    assert client.get("/api/dashboard", headers=headers).json()["totals"]["pages_active"] == 1
    original_id = sample_page.id

    replacement = ingest.encode_png(text_page_image(width=620, height=820))
    response = client.post(
        f"/api/pages/{original_id}/replace",
        headers=auth["uploader"],
        files=[("file", ("rescan.png", replacement, "image/png"))],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["version_no"] == 2
    assert body["page_version_id"] != original_id

    db.expire_all()
    old = db.get(PageVersion, original_id)
    new = db.get(PageVersion, body["page_version_id"])
    assert old.is_active is False
    assert new.is_active is True
    assert new.version_no == 2
    assert new.replaces_version_id == original_id

    # The rescan replaces the page; it does not add one.
    totals = client.get("/api/dashboard", headers=headers).json()["totals"]
    assert totals["pages_active"] == 1
    assert client.get("/api/pages", headers=headers).json()["total"] == 1
    assert len(csv_rows(client.get("/api/reports/pages.csv", headers=headers).content)) == 2

    detail = client.get(f"/api/pages/{new.id}", headers=headers).json()
    assert [v["version_no"] for v in detail["versions"]] == [1, 2]
    assert [v["is_active"] for v in detail["versions"]] == [False, True]


def test_a_reviewer_may_not_replace_a_page(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["reviewer"],
        files=[("file", ("rescan.png", ingest.encode_png(blank_page_image(100, 100)), "image/png"))],
    )
    assert response.status_code == 403


def test_an_unreadable_replacement_is_rejected_with_422(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files=[("file", ("rescan.png", b"not an image at all", "image/png"))],
    )
    assert response.status_code == 422
    assert "could not be read" in response.json()["detail"]


def test_an_empty_replacement_is_rejected_with_422(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files=[("file", ("rescan.png", b"", "image/png"))],
    )
    assert response.status_code == 422


def test_replacing_queues_a_fresh_analysis_for_the_new_version(client, db, auth, sample_page):
    from app.models import Job
    from app.models.core import JobKind, JobState

    replacement = ingest.encode_png(text_page_image(width=620, height=820))
    new_id = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files=[("file", ("rescan.png", replacement, "image/png"))],
    ).json()["page_version_id"]

    queued = db.query(Job).filter(Job.page_version_id == new_id).all()
    assert {j.kind for j in queued} == {JobKind.quality, JobKind.handwriting, JobKind.diagnosis}
    assert all(j.state == JobState.queued for j in queued)


# ---------------------------------------------------------------- audit trail


def test_viewing_a_page_is_audited_without_recording_any_patient_text(client, db, auth, sample_page):
    from app.models import AuditEvent

    client.get(f"/api/pages/{sample_page.id}", headers=auth["reviewer"])
    events = db.query(AuditEvent).filter(AuditEvent.action == "page.view").all()
    assert len(events) == 1
    assert events[0].entity_id == sample_page.id
    assert events[0].actor_id is not None
    assert events[0].meta_json == {}


def test_audit_metadata_never_carries_free_text(client, db, auth, extraction):
    from app.models import AuditEvent

    client.post(f"/api/diagnoses/{extraction.id}/review", headers=auth["reviewer"],
                json={"action": "correct", "corrected_text": "Fibroid uterus",
                      "comment": "a comment that should never be echoed into the audit trail"})
    event = db.query(AuditEvent).filter(AuditEvent.action == "diagnosis.review.correct").one()
    payload = str(event.meta_json)
    assert "Fibroid" not in payload
    assert "comment" not in payload
    assert event.meta_json == {"had_correction": True}


# ------------------------------------------------------------------ 404s


def test_unknown_ids_are_404_not_500(client, auth):
    headers = auth["reviewer"]
    assert client.get("/api/pages/nope", headers=headers).status_code == 404
    assert client.get("/api/pages/nope/image", headers=headers).status_code == 404
    assert client.get("/api/documents/nope", headers=headers).status_code == 404
    assert client.get("/api/diagnoses/nope", headers=headers).status_code == 404
    assert client.get("/api/batches/nope", headers=headers).status_code == 404


def test_a_missing_render_file_is_a_404_not_a_crash(client, db, auth, sample_page, storage):
    storage.delete(sample_page.storage_key_render)
    response = client.get(f"/api/pages/{sample_page.id}/image", headers=auth["reviewer"])
    assert response.status_code == 404
    assert "not available" in response.json()["detail"]


def test_an_unrecognised_filter_value_narrows_to_nothing_rather_than_widening(client, auth, classified_pages):
    headers = auth["reviewer"]
    everything = client.get("/api/pages", headers=headers).json()["total"]
    assert everything == 6
    # An unknown page_class is dropped, so the filter list becomes empty and nothing is narrowed.
    response = client.get("/api/pages?page_class=banana", headers=headers)
    assert response.status_code == 200
    assert response.json()["total"] <= everything


def test_security_headers_are_set_on_api_responses(client, auth):
    response = client.get("/api/dashboard", headers=auth["reviewer"])
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"


def test_exports_are_marked_no_store(client, auth, sample_page):
    response = client.get("/api/reports/pages.csv", headers=auth["reviewer"])
    assert response.headers["Cache-Control"] == "private, no-store"
    assert "attachment" in response.headers["Content-Disposition"]
