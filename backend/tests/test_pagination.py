"""Server-side paging for patient records and diagnoses."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import Case


def test_cases_paged_returns_one_page_with_totals(client, auth, db, batch):
    base = datetime(2026, 9, 17, 10, 0, tzinfo=timezone.utc)
    for i in range(7):
        db.add(Case(batch_id=batch.id, patient_ref=f"MR{i}", encounter_ref=f"IP{i}",
                    created_at=base + timedelta(hours=i)))
    db.commit()

    body = client.get("/api/cases/paged?limit=3&offset=0", headers=auth["reviewer"]).json()
    assert body["total"] == 7 and body["grand_total"] == 7
    assert len(body["items"]) == 3

    last = client.get("/api/cases/paged?limit=3&offset=6", headers=auth["reviewer"]).json()
    assert len(last["items"]) == 1


def test_cases_paged_filters_by_entry_window(client, auth, db, batch):
    base = datetime(2026, 9, 17, 10, 0, tzinfo=timezone.utc)
    for i in range(5):
        db.add(Case(batch_id=batch.id, patient_ref=f"W{i}", encounter_ref=f"WIP{i}",
                    created_at=base + timedelta(hours=i)))
    db.commit()

    body = client.get(
        "/api/cases/paged",
        params={"created_from": "2026-09-17T11:00:00Z", "created_to": "2026-09-17T12:30:00Z"},
        headers=auth["reviewer"],
    ).json()
    assert body["total"] == 2
    assert body["grand_total"] == 5


def test_plain_case_list_is_unchanged(client, auth):
    assert isinstance(client.get("/api/cases", headers=auth["reviewer"]).json(), list)
