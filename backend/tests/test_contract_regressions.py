"""Guards for response fields the frontend renders but the backend once forgot to send.

This project's recurring failure is not a crash — it is a field the API quietly omits, which the
UI then draws as "—" or as nothing at all. TypeScript cannot see it (responses are cast, not
validated) and a status-code assertion will not catch it either. These tests pin the shapes that
have actually broken, so the next omission fails here instead of in a ward.
"""

from __future__ import annotations

from tests.conftest import make_page_version


def _page_detail(client, auth, page_id: str) -> dict:
    response = client.get(f"/api/pages/{page_id}", headers=auth["reviewer"])
    assert response.status_code == 200
    return response.json()


def test_version_history_carries_capture_details_not_just_ids(client, auth, sample_page):
    """The version list exists so a reviewer can see whether a rescan improved anything.

    Without these fields every row renders "— · —" and answers nothing, which is exactly how this
    shipped: the frontend read four fields the schema never had.
    """
    versions = _page_detail(client, auth, sample_page.id)["versions"]
    assert versions, "a page should always list at least its own version"

    v = versions[0]
    for field in ("colour_mode", "capture_profile", "dpi_estimate", "page_class"):
        assert field in v, f"PageVersionRef is missing {field!r}"

    # colour_mode is always known at ingest; the others may legitimately be null on a page that was
    # never measured, and null must stay distinguishable from a value.
    assert v["colour_mode"] is not None


def test_page_viewer_and_review_queue_show_the_same_diagnosis_safety_context(
    client, auth, db, storage, batch, users
):
    """One extraction, two screens, one answer.

    The page viewer used to build its own DiagnosisOut without the safety fields, so an
    abbreviation the extractor deliberately refused to expand was flagged in the review queue and
    silently absent in the viewer — the screen a reviewer is more likely to be reading.
    """
    from app.models import DiagnosisExtraction
    from app.models.core import DiagnosisStatus, Qualifier

    pv = make_page_version(db, storage, batch=batch, filename="dx.pdf")
    db.add(
        DiagnosisExtraction(
            page_version_id=pv.id,
            status=DiagnosisStatus.extracted_pending_review,
            anchor_label="Final Diagnosis",
            raw_text="c/o SOB, ? CCF",
            cleaned_text="c/o SOB, ? CCF",
            qualifier=Qualifier.suspected,
            region_json={
                "x": 10, "y": 20, "w": 100, "h": 30,
                "note": "Two readings were possible; neither was chosen.",
                "cleaning_applied": ["collapsed whitespace"],
                "ambiguous_abbreviations": ["SOB", "CCF"],
            },
        )
    )
    db.commit()

    from_viewer = _page_detail(client, auth, pv.id)["diagnoses"][0]
    from_queue = client.get(
        f"/api/diagnoses/{from_viewer['id']}", headers=auth["reviewer"]
    ).json()

    for field in ("note", "cleaning_applied", "ambiguous_abbreviations"):
        assert from_viewer[field] == from_queue[field], f"{field} differs between the two screens"

    assert from_viewer["ambiguous_abbreviations"] == ["SOB", "CCF"]
    # The geometry stays geometry: the safety keys must not leak back into the region box, or the
    # overlay would try to draw them.
    assert set(from_viewer["region"]) == {"x", "y", "w", "h"}


def test_replace_returns_the_new_version_identity_only(client, auth, sample_page):
    """`POST /pages/{id}/replace` returns {page_version_id, version_no} — not a PageDetail.

    The client was typed as receiving a full PageDetail, which would have read `undefined` for
    every field the moment anything called it. Nothing did, which is the only reason it never
    surfaced.
    """
    from tests.conftest import text_page_image

    import cv2

    ok, buf = cv2.imencode(".png", text_page_image(width=400, height=500))
    assert ok

    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("rescan.png", buf.tobytes(), "image/png")},
    )
    assert response.status_code == 200

    body = response.json()
    assert set(body) == {"page_version_id", "version_no"}
    assert body["version_no"] == 2
    assert body["page_version_id"] != sample_page.id


def test_a_correction_is_visible_wherever_the_diagnosis_is_shown(
    client, auth, db, storage, batch, users
):
    """A correction nobody can see is worse than no correction — it looks like nobody checked.

    The correction was recorded and surfaced in report exports and on its own review screen, while
    the page viewer and the diagnosis queue kept rendering the model's original reading. Anyone
    reading the case in the app had no way to know a correction existed.
    """
    from app.models import DiagnosisExtraction
    from app.models.core import DiagnosisStatus, Qualifier

    pv = make_page_version(db, storage, batch=batch, filename="dx2.pdf")
    extraction = DiagnosisExtraction(
        page_version_id=pv.id,
        status=DiagnosisStatus.extracted_pending_review,
        anchor_label="Final Diagnosis",
        raw_text="Acute gastritis",
        cleaned_text="Acute gastritis",
        qualifier=Qualifier.unspecified,
    )
    db.add(extraction)
    db.commit()

    before = _page_detail(client, auth, pv.id)["diagnoses"][0]
    assert before["corrected_text"] is None, "nothing is corrected until someone corrects it"

    response = client.post(
        f"/api/diagnoses/{extraction.id}/review",
        headers=auth["reviewer"],
        json={
            "action": "correct",
            "corrected_text": "Acute gastroenteritis",
            "corrected_qualifier": "final",
            "comment": "misread on the form",
        },
    )
    assert response.status_code == 200

    after = _page_detail(client, auth, pv.id)["diagnoses"][0]
    assert after["corrected_text"] == "Acute gastroenteritis"
    assert after["corrected_qualifier"] == "final"
    assert after["corrected_by_name"], "a reviewer's name, never a bare UUID"
    assert after["corrected_at"]

    # The model's own output is kept intact alongside it — appending, not overwriting, is the
    # whole reason corrections are stored as separate rows.
    assert after["raw_text"] == "Acute gastritis"

    # And the queue agrees with the viewer.
    listed = client.get("/api/diagnoses", headers=auth["reviewer"]).json()["items"]
    row = next(d for d in listed if d["id"] == extraction.id)
    assert row["corrected_text"] == "Acute gastroenteritis"


def test_a_page_review_entry_carries_everything_the_frontend_declares(client, auth, sample_page):
    """PageReviewEntry declares page_version_id and payload; neither was ever sent.

    payload is the only record of what a correct_finding review actually changed, so omitting it
    made that undiscoverable from the page itself.
    """
    client.post(
        f"/api/pages/{sample_page.id}/review",
        headers=auth["reviewer"],
        json={
            "action": "correct_finding",
            "comment": "the shadow is the binding, not a capture fault",
            "payload": {"finding_id": "x", "defect_code": "shadow", "verdict": "not_a_defect"},
        },
    )

    review = _page_detail(client, auth, sample_page.id)["reviews"][-1]
    for field in ("id", "action", "comment", "reviewer_id", "reviewer_name", "page_version_id",
                  "payload", "created_at"):
        assert field in review, f"PageReviewEntry is missing {field!r}"

    assert review["page_version_id"] == sample_page.id
    assert review["payload"]["defect_code"] == "shadow"
    assert review["reviewer_name"], "a name, never a bare UUID"
