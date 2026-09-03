"""Authentication and role checks.

Permissions are enforced **server side on every route**, including the ones that serve images. A
preview or an export is patient data exactly as much as the JSON is, so ``require_page_access``
guards the file routes too rather than relying on an unguessable URL.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.db import get_db
from app.models import User
from app.models.core import Role

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def current_user(
    request: Request,
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
    db: Session = Depends(get_db),
) -> User:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(token)
    except Exception as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User is inactive or unknown")
    request.state.user_id = user.id
    return user


def require_roles(*roles: Role) -> Callable[..., User]:
    allowed = set(roles)

    def _dep(user: User = Depends(current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"This action requires one of: {', '.join(sorted(r.value for r in allowed))}.",
            )
        return user

    return _dep


# Convenience dependencies used across the routers.
require_admin = require_roles(Role.admin)
require_uploader = require_roles(Role.admin, Role.uploader)
require_reviewer = require_roles(Role.admin, Role.reviewer)
require_any = require_roles(Role.admin, Role.uploader, Role.reviewer)


def can_confirm_diagnosis(user: User) -> bool:
    """Only Admin and Reviewer may confirm or correct an extracted diagnosis.

    Any onward transfer into a clinical record system must consume a *confirmed* extraction; see
    ``docs/SECURITY.md``. Nothing in this codebase pushes to a downstream clinical system.
    """
    return user.role in (Role.admin, Role.reviewer)
