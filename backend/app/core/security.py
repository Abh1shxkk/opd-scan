"""Password hashing and JWT issuing.

bcrypt is used directly rather than through passlib: passlib 1.7.4 is unmaintained against
bcrypt 4.x and mis-handles the 72-byte input limit, which surfaced as a hard failure on ordinary
passwords during setup. Hashing here is explicit about that limit instead.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings

ALGORITHM = "HS256"
_BCRYPT_MAX_BYTES = 72


def _prepare(raw: str) -> bytes:
    """bcrypt silently truncates beyond 72 bytes, which would make two different long passwords
    interchangeable. Pre-hashing keeps the whole password significant."""
    data = raw.encode("utf-8")
    if len(data) > _BCRYPT_MAX_BYTES:
        return hashlib.sha256(data).hexdigest().encode("ascii")
    return data


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(_prepare(raw), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prepare(raw), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def create_access_token(subject: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
