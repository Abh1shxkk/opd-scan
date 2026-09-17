"""A page's review state is its latest closing decision, and every screen agrees on it.

Before, "any rescan request ever" won: accepting a page someone had sent for rescan said "Page
accepted." and left it on the rescan list and the printed checklist, while file rows, the dashboard
and the class filter kept counting accepted pages as "needs review".
"""

from __future__ import annotations

import time

import pytest

from app.models import Case, CompletenessResult, Job, QualityResult
from app.models.core import JobKind, JobState, PageClass
from app.services.query import PageFilters, rescan_rows
from tests.conftest import make_page_version


def _classify(db, pv, klass: PageClass) -> None:
    db.add(QualityResult(page_version_id=pv.id, overall=klass, score=0.5,
                         engine_version="test", thresholds_hash="deadbeef"))
    db.commit()


def _review(client, auth, pv_id: str, action: str) -> dict:
    response = client.post(f"/api/pages/{pv_id}/review", headers=auth["reviewer"], json={"action": action})
    assert response.status_code == 200, response.text
    # created_at ordering must be unambiguous between two quick clicks
    time.sleep(0.01)
    return response.json()


def _ids(client, auth, query: str) -> set[str]:
    body = client.get(f"/api/pages?{query}", headers=auth["reviewer"]).json()
    return {p["page_version_id"] for p in body["items"]}


@pytest.fixture()
def flagged(db, storage, batch):
    pv = make_page_version(db, storage, batch=batch, filename="flagged.pdf")
    _classify(db, pv, PageClass.review)
    return pv


def test_accept_after_a_rescan_request_takes_the_page_off_the_rescan_list(client, auth, flagged):
    _review(client, auth, flagged.id, "request_rescan")
    assert flagged.id in _ids(client, auth, "review_state=rescan_requested")

    assert _review(client, auth, flagged.id, "accept")["review_state"] == "accepted"
    assert flagged.id not in _ids(client, auth, "review_state=rescan_requested")
    assert flagged.id in _ids(client, auth, "review_state=accepted")


def test_a_rescan_request_after_accept_puts_it_back(client, auth, flagged):
    _review(client, auth, flagged.id, "accept")
    assert _review(client, auth, flagged.id, "request_rescan")["review_state"] == "rescan_requested"
    assert flagged.id in _ids(client, auth, "review_state=rescan_requested")
    assert flagged.id not in _ids(client, auth, "review_state=accepted")


def test_an_accepted_flagged_page_counts_as_acceptable_everywhere(client, auth, db, flagged):
    _review(client, auth, flagged.id, "accept")

    quality = client.get("/api/dashboard", headers=auth["reviewer"]).json()["totals"]["quality"]
    assert quality["review"] == 0
    assert quality["acceptable"] == 1

    assert flagged.id in _ids(client, auth, "page_class=acceptable")
    assert flagged.id not in _ids(client, auth, "page_class=review")

    docs = client.get("/api/documents", headers=auth["reviewer"]).json()["items"]
    row = next(d for d in docs if d["id"] == flagged.logical_page.document_id)
    assert row["page_class_counts"] == {"acceptable": 1}
    assert row["awaiting_review"] == 0


def test_an_unreviewed_flagged_page_still_counts_as_flagged(client, auth, flagged):
    quality = client.get("/api/dashboard", headers=auth["reviewer"]).json()["totals"]["quality"]
    assert quality["review"] == 1
    assert flagged.id in _ids(client, auth, "page_class=review")


def test_the_rescan_checklist_follows_the_latest_decision(client, auth, db, storage, batch):
    engine_rescan_accepted = make_page_version(db, storage, batch=batch, filename="a.pdf")
    _classify(db, engine_rescan_accepted, PageClass.rescan)
    engine_rescan_untouched = make_page_version(db, storage, batch=batch, filename="b.pdf")
    _classify(db, engine_rescan_untouched, PageClass.rescan)
    acceptable_but_requested = make_page_version(db, storage, batch=batch, filename="c.pdf")
    _classify(db, acceptable_but_requested, PageClass.acceptable)

    _review(client, auth, engine_rescan_accepted.id, "accept")
    _review(client, auth, acceptable_but_requested.id, "request_rescan")

    listed = {r["_page_version_id"] for r in rescan_rows(db, PageFilters())}
    assert listed == {engine_rescan_untouched.id, acceptable_but_requested.id}


def test_deleting_a_case_removes_its_jobs_and_completeness_row(client, auth, db, storage, batch):
    case = Case(batch_id=batch.id, patient_ref="MR-DEL", encounter_ref="IP-DEL")
    db.add(case)
    db.flush()
    pv = make_page_version(db, storage, batch=batch, filename="del.pdf", case=case)
    doc_id = pv.logical_page.document_id
    db.add(Job(kind=JobKind.quality, state=JobState.succeeded, document_id=doc_id, page_version_id=pv.id,
               idempotency_key="test-delete-case"))
    db.add(CompletenessResult(case_id=case.id))
    db.commit()
    case_id = case.id

    response = client.delete(f"/api/cases/{case_id}", headers=auth["admin"])
    assert response.status_code == 204, response.text

    db.expire_all()
    assert db.query(Job).filter(Job.document_id == doc_id).count() == 0
    assert db.query(CompletenessResult).filter(CompletenessResult.case_id == case_id).count() == 0
