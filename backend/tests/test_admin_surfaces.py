"""The admin surfaces that existed in the API and had no way in.

Users, retention, jobs and checklists were all backend-complete and unreachable: no screen called
them. These tests cover the backend gaps that had to be closed before a screen could, and the one
that made the completeness feature structurally inert — a case could only be given a checklist at
creation, and nothing ever passed one, so every case had none and every completeness panel reported
"not verified" permanently.
"""

from __future__ import annotations


def _make_checklist(client, auth, name: str = "Surgical admission") -> dict:
    response = client.post(
        "/api/checklists",
        headers=auth["admin"],
        json={
            "name": name,
            "is_active": True,
            "items": [
                {"doc_type": "Discharge summary", "min_pages": 1, "required": True},
                {"doc_type": "Operation notes", "min_pages": 2, "required": False},
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


# ----------------------------------------------------------------- users


def test_a_user_list_carries_the_date_the_account_was_added(client, auth):
    """`created_at` is required by the frontend User type and was never sent — there was simply no
    user screen to notice."""
    rows = client.get("/api/auth/users", headers=auth["admin"]).json()
    assert rows
    for row in rows:
        assert "created_at" in row and row["created_at"], "UserOut must carry created_at"


def test_only_an_admin_sees_or_changes_users(client, auth):
    assert client.get("/api/auth/users", headers=auth["reviewer"]).status_code == 403
    assert client.get("/api/auth/users", headers=auth["uploader"]).status_code == 403


def test_a_user_can_be_deactivated_and_reactivated(client, auth, users):
    target = users["uploader"].id

    off = client.patch(f"/api/auth/users/{target}", headers=auth["admin"], json={"is_active": False})
    assert off.status_code == 200
    assert off.json()["is_active"] is False

    on = client.patch(f"/api/auth/users/{target}", headers=auth["admin"], json={"is_active": True})
    assert on.json()["is_active"] is True


# ------------------------------------------------------------- retention


def test_retention_can_be_read_back_after_being_set(client, auth):
    """The endpoint existed with no client wrapper, so this round trip was never exercised."""
    saved = client.put(
        "/api/settings/retention",
        headers=auth["admin"],
        json={"originals_days": 90, "derivatives_days": 30, "audit_days": 0},
    )
    assert saved.status_code == 200

    caps = client.get("/api/settings/capabilities", headers=auth["admin"]).json()
    assert caps["retention"]["originals_days"] == 90
    assert caps["retention"]["derivatives_days"] == 30
    # Zero means "no period configured", not "delete immediately", and must survive as zero.
    assert caps["retention"]["audit_days"] == 0


def test_only_an_admin_may_change_retention(client, auth):
    response = client.put(
        "/api/settings/retention", headers=auth["reviewer"], json={"originals_days": 1}
    )
    assert response.status_code == 403


# ------------------------------------------------------------- checklists


def test_a_checklist_can_be_created_listed_and_deleted(client, auth):
    created = _make_checklist(client, auth)
    assert created["name"] == "Surgical admission"

    listed = client.get("/api/checklists", headers=auth["reviewer"]).json()
    assert any(c["id"] == created["id"] for c in listed)

    assert client.delete(f"/api/checklists/{created['id']}", headers=auth["admin"]).status_code == 204
    after = client.get("/api/checklists", headers=auth["reviewer"]).json()
    assert not any(c["id"] == created["id"] for c in after)


def test_a_checklist_can_be_attached_to_an_existing_case(client, auth, db, storage, batch):
    """The gap that made completeness unreachable.

    A case could only be given a checklist at creation and nothing ever passed one, so gap
    detection could never fire on any record in the product.
    """
    from app.models import Case

    case = Case(batch_id=batch.id, patient_ref="MR-9001", encounter_ref="IPD-9001")
    db.add(case)
    db.commit()

    checklist = _make_checklist(client, auth, name="Medical admission")

    before = client.get(f"/api/cases/{case.id}/completeness", headers=auth["reviewer"]).json()
    assert before["checklist_id"] is None
    assert before["status"] == "not_verified"

    attached = client.patch(
        f"/api/cases/{case.id}", headers=auth["uploader"], json={"checklist_id": checklist["id"]}
    )
    assert attached.status_code == 200
    assert attached.json()["checklist_id"] == checklist["id"]

    # The completeness endpoint reports it even before anything has been computed — otherwise the
    # control for attaching a checklist could never show its own current value.
    after = client.get(f"/api/cases/{case.id}/completeness", headers=auth["reviewer"]).json()
    assert after["checklist_id"] == checklist["id"]


def test_attaching_a_checklist_that_does_not_exist_is_refused(client, auth, db, batch):
    """Otherwise the case points at nothing and silently reports "not verified" forever — the exact
    failure this field was added to fix."""
    from app.models import Case

    case = Case(batch_id=batch.id, patient_ref="MR-9002", encounter_ref="IPD-9002")
    db.add(case)
    db.commit()

    response = client.patch(
        f"/api/cases/{case.id}", headers=auth["uploader"], json={"checklist_id": "no-such-checklist"}
    )
    assert response.status_code == 404
    assert "Checklist not found" in response.json()["detail"]


def test_detaching_a_checklist_is_allowed(client, auth, db, batch):
    from app.models import Case

    case = Case(batch_id=batch.id, patient_ref="MR-9003", encounter_ref="IPD-9003")
    db.add(case)
    db.commit()

    checklist = _make_checklist(client, auth, name="Day care")
    client.patch(f"/api/cases/{case.id}", headers=auth["uploader"], json={"checklist_id": checklist["id"]})

    detached = client.patch(
        f"/api/cases/{case.id}", headers=auth["uploader"], json={"checklist_id": None}
    )
    assert detached.status_code == 200
    assert detached.json()["checklist_id"] is None


# ------------------------------------------------------------------ jobs


def test_jobs_can_be_listed_and_filtered_by_state(client, auth):
    """The jobs screen filters on state; a plain array is returned, not a Paged wrapper."""
    all_jobs = client.get("/api/jobs", headers=auth["reviewer"])
    assert all_jobs.status_code == 200
    assert isinstance(all_jobs.json(), list)

    failed = client.get("/api/jobs?state=failed", headers=auth["reviewer"])
    assert failed.status_code == 200
    assert all(j["state"] == "failed" for j in failed.json())
