#!/bin/sh
# Render free-tier services can't use preDeployCommand, so migrations run here, as part of the
# container's own startup, before the API starts accepting traffic.
set -e
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
