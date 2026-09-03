"""Create the first admin user and (optionally) demonstration accounts.

    python -m tools.seed --email admin@hospital.example --password '...' --role admin

No patient data is created here. The `--demo-users` flag adds one uploader and one reviewer so a
new deployment can be walked through the workflow immediately; it is refused outside dev/staging.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.config import settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import User  # noqa: E402
from app.models.core import Role  # noqa: E402


def upsert(db, email: str, password: str, role: Role, full_name: str) -> str:
    email = email.lower().strip()
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user:
        user.password_hash = hash_password(password)
        user.role = role
        user.is_active = True
        db.add(user)
        db.commit()
        return f"updated {email} ({role.value})"
    user = User(email=email, full_name=full_name, password_hash=hash_password(password), role=role)
    db.add(user)
    db.commit()
    return f"created {email} ({role.value})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", default=None, help="omit to be prompted")
    ap.add_argument("--name", default="Administrator")
    ap.add_argument("--role", default="admin", choices=[r.value for r in Role])
    ap.add_argument("--demo-users", action="store_true", help="also create demo uploader/reviewer accounts")
    args = ap.parse_args()

    password = args.password or getpass.getpass("Password: ")
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 2

    db = SessionLocal()
    try:
        print(upsert(db, args.email, password, Role(args.role), args.name))
        if args.demo_users:
            if settings.environment == "prod":
                print("Refusing to create demo accounts in a production environment.", file=sys.stderr)
                return 2
            print(upsert(db, "uploader@example.test", password, Role.uploader, "Demo Uploader"))
            print(upsert(db, "reviewer@example.test", password, Role.reviewer, "Demo Reviewer"))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
