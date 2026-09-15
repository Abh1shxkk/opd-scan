from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.rbac import current_user, require_admin
from app.core.security import create_access_token, hash_password, verify_password
from app.db import get_db
from app.models import User
from app.models.core import Role
from app.schemas.api import TokenOut, UserCreate, UserOut, UserPatch

router = APIRouter(prefix="/auth", tags=["auth"])


def _normalise(value: str | None) -> str | None:
    """Identifiers are stored and compared lowercased and trimmed.

    Someone typing their username with a capital on a tablet keyboard is not a different person,
    and a trailing space pasted from a spreadsheet is not either.
    """
    cleaned = (value or "").strip().lower()
    return cleaned or None


def _by_identifier(db: Session, identifier: str) -> User | None:
    """Find a user by either of the two things they may have been given to sign in with."""
    wanted = _normalise(identifier)
    if not wanted:
        return None
    return db.execute(
        select(User).where(or_(User.email == wanted, User.username == wanted))
    ).scalar_one_or_none()


@router.post("/login", response_model=TokenOut)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = _by_identifier(db, form.username)
    if not user or not user.is_active or not verify_password(form.password, user.password_hash):
        # Deliberately identical for unknown user, wrong password and disabled account.
        audit.record(
            db,
            actor_id=None,
            action="login.failed",
            entity_type="user",
            ip=request.client.host if request.client else None,
        )
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username or password")

    audit.record(
        db,
        actor_id=user.id,
        action="login.success",
        entity_type="user",
        entity_id=user.id,
        ip=request.client.host if request.client else None,
    )
    db.commit()
    return TokenOut(
        access_token=create_access_token(user.id, user.role.value),
        user=UserOut.model_validate(user),
    )


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return UserOut.model_validate(user)


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return [UserOut.model_validate(u) for u in db.execute(select(User).order_by(User.username, User.email)).scalars()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    email = _normalise(payload.email)
    username = _normalise(payload.username)
    if not email and not username:
        raise HTTPException(422, "A username or an email address is required to sign in with.")

    # Checked separately so the message names the one that clashes. "That user already exists" when
    # only the username collides sends an admin looking at the wrong field.
    if email and db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(409, "A user with that email already exists")
    if username and db.execute(select(User).where(User.username == username)).scalar_one_or_none():
        raise HTTPException(409, "A user with that username already exists")

    try:
        role = Role(payload.role)
    except ValueError as exc:
        raise HTTPException(422, f"Unknown role '{payload.role}'") from exc

    user = User(
        email=email,
        username=username,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        role=role,
    )
    db.add(user)
    db.flush()
    audit.record(db, actor_id=actor.id, action="user.create", entity_type="user", entity_id=user.id,
                 meta={"role": role.value})
    db.commit()
    return UserOut.model_validate(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def patch_user(user_id: str, payload: UserPatch, db: Session = Depends(get_db),
               actor: User = Depends(require_admin)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    changed = []

    # Identifiers first: if either change is refused the account is left exactly as it was, rather
    # than half-updated with a role applied and a clashing username rejected.
    fields = payload.model_dump(exclude_unset=True)
    if "email" in fields or "username" in fields:
        email = _normalise(fields["email"]) if "email" in fields else user.email
        username = _normalise(fields["username"]) if "username" in fields else user.username
        if not email and not username:
            raise HTTPException(422, "A user must keep a username or an email to sign in with.")

        if email != user.email and email:
            clash = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if clash and clash.id != user.id:
                raise HTTPException(409, "A user with that email already exists")
        if username != user.username and username:
            clash = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
            if clash and clash.id != user.id:
                raise HTTPException(409, "A user with that username already exists")

        if "email" in fields and email != user.email:
            user.email = email
            changed.append("email")
        if "username" in fields and username != user.username:
            user.username = username
            changed.append("username")

    if payload.role is not None:
        try:
            user.role = Role(payload.role)
        except ValueError as exc:
            raise HTTPException(422, f"Unknown role '{payload.role}'") from exc
        changed.append("role")
    if payload.is_active is not None:
        if user.id == actor.id and payload.is_active is False:
            raise HTTPException(400, "You cannot deactivate your own account")
        user.is_active = payload.is_active
        changed.append("is_active")
    if payload.full_name is not None:
        user.full_name = payload.full_name
        changed.append("full_name")
    if payload.password:
        user.password_hash = hash_password(payload.password)
        changed.append("password")
    db.add(user)
    audit.record(db, actor_id=actor.id, action="user.update", entity_type="user", entity_id=user.id,
                 meta={"fields": changed})
    db.commit()
    return UserOut.model_validate(user)
