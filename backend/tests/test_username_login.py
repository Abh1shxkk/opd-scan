"""Signing in with a username instead of an email address.

Hospital staff are routinely issued a username and no mailbox — the legacy records system this
replaces has a nullable email column for exactly that reason — so an account must be able to exist
with only one of the two identifiers, and either one must get you in.
"""

from __future__ import annotations

from app.core.security import hash_password
from app.models import User
from app.models.core import Role


def _login(client, identifier: str, password: str):
    return client.post("/api/auth/login", data={"username": identifier, "password": password})


def _make(db, *, email=None, username=None, password="StrongPass1", role=Role.uploader) -> User:
    user = User(
        email=email,
        username=username,
        full_name="Test Person",
        password_hash=hash_password(password),
        role=role,
    )
    db.add(user)
    db.commit()
    return user


def test_a_username_only_account_can_sign_in(client, db):
    _make(db, username="pratibha_cssh")

    response = _login(client, "pratibha_cssh", "StrongPass1")
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["username"] == "pratibha_cssh"
    assert body["user"]["email"] is None
    assert body["access_token"]


def test_an_email_account_still_signs_in_with_its_email(client, db):
    """The existing path must not regress — every account today is email-only."""
    _make(db, email="clerk@hospital.test")

    assert _login(client, "clerk@hospital.test", "StrongPass1").status_code == 200


def test_either_identifier_works_when_both_are_set(client, db):
    _make(db, email="both@hospital.test", username="both_user")

    assert _login(client, "both@hospital.test", "StrongPass1").status_code == 200
    assert _login(client, "both_user", "StrongPass1").status_code == 200


def test_identifiers_are_matched_case_insensitively_and_trimmed(client, db):
    """Someone typing a capital on a tablet keyboard is not a different person, and a trailing
    space pasted from a spreadsheet is not either."""
    _make(db, username="ward_clerk")

    assert _login(client, "Ward_Clerk", "StrongPass1").status_code == 200
    assert _login(client, "  ward_clerk  ", "StrongPass1").status_code == 200


def test_a_wrong_password_is_refused_the_same_way_for_both(client, db):
    _make(db, email="a@hospital.test", username="a_user")

    for identifier in ("a@hospital.test", "a_user", "nobody_at_all"):
        response = _login(client, identifier, "WrongPassword")
        assert response.status_code == 401
        # Identical for unknown user and wrong password, so the response cannot be used to
        # enumerate who has an account.
        assert response.json()["detail"] == "Incorrect username or password"


def test_a_deactivated_username_account_cannot_sign_in(client, db):
    user = _make(db, username="left_the_job")
    user.is_active = False
    db.commit()

    assert _login(client, "left_the_job", "StrongPass1").status_code == 401


# ------------------------------------------------------- creating accounts


def test_an_admin_can_create_a_username_only_user(client, auth):
    response = client.post(
        "/api/auth/users",
        headers=auth["admin"],
        json={"username": "new_clerk", "password": "StrongPass1", "role": "uploader"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["username"] == "new_clerk"
    assert response.json()["email"] is None

    assert _login(client, "new_clerk", "StrongPass1").status_code == 200


def test_creating_a_user_with_neither_identifier_is_refused(client, auth):
    response = client.post(
        "/api/auth/users", headers=auth["admin"], json={"password": "StrongPass1"}
    )
    assert response.status_code == 422
    assert "username or an email" in response.json()["detail"]


def test_a_duplicate_username_names_the_field_that_clashed(client, auth):
    client.post(
        "/api/auth/users",
        headers=auth["admin"],
        json={"username": "taken", "password": "StrongPass1"},
    )
    response = client.post(
        "/api/auth/users",
        headers=auth["admin"],
        json={"username": "taken", "password": "StrongPass1"},
    )
    assert response.status_code == 409
    # Naming the clashing field matters: "that user exists" sends an admin to the wrong input.
    assert "username" in response.json()["detail"]


def test_usernames_are_stored_normalised(client, auth):
    """Otherwise "Ward_Clerk" and "ward_clerk" become two accounts that look like one."""
    response = client.post(
        "/api/auth/users",
        headers=auth["admin"],
        json={"username": "  MixedCase_User  ", "password": "StrongPass1"},
    )
    assert response.json()["username"] == "mixedcase_user"


def test_a_username_only_reviewer_is_named_not_numbered_in_a_review(
    client, auth, db, storage, batch
):
    """With no email to fall back to, the audit trail must use the username rather than the UUID."""
    from tests.conftest import make_page_version
    from app.core.security import create_access_token

    reviewer = _make(db, username="dr_sharma", role=Role.reviewer)
    pv = make_page_version(db, storage, batch=batch, filename="named.pdf")

    headers = {"Authorization": f"Bearer {create_access_token(reviewer.id, reviewer.role.value)}"}
    assert client.post(
        f"/api/pages/{pv.id}/review", headers=headers, json={"action": "accept"}
    ).status_code == 200

    review = client.get(f"/api/pages/{pv.id}", headers=auth["reviewer"]).json()["reviews"][-1]
    assert review["reviewer_name"] == "Test Person"  # full_name wins when present

    # And with no full name either, the username stands in — never the id.
    reviewer.full_name = ""
    db.commit()
    review = client.get(f"/api/pages/{pv.id}", headers=auth["reviewer"]).json()["reviews"][-1]
    assert review["reviewer_name"] == "dr_sharma"
