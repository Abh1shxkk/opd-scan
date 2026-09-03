from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.rbac import current_user, require_admin
from app.core.security import create_access_token, hash_password, verify_password
from app.db import get_db
from app.models import User
from app.models.core import Role
from app.schemas.api import TokenOut, UserCreate, UserOut, UserPatch

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.email == form.username.lower().strip())).scalar_one_or_none()
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
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")

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
    return [UserOut.model_validate(u) for u in db.execute(select(User).order_by(User.email)).scalars()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    email = payload.email.lower().strip()
    if db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(409, "A user with that email already exists")
    try:
        role = Role(payload.role)
    except ValueError as exc:
        raise HTTPException(422, f"Unknown role '{payload.role}'") from exc

    user = User(
        email=email,
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
