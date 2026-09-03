# OPD Scan QC — developer and operator entry points.
#
#   make help          list every target
#
# Targets that need a local Python environment use $(VENV); targets that need
# the whole stack use docker compose. Nothing here talks to a cloud provider.

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

BACKEND   := backend
FRONTEND  := frontend
VENV      := $(BACKEND)/.venv
# Absolute, because several recipes cd into backend/ or frontend/ first.
PYBIN     := $(CURDIR)/$(VENV)/bin
PIP       := $(PYBIN)/pip

COMPOSE       := docker compose
COMPOSE_FILES := -f docker-compose.yml
# Add the on-prem overlay:  make up ONPREM=1
ifdef ONPREM
COMPOSE_FILES := -f docker-compose.yml -f docker-compose.onprem.yml
endif

# Folder of your own sample scans, used by calibrate and bench.
SAMPLES ?= ./samples

.PHONY: help install dev-backend dev-frontend migrate seed test lint \
        up down logs calibrate bench env-check bootstrap admin

# --------------------------------------------------------------------------- #

help: ## Show this help
	@echo "OPD Scan QC"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  ONPREM=1        apply docker-compose.onprem.yml to up/down/logs"
	@echo "  SAMPLES=<dir>   folder of scans for calibrate/bench (default ./samples)"

env-check:
	@test -f .env || { \
	  echo "No .env found. Create one with:"; \
	  echo "    cp .env.example .env"; \
	  echo "then set SECRET_KEY and POSTGRES_PASSWORD before starting the stack."; \
	  exit 1; }

# --------------------------------------------------------------------------- #
# Local development (no Docker)
# --------------------------------------------------------------------------- #

install: ## Create the backend venv, install Python and npm dependencies
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip wheel
	$(PIP) install -r $(BACKEND)/requirements-dev.txt
	cd $(FRONTEND) && npm ci
	@echo
	@echo "Installed. The local OCR provider also needs the Tesseract binary with"
	@echo "English and Hindi data, which pip cannot supply:"
	@echo "    Debian/Ubuntu:  sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin"
	@echo "    macOS:          brew install tesseract tesseract-lang"
	@echo "The OpenCV quality engine needs none of that and works as installed."

dev-backend: ## Run the API with reload on http://localhost:8000
	cd $(BACKEND) && $(PYBIN)/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

dev-frontend: ## Run the Vite dev server on http://localhost:5173 (proxies /api to :8000)
	cd $(FRONTEND) && npm run dev

# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #

migrate: ## Apply Alembic migrations to the configured DATABASE_URL
	@test -f $(BACKEND)/alembic.ini || { \
	  echo "backend/alembic.ini is missing, so there is nothing to run."; \
	  echo "Run this from the repository root, not from backend/."; \
	  exit 1; }
	cd $(BACKEND) && $(PYBIN)/alembic upgrade head

seed: ## Create the first admin user (prompts for e-mail and password)
	@test -f $(BACKEND)/tools/seed.py || { \
	  echo "backend/tools/seed.py is missing, so there is no seeding step to run."; \
	  echo "Run this from the repository root, not from backend/."; \
	  exit 1; }
	cd $(BACKEND) && $(PYBIN)/python -m tools.seed

# --------------------------------------------------------------------------- #
# Quality gates
# --------------------------------------------------------------------------- #

test: ## Run the backend test suite and the frontend type-check
	cd $(BACKEND) && $(PYBIN)/pytest -q
	cd $(FRONTEND) && npm run typecheck

lint: ## Ruff over the backend, tsc over the frontend
	$(PYBIN)/ruff check $(BACKEND)
	$(PYBIN)/ruff format --check $(BACKEND)
	cd $(FRONTEND) && npm run typecheck

# --------------------------------------------------------------------------- #
# Docker stack
# --------------------------------------------------------------------------- #

up: env-check ## Build and start the whole stack in the background
	$(COMPOSE) $(COMPOSE_FILES) up -d --build
	@echo
	@echo "Frontend:      http://localhost:$${FRONTEND_PORT:-8080}"
	@echo "Capabilities:  http://localhost:8000/api/settings/capabilities"
	@echo "Follow logs:   make logs"

bootstrap: up ## Start the stack and create the first admin user (one command from clone to login)
	@echo
	@echo "Waiting for the API to report healthy..."
	@for i in $$(seq 1 60); do \
	  if curl -fsS http://localhost:8000/api/health >/dev/null 2>&1; then break; fi; \
	  sleep 2; \
	done
	@curl -fsS http://localhost:8000/api/health >/dev/null 2>&1 || { \
	  echo "The API did not come up. Run 'make logs' to see why."; exit 1; }
	@echo "API is up. Creating the first admin user."
	$(COMPOSE) $(COMPOSE_FILES) run --rm --no-deps backend python -m tools.seed \
	  --email "$${ADMIN_EMAIL:-admin@hospital.local}" --name "Administrator"
	@echo
	@echo "Sign in at http://localhost:$${FRONTEND_PORT:-8080} with that e-mail."

admin: ## Create or reset an admin user in the running stack (ADMIN_EMAIL=you@example.org)
	$(COMPOSE) $(COMPOSE_FILES) run --rm --no-deps backend python -m tools.seed \
	  --email "$${ADMIN_EMAIL:?set ADMIN_EMAIL=you@example.org}" --name "Administrator"

down: ## Stop the stack (named volumes, and therefore patient data, are kept)
	$(COMPOSE) $(COMPOSE_FILES) down
	@echo "Volumes kept. 'docker compose down -v' also deletes the database and every stored scan."

logs: ## Follow logs for every service
	$(COMPOSE) $(COMPOSE_FILES) logs -f --tail=200

# --------------------------------------------------------------------------- #
# Quality-engine tuning
#
# Both targets run the local OpenCV engine only. They never open the database
# and never send a page to a provider, so they are safe to run against real
# scans on an unconnected machine.
# --------------------------------------------------------------------------- #

calibrate: ## Score a folder of scans and write calibration.csv (SAMPLES=<dir>)
	@test -d "$(SAMPLES)" || { \
	  echo "No such folder: $(SAMPLES)"; \
	  echo "Point it at your own scans:  make calibrate SAMPLES=/path/to/scans"; \
	  exit 1; }
	cd $(BACKEND) && $(PYBIN)/python -m tools.calibrate "$(abspath $(SAMPLES))" \
	  --dpi $${RENDER_DPI:-150} --csv ../calibration.csv
	@echo "Wrote calibration.csv. See docs/SETUP.md for how to read it and adjust thresholds."

bench: ## Measure quality-engine throughput on real pages (SAMPLES=<dir>)
	@test -d "$(SAMPLES)" || { \
	  echo "No such folder: $(SAMPLES)"; \
	  echo "Point it at your own scans:  make bench SAMPLES=/path/to/scans"; \
	  exit 1; }
	@echo "Timing the local quality engine only — no provider calls, no database."
	cd $(BACKEND) && $(PYBIN)/python -m tools.calibrate "$(abspath $(SAMPLES))" \
	  --dpi $${RENDER_DPI:-150} --json ../benchmark.json \
	  | tail -n 3
	@echo "Per-page seconds are in the last lines above and in benchmark.json."
	@echo "Multiply by pages/day to size the worker pool; see docs/DEPLOYMENT.md."
