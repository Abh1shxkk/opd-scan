# Deployment

Running OPD Scan QC in a hospital records department. Written for a target of
**1,000 or more pages per day**, which is the customer's stated volume.

Read the [status table in the README](../README.md#status) before planning a
go-live date: the HTTP layer, the Celery application and the Alembic migration
are not yet present in this tree. The topology, sizing and operational
procedures below are the intended shape of the system and are what the compose
files build towards.

---

## 1. Topology

### Single server

Suitable for one records department at 1,000–5,000 pages a day, and the
configuration `docker-compose.yml` produces.

```
                    TLS terminates here
   staff LAN ──► reverse proxy ──► frontend (nginx :8080)
                 (nginx/Caddy/         │
                  Traefik + certs)     └─ /api ──► backend (uvicorn :8000)
                                                        │
                        ┌───────────────────────────────┼─────────────────┐
                        ▼                               ▼                 ▼
                   postgres:16                     redis:7          object store
                   (pg_data volume)             (redis_data)     (file_storage volume
                                                                  or MinIO / S3)
                                                     ▲
                                                     │
                                        worker × N ──┘   beat × 1
```

| Component | Purpose | Notes |
|---|---|---|
| Reverse proxy | TLS termination, HSTS, client-IP forwarding | Not in the compose file. The stack must not be exposed without one |
| `frontend` | Static SPA plus the `/api` proxy | One origin, so the bearer token is never sent cross-site |
| `backend` | FastAPI under uvicorn | Stateless; scale by adding processes |
| `worker` | Celery — ingest, quality, handwriting, diagnosis | Where the CPU goes |
| `beat` | Celery beat | **Exactly one**, always |
| `postgres` | Record of truth | The thing to back up first |
| `redis` | Broker and result backend | Durable AOF, but not the record of truth |
| Object store | Originals, renders, previews, thumbnails | The thing to back up second, and the larger of the two |

Baseline hardware for 1,000 pages/day: **8 vCPU, 16 GB RAM, 500 GB SSD**. The
disk is sized by retention, not by throughput — see below.

### Split, for higher volume

Beyond roughly 10,000 pages a day, or where the records department must keep
working while ingest runs hot:

- run `worker` on its own host or hosts, sized by CPU;
- run `postgres` as a managed or clustered instance with its own backup regime;
- move storage to S3 or a MinIO cluster (`STORAGE_BACKEND=s3`);
- keep `backend` behind two or more replicas with the reverse proxy load
  balancing between them;
- **still run exactly one `beat`.**

`backend` and `worker` hold no local state beyond the S3 read cache under
`STORAGE_ROOT`, so both scale horizontally without coordination.

### TLS

The compose stack speaks plain HTTP inside the Docker network and publishes port
8080. Put a TLS-terminating reverse proxy in front of it and let that proxy own
HSTS — `nginx.conf` deliberately does not set HSTS, so that it can be turned off
in one place. Do not publish 8080 to anything wider than the staff LAN.

---

## 2. Sizing

### Measure first

Do not size from the numbers below. Run the benchmark on the hardware you will
actually use, with your own scans:

```bash
make bench SAMPLES=/path/to/a/few/hundred/real/scans
```

It prints seconds per page for the local quality engine. Everything else follows
from that figure and from your page count.

### The arithmetic

1,000 pages/day over an 8-hour working day is **≈2 pages/minute average**, but
scanning is bursty: a clerk uploads three 35-page case files at once and then
nothing for twenty minutes. Size for the burst, not the average.

| Stage | Typical cost per page | Bound by |
|---|---|---|
| Rasterise (PDF → PNG at 150 DPI) | 0.2–0.8 s | CPU, page size |
| OpenCV quality analysis | 0.5–2 s | CPU, resolution. A 3300×3700 camera spread costs several times an A4 flatbed sheet |
| Provider OCR round trip | 1–5 s | Network and vendor latency, not your CPU |
| Handwriting detection | shares the OCR call | as above |
| Diagnosis extraction | shares the OCR call | as above |

Local-only (no provider configured), at 1.5 s/page:

```
1,000 pages × 1.5 s = 1,500 s of CPU per day ≈ 25 CPU-minutes
```

Trivial in aggregate. The reason to run four workers is burst latency: a clerk
who has just uploaded a 35-page file wants the review queue populated in a
minute, not in five.

With a cloud provider configured, the per-page wall time is dominated by network
latency, so concurrency matters much more — those seconds are spent waiting, not
computing.

### Worker concurrency

The compose file exposes `WORKER_CONCURRENCY` (default 4) and uses the
**prefork** pool. Prefork, not gevent or threads: the quality engine is
CPU-bound OpenCV and NumPy work that does not yield the GIL usefully.

| Situation | Guidance |
|---|---|
| Local engine only (no provider) | `WORKER_CONCURRENCY` = number of vCPUs, minus one for the API. On 8 vCPU: 6–7 |
| Cloud provider configured | Go higher — 2–3× vCPU — because most of each task is spent waiting on the network. Cap it below your vendor quota |
| Memory-constrained | Each prefork child holds a full page image, plus OpenCV working buffers. Budget **≈500 MB per child** for camera-resolution spreads. 4 children ≈ 2 GB |
| Provider rate limits | `PROVIDER_RATE_LIMIT_PER_MINUTE` is a token bucket **per process**. The real ceiling is that value × the number of worker processes. Divide before setting it |

The image pins `OPENCV_NUM_THREADS=1`, `OMP_NUM_THREADS=1` and
`OPENBLAS_NUM_THREADS=1`. Parallelism comes from running several worker
children, not from each child spawning a thread per core. Without those pins the
box thrashes at any real concurrency, and throughput goes down as you add
workers.

`--max-tasks-per-child=100` recycles children periodically: PyMuPDF and OpenCV
hold on to memory across large pages, and recycling bounds RSS growth.
`--prefetch-multiplier=1` stops one child from reserving a queue of long tasks
while its siblings idle.

### Storage

| Item | At 150 DPI |
|---|---|
| Original upload | 0.3–0.8 MB/page for a PDF; more for camera photographs (the sample files are 10–25 MB for 27–35 pages) |
| Rendered PNG | 1–3 MB/page |
| Preview (2000 px) | 0.3–1 MB/page |
| Thumbnail (320 px) | ~20 KB/page |
| **Working figure** | **8–15 MB per page, originals plus derivatives** |

At 1,000 pages/day: roughly **250–450 GB per year** before retention deletion.
Confirm against your own first batch. `RENDER_DPI` drives most of it — 300 DPI
is roughly four times the pixels and four times the analysis cost.

Derivatives are regenerable from the original, so
`RETENTION_DAYS_DERIVATIVES` can be much shorter than
`RETENTION_DAYS_ORIGINALS`. Both default to `0`, meaning *keep indefinitely*.
Set them to your records-retention policy, not to a guess.

### Database

Postgres growth is modest: metadata, findings, regions and audit rows. Budget a
few hundred bytes per page plus a row per finding and per audit event. At 1,000
pages/day the audit table is the fastest-growing object; plan to partition or
archive it once it is a year old.

---

## 3. Migrations

Schema changes are Alembic migrations, applied deliberately.

```bash
# review before applying — always
docker compose exec backend alembic history
docker compose exec backend alembic current

# apply
docker compose exec backend alembic upgrade head
```

Rules:

1. **Back up the database first.** Every time, not just for the risky ones.
2. **Run migrations from one place only.** Do not add `alembic upgrade head` to
   the container entrypoint: with several `backend` replicas starting at once,
   they race. Run it as an explicit step in your deployment procedure.
3. **Stop the workers for a destructive migration.** A worker mid-task against a
   half-migrated schema fails in ways that are tedious to unpick.
   ```bash
   docker compose stop worker beat
   docker compose exec backend alembic upgrade head
   docker compose start worker beat
   ```
4. **Additive migrations first.** Add the column, deploy code that writes both,
   backfill, then drop the old column in a later release. This keeps a rollback
   possible.
5. **Rehearse on a copy of production data**, not on an empty database. Most
   migration failures are data failures.

---

## 4. Backups

Two things must be backed up, and **they must be restored together** — a
database referring to objects that are not in the store is worse than useless.

### PostgreSQL

```bash
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  > "/backup/opd-$(date +%F-%H%M).dump"
```

Nightly, plus continuous WAL archiving if the site cannot accept losing a day's
review work. Restore:

```bash
docker compose exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
```

### Object storage

| Backend | Method |
|---|---|
| Local volume | Snapshot or `restic`/`borg` the `file_storage` volume. Content is immutable once written, so incrementals are cheap |
| MinIO | `mc mirror` to a second MinIO or to tape. Enable bucket versioning — `docker-compose.onprem.yml` does this |
| S3 | Cross-region replication or lifecycle-managed versioning |

Originals are **never** rewritten (`storage_key_original` is immutable and
nothing writes back to it), so an incremental backup of that prefix only ever
grows.

### Redis

Do not back it up. It carries in-flight queue state, not the record of truth. If
Redis is lost, in-flight jobs are lost with it, and the stalled-job sweeper
returns them to the queue.

### Test the restore

A backup that has never been restored is a hypothesis. Restore into a scratch
environment at least quarterly and confirm that a page's preview still renders —
that is what proves the database and the object store are in step.

### Retention deletion is not a backup policy

`RETENTION_DAYS_ORIGINALS` and `RETENTION_DAYS_DERIVATIVES` delete data on a
schedule. If your backups outlive your retention period, you have not deleted
anything. Align the two, and say so in the data-protection record.

---

## 5. Monitoring

### Health endpoints

| Check | Meaning |
|---|---|
| `GET /api/health` | The API process is answering. Liveness only |
| `docker compose ps` | Every service's healthcheck state |
| `GET /api/settings/capabilities` | Provider readiness. Alert if a capability that was `ready` becomes `unconfigured` — that is usually an expired credential |
| `GET /api/jobs?state=failed` | The queue's failure backlog |

The `backend` healthcheck is liveness, not readiness: it does not touch the
database, so a healthy API container does not prove Postgres is reachable.
Monitor the database separately.

The `beat` healthcheck has no ping interface to use, so it checks that the
persistent schedule file has been written within the last five minutes. That is
true only while beat is genuinely ticking, which is the property that matters.

### What to alert on

| Signal | Threshold | Why it matters |
|---|---|---|
| Queue depth (`state=queued`) | rising for more than 30 minutes | Workers are dead, wedged, or under-provisioned |
| Failed jobs | any sustained rate | Usually a provider credential or a quota |
| Jobs `running` with a stale `heartbeat_at` | more than a handful | Workers dying mid-task |
| `beat` container unhealthy | immediately | No stalled-job recovery and no retention sweeps while it is down |
| Disk usage on the storage volume | 80% | Ingest fails messily when the store fills |
| Postgres connections | 80% of `max_connections` | `backend` replicas × uvicorn workers × pool size adds up faster than expected |
| Provider 429s | any | `PROVIDER_RATE_LIMIT_PER_MINUTE` is set too high for your quota |
| A capability moving `ready` → `unconfigured` | immediately | Silent degradation. Results become `unconfigured`, correctly, but nobody notices |

### Business signals worth watching

These are not faults, but they tell you whether the scanning process is working:

- the proportion of pages classed `rescan` — a sudden rise usually means a
  scanner setting changed, not that the engine broke;
- `blank` page counts by batch;
- diagnosis extractions awaiting review, and their age;
- pages with an accepted rescan request that have not yet been replaced.

---

## 6. Log hygiene

**No patient text may reach the logs.** This is enforced by construction in
`backend/app/core/audit.py`, not by reviewer discipline:

- `_FORBIDDEN_KEYS` replaces the value of any metadata key named `text`,
  `raw_text`, `cleaned_text`, `diagnosis`, `content`, `ocr`, `full_text`,
  `patient_name`, `filename`, `original_filename`, `comment` or
  `corrected_text` with `<redacted>`;
- any string metadata value longer than 120 characters becomes
  `<redacted:long-string>`, because long strings are how free text leaks;
- `redact()` masks UUIDs in log messages;
- the audit helpers take identifiers and counts, not content;
- provider error bodies are never logged. Google and Azure can echo document
  content in an error response, so those handlers surface the HTTP status or the
  exception type only — never the body.

`LOG_PATIENT_TEXT` disables the redaction. **It must remain `false` in any
environment holding real records.** It exists for local debugging against
synthetic data. Assert it in your configuration management rather than trusting
that nobody set it.

Operational rules:

| Rule | Detail |
|---|---|
| Filenames are patient data | A scanning team names files `Sharma_Ramesh_discharge.pdf`. Filenames never enter logs |
| Log at INFO in production | DEBUG in third-party libraries prints request bodies. `httpx` at DEBUG will print an OCR payload |
| Retain logs no longer than needed | 30–90 days is usual. Longer means a longer-lived copy of your access patterns |
| Ship logs only inside your trust boundary | An external log aggregator is a third-party processor. Treat it as one in the data-protection record |
| nginx access logs | Carry request paths. Page and document IDs are opaque UUIDs, never names — but the paths still reveal who looked at what, so retain them under the same policy |
| Redact on the way out, not on the way in | The audit trail is meant to be complete. Redaction protects the *log*; the audit table holds identifiers and actions, which is what an investigation needs |

Distinguish the two records: the **audit trail** in Postgres is a deliberate,
queryable record of who did what, and it is retained under your records policy.
The **application log** is operational debris and should be short-lived.

---

## 7. Stalled-job recovery

### The problem

A worker container is killed mid-task — OOM, a node reboot, `docker compose
down` during a batch. The `jobs` row is left in `running` for ever. Nobody
notices, because the page simply never appears in the review queue.

### The design

`backend/app/models/core.py` carries the fields the recovery depends on:

| Field | Role |
|---|---|
| `state` | `queued` → `running` → `succeeded` / `failed` / `cancelled` |
| `attempt` / `max_attempts` | Attempts so far, and the ceiling (default 3, from `PROVIDER_MAX_ATTEMPTS`) |
| `worker_id` | Which worker claimed it |
| `heartbeat_at` | Updated periodically while the task runs. **This is the liveness signal** |
| `started_at` / `finished_at` | Timing |
| `idempotency_key` | `UNIQUE`. Re-queuing the same work cannot create a duplicate job |
| `error` | Last failure reason, provider-redacted |

The intended sweeper, on the `beat` schedule:

1. every few minutes, select jobs where `state = 'running'` and `heartbeat_at`
   is older than the stall threshold (a few multiples of the heartbeat interval,
   and comfortably longer than `PROVIDER_TIMEOUT_SECONDS`);
2. for each, if `attempt < max_attempts`, return it to `queued`, clear
   `worker_id`, increment `attempt`, and re-enqueue under the same
   `idempotency_key`;
3. otherwise set `state = 'failed'` with an error saying the worker was lost,
   so it appears in `GET /api/jobs?state=failed` rather than disappearing.

Three properties follow from that, and they are the point of the design:

- **A lost job never becomes a silent success.** It ends `queued` or `failed`,
  never `succeeded`.
- **A lost job never becomes a clean result.** A handwriting job that dies with
  its worker leaves the page's handwriting status at `pending` or `failed`, and
  the UI renders that as *"not checked"*. It is never rendered as *"no
  handwriting"*. The same holds for diagnosis and for the quality verdict.
- **Recovery is idempotent.** The unique `idempotency_key` means a job
  re-enqueued by the sweeper and a job re-enqueued by an impatient operator are
  the same job.

**This sweeper is not implemented in this tree.** `backend/app/workers/` is
empty. Until it exists, a killed worker leaves `running` rows behind, and they
must be found and returned by hand:

```sql
SELECT id, kind, state, attempt, worker_id, heartbeat_at
FROM jobs
WHERE state = 'running' AND heartbeat_at < now() - interval '30 minutes';
```

### Operational notes

- **Run exactly one `beat`.** Two beat processes run every periodic task twice,
  including the sweeper. The compose file pins `replicas: 1` and mounts a
  dedicated `beat_state` volume for the schedule file.
- **Shut down gracefully.** `docker compose stop` sends `SIGTERM`, and Celery
  finishes the task in hand before exiting. `docker kill` does not, and produces
  exactly the stalled rows described above.
- **Retries are not free with a cloud provider.** Google does not bill failed
  requests, but a job that fails after the provider answered has already been
  charged. Keep `PROVIDER_MAX_ATTEMPTS` at 3 unless you have a reason.
- **Re-processing a page is safe.** `POST /api/pages/{id}/reprocess` re-runs a
  stage. Diagnosis re-runs delete only extractions that have never been
  reviewed: a reviewer's confirmation or correction is never discarded by a
  re-run.

---

## 8. Upgrade procedure

```bash
# 1. back up — database and object store, together
./backup.sh

# 2. fetch the new version
git fetch --tags && git checkout <tag>

# 3. build without switching over
docker compose build

# 4. stop the queue so nothing runs against a half-migrated schema
docker compose stop worker beat

# 5. migrate
docker compose up -d postgres
docker compose exec backend alembic upgrade head

# 6. bring everything up on the new image
docker compose up -d

# 7. verify
curl -s localhost:8000/api/health
curl -s -H "Authorization: Bearer $TOKEN" localhost:8000/api/settings/capabilities
docker compose ps          # every service healthy
```

Roll back by checking out the previous tag and restoring the database dump. This
is why step 1 is not optional: an applied migration is not reversible by
redeploying the old image.

### After any upgrade that touches the quality engine

`engine_version` and `thresholds_hash` are stored on every quality result, so
old and new verdicts remain distinguishable. Existing results are **not**
recomputed automatically — a page reviewed and accepted under the old engine
stays accepted, which is correct. If you need the new engine's opinion on old
pages, re-queue them explicitly with `POST /api/pages/{id}/reprocess`, and
expect the reprocessing load to dwarf a normal day's ingest.
