#!/bin/sh
# Render free-tier services can't use preDeployCommand, so migrations run here, as part of the
# container's own startup, before the API starts accepting traffic.
set -e
alembic upgrade head

# There's no public signup route (creating a user requires an existing admin) and the free Render
# plan has no Shell access to run `python -m tools.seed` by hand — so the first admin is bootstrapped
# here instead, from env vars, every time the container starts. `upsert` in tools/seed.py makes this
# idempotent: it just resets the same account's password on every restart, it doesn't duplicate it.
if [ -n "$BOOTSTRAP_ADMIN_EMAIL" ] && [ -n "$BOOTSTRAP_ADMIN_PASSWORD" ]; then
  python -m tools.seed --email "$BOOTSTRAP_ADMIN_EMAIL" --password "$BOOTSTRAP_ADMIN_PASSWORD" --name Administrator --role admin
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
