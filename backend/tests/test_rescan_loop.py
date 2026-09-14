"""The rescan loop: request → rescan → replace → the page leaves the queue.

Version supersession itself is covered in test_api.py. What is pinned here is the loop a reviewer
actually walks, which previously could be started but never finished: the request had no screen and
the replace endpoint had no caller. These tests hold the two ends together, plus the PDF path — a
ward scanner asked to redo one sheet emits a PDF, and requiring a conversion first is how a rescan
workflow quietly stops being used.
"""

from __future__ import annotations

from app.processing import ingest
from tests.conftest import make_pdf_bytes, text_page_image


def _request_rescan(client, auth, page_id: str) -> None:
    response = client.post(
        f"/api/pages/{page_id}/review",
        headers=auth["reviewer"],
        json={"action": "request_rescan", "comment": "bottom third is cut off"},
    )
    assert response.status_code == 200
    assert response.json()["review_state"] == "rescan_requested"


def _awaiting_rescan(client, auth) -> list[dict]:
    response = client.get("/api/pages?review_state=rescan_requested", headers=auth["reviewer"])
    assert response.status_code == 200
    return response.json()["items"]


def test_a_requested_page_appears_in_the_rescan_list_and_leaves_once_replaced(
    client, auth, sample_page
):
    """The whole loop. This is what could not be completed before the screen existed."""
    assert _awaiting_rescan(client, auth) == []

    _request_rescan(client, auth, sample_page.id)
    waiting = _awaiting_rescan(client, auth)
    assert [p["page_version_id"] for p in waiting] == [sample_page.id]

    replacement = ingest.encode_png(text_page_image(width=620, height=820))
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("rescan.png", replacement, "image/png")},
    )
    assert response.status_code == 200

    # The request was against the old version, which is no longer active. The replacement starts
    # its own review from scratch — it has not been accepted or rejected by anyone yet.
    assert _awaiting_rescan(client, auth) == []

    new_id = response.json()["page_version_id"]
    detail = client.get(f"/api/pages/{new_id}", headers=auth["reviewer"]).json()
    assert detail["review_state"] == "pending"


def test_a_single_page_pdf_is_accepted_as_a_replacement(client, auth, sample_page):
    """Scanners emit PDFs. Refusing them would push the work back out of the product."""
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("rescan.pdf", make_pdf_bytes(pages=1), "application/pdf")},
    )
    assert response.status_code == 200
    assert response.json()["version_no"] == 2


def test_a_multi_page_pdf_is_refused_with_a_reason(client, auth, sample_page):
    """Taking page one silently would discard the rest of someone's document."""
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("whole-file.pdf", make_pdf_bytes(pages=3), "application/pdf")},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "3 pages" in detail
    # The message has to say what to do instead, not just refuse.
    assert "scan just" in detail.lower()


def test_a_file_that_is_not_an_image_is_refused_clearly(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("notes.txt", b"this is not a scan", "text/plain")},
    )
    assert response.status_code == 422
    assert "could not be read" in response.json()["detail"]


def test_an_empty_replacement_is_refused(client, auth, sample_page):
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["uploader"],
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert response.status_code == 422
    assert "empty" in response.json()["detail"].lower()


def test_replacing_requires_the_uploader_role(client, auth, sample_page):
    replacement = ingest.encode_png(text_page_image(width=400, height=500))
    response = client.post(
        f"/api/pages/{sample_page.id}/replace",
        headers=auth["reviewer"],
        files={"file": ("rescan.png", replacement, "image/png")},
    )
    assert response.status_code == 403
