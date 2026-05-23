# Candidate Proposal — Distributed CPU Workers for AI-Legal

**Status:** Draft / Proposed
**Owner:** Daniel Shamir (@Dshamir)
**Date:** 2026-05-23
**Path:** `proposed-upgrades/candidate-AI-Legal-distributed-CPU.md`
**Precedent:** [Exp_dental](https://github.com/Dshamir/Exp_dental) Celery worker pattern (`worker_segmentation`, `worker_crown_generation`, `worker_decimation`, `worker_marginline` + `flower`)

---

## 1. Why this exists

AI-Legal today runs every operation — short HTTP requests, multi-second LLM calls, multi-minute PDF/OCR ingests, embedding generation, report rendering — inside a single `backend` Node.js container. The longer the heavy work runs, the more it starves the request path. A single 200-page contract analysis can degrade every other user's experience.

We already run Redis in `docker-compose.yml`, but nothing is pulling work off it. This proposal lays out a goal-oriented path to **move all long-running and CPU-heavy work off the web tier onto a distributed worker fleet**, using the infrastructure we already operate.

It is the Node-ecosystem expression of the same proven shape we run in `Exp_dental`.

---

## 2. Goals (outcomes, not features)

| # | Goal | Why it matters |
|---|------|----------------|
| **G1** | **Web-tier latency stays stable under load.** p95 for non-job HTTP endpoints stays < 300 ms even with 50 OCR jobs in flight. | Login, list, dashboard, settings must never be slow because another user uploaded a contract. |
| **G2** | **Heavy work scales independently.** OCR or LLM throughput doubles by adding worker replicas with zero application code change. | Linear horizontal scaling without re-architecting. |
| **G3** | **A runaway job cannot kill the web server.** Worker OOM, hang, or upstream API stall is isolated to that worker. | Operational safety. Reliability over efficiency. |
| **G4** | **Foundation reaches Kubernetes/KEDA later without rewrites.** Same queue abstraction works at 1 host or 50. | Future-proof. We don't redo this in 6 months. |
| **G5** | **Observability of async work.** Every job is inspectable: status, attempt count, last error, runtime. | Without this, async = silent failure factory. |

**Explicit non-goals (so reviewers don't ask):**
- Not adding GPU workloads — all inference goes to Anthropic / Gemini / OpenAI.
- Not migrating to Kubernetes in this phase.
- Not replacing Postgres, Redis, MinIO, GoTrue, or PostgREST.
- Not breaking the existing synchronous API surface — only specific slow endpoints become async.

---

## 3. Success criteria (measurable)

| Metric | Today (estimated) | Target (after Phase 2) |
|---|---|---|
| `backend` container CPU during heavy ingest | spikes to 90–100 % | stays < 40 % |
| p95 latency, `/api/files` listing | degrades to 2–5 s under load | < 300 ms regardless of load |
| Time to start a 200-page PDF analysis | blocks one HTTP worker for full duration | returns `{ jobId }` in < 500 ms |
| Crash blast radius of bad job | kills `backend` → all users 503 | kills one worker pod → next pod picks the job up |
| Time to add capacity | restart backend, hope | `docker compose up --scale worker-pdf-ingest=N`, zero downtime |
| Visibility into queued / running / failed jobs | none | Bull-Board dashboard at `/admin/queues` |

---

## 4. Architecture

### Logical view

```
            ┌────────────┐
            │  Frontend  │  (Next.js)
            └─────┬──────┘
                  │ HTTPS
            ┌─────▼──────┐         enqueues
            │  Backend   │──────────────────────────┐
            │ (HTTP API) │                          │
            └─────┬──────┘                          │
                  │                                 ▼
        Postgres / MinIO                  ┌──────────────────┐
                                          │   Redis (BullMQ) │
                                          └──────┬───────────┘
                                                 │ consumes
                              ┌──────────────────┼──────────────────┐
                              ▼                  ▼                  ▼
                       ┌────────────┐    ┌────────────┐    ┌────────────┐
                       │ worker-    │    │ worker-    │    │ worker-    │
                       │ pdf-ingest │    │ embeddings │    │ llm-call   │
                       │ (CPU)      │    │ (mixed)    │    │ (I/O wait) │
                       └────────────┘    └────────────┘    └────────────┘
                                                 │
                                                 ▼
                                    results → Postgres / MinIO
                                    status  → SSE/WebSocket → Frontend
```

### Key design decisions

| Decision | Choice | Alternative considered | Why |
|---|---|---|---|
| Queue library | **BullMQ** | Celery, RabbitMQ + amqplib, Temporal, SQS | Native Node, Redis-backed (no new infra), strong tooling (Bull-Board), de facto standard for Node SaaS at our scale |
| Worker image | **Same image as backend, different entrypoint** | Separate worker repo | Zero drift, one Dockerfile, one CI pipeline |
| Job state of record | **Postgres** for business state, **Redis** for queue state | All-in-Redis | Redis = ephemeral by design; Postgres = durable audit trail |
| Result delivery to frontend | **SSE for live updates, polling fallback** | WebSocket | Simpler, passes through nginx without `Upgrade` headers, auto-reconnect for free |
| Job topology | **Multiple named queues by latency class** | One queue with priorities | Lets us tune concurrency per workload and scale per workload |

---

## 5. Queue topology

| Queue | Latency class | Concurrency / worker | Typical job | Why a separate queue |
|---|---|---|---|---|
| `pdf-ingest` | 30 s – 5 min | 1 | OCR + text extraction of uploaded PDF | CPU-bound, cannot share a core |
| `embeddings` | 5 – 60 s | 4 | Chunk → embed → upsert vectors | Mixed CPU + API I/O |
| `llm-call` | 5 – 90 s | 50 | Call Anthropic/Gemini/OpenAI, persist response | Pure I/O wait, very high concurrency is safe |
| `report-gen` | 2 – 20 s | 2 | Render PDF/DOCX report from template + data | CPU-moderate, in-memory rendering |
| `notify` | < 2 s | 20 | Email (Resend), webhook fan-out | Cheap, must not contend with heavy queues |
| `cleanup` | minutes, scheduled | 1 | Retention sweeps, orphan blob GC, index re-pack | Background only, never in user request path |

**Retry policy:** exponential backoff (1 s, 5 s, 30 s, 5 min, 1 h), max 5 attempts, then dead-letter queue with alerting.

---

## 6. Phased rollout

### Phase 1 — Foundation (same host)

**Goal:** Prove the pattern, take OCR off the request path.

**Deliverables**
- `bullmq` + `@bull-board/express` added to `backend/package.json`
- `backend/src/queues/` directory — one module per queue in the topology
- `backend/src/worker.ts` entrypoint
- `worker` service added to `docker-compose.yml`, same image, command `["node", "dist/worker.js"]`
- One endpoint migrated end-to-end: PDF upload → enqueue → 202 with `jobId` → SSE stream to frontend
- Bull-Board mounted at `/admin/queues` behind GoTrue admin auth
- GlitchTip wired into worker (same DSN as backend, tag `service=worker`)

**Acceptance**
- All existing endpoints respond identically
- New `/files/:id/analyze` returns within 500 ms regardless of file size
- Worker killed mid-job: next worker picks the job up and completes it
- Queue depth visible in Bull-Board in real time

**Effort:** ~3 dev-days

### Phase 2 — True distribution (separate host)

**Goal:** Workers run on a different VM than the web server. A worker host going down does not affect the web tier.

**Deliverables**
- Network-accessible Redis with TLS and password (today `:6379` is exposed on the host — needs hardening)
- `docker-compose.workers.yml` runnable standalone on a second VM
- `docs/operations/distributed-workers.md`
- Health & metrics endpoint on every worker
- Runbooks: "worker host is down", "queue is backed up", "DLQ depth > 10"

**Acceptance**
- Drop the worker container from the main host — workload still completes on the secondary host
- Pull the network on the worker host — backend stays healthy, jobs retry when network returns
- Scaling worker replicas requires only `docker compose up --scale worker-pdf-ingest=4`

**Effort:** ~4 dev-days + infra

### Phase 3 — Autoscaling (later, optional)

**Goal:** Workers scale to zero when idle, scale up when queue depth grows.

**Deliverables**
- Workers (only) on k3s or managed Kubernetes
- KEDA `ScaledObject` per queue with Redis stream length trigger
- Cost dashboard

**Acceptance**
- Idle hours: zero worker pods running
- Sustained queue depth > 10: pods spawn automatically
- Total infra cost lower than always-on Phase 2 at current traffic

**Effort:** ~5 dev-days, triggered when traffic justifies it

---

## 7. Concrete file-level changes (Phase 1)

```
backend/
├── package.json                       # + bullmq, @bull-board/express
├── src/
│   ├── queues/
│   │   ├── index.ts                   # NEW — exports named queues
│   │   ├── pdf-ingest.ts              # NEW
│   │   ├── embeddings.ts              # NEW
│   │   ├── llm-call.ts                # NEW
│   │   ├── report-gen.ts              # NEW
│   │   ├── notify.ts                  # NEW
│   │   └── cleanup.ts                 # NEW
│   ├── worker.ts                      # NEW — worker entrypoint
│   ├── jobs/                          # NEW — actual processors
│   │   ├── ingestPdf.ts
│   │   ├── generateEmbeddings.ts
│   │   ├── callLlm.ts
│   │   └── ...
│   ├── routes/
│   │   ├── files.ts                   # CHANGED — POST analyze → enqueue
│   │   └── jobs.ts                    # NEW — GET /jobs/:id, SSE /jobs/:id/stream
│   └── admin/
│       └── queues.ts                  # NEW — Bull-Board mount
docker-compose.yml                     # CHANGED — add worker service
.env.example                           # + BULL_PREFIX, QUEUE_REDIS_URL
docs/operations/distributed-workers.md # NEW
```

### `docker-compose.yml` diff sketch

```yaml
worker:
  build:
    context: ./backend
    dockerfile: Dockerfile
  command: ["node", "dist/worker.js"]
  restart: unless-stopped
  depends_on:
    redis:    { condition: service_healthy }
    postgres: { condition: service_healthy }
    minio:    { condition: service_healthy }
  environment:
    # same env block as backend — extract to a YAML anchor in the real diff
    DATABASE_URL: ${DATABASE_URL}
    REDIS_URL:    ${REDIS_URL}
    R2_ENDPOINT_URL: http://minio:9000
    R2_ACCESS_KEY_ID: ${MINIO_ROOT_USER}
    R2_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD}
    R2_BUCKET_NAME: ${R2_BUCKET_NAME:-mike}
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
    GEMINI_API_KEY:    ${GEMINI_API_KEY:-}
    OPENAI_API_KEY:    ${OPENAI_API_KEY:-}
    SENTRY_DSN:        ${SENTRY_DSN:-}
    WORKER_QUEUES:     "pdf-ingest,embeddings,llm-call,report-gen,notify,cleanup"
  deploy:
    replicas: 2
  networks: [mike-internal]
```

---

## 8. Observability

- **GlitchTip** captures unhandled exceptions in workers (same DSN, tag `service=worker`, `queue=<name>`)
- **Bull-Board** at `/admin/queues` — jobs per queue: active, waiting, completed, failed, delayed
- **Worker logs** — structured JSON, shipped via the same pipeline as backend
- **Metrics (Phase 2)** — `/metrics` per worker, Prometheus scrape, dashboards for queue depth, throughput, failure rate, p95 job duration per queue
- **Alerts** — DLQ depth > 10, queue depth > 100 for > 5 min, worker restart loop

---

## 9. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Job processor not idempotent → duplicate side effects on retry | High | High | Idempotency key per job; check-before-write before mutating Postgres/MinIO |
| Redis OOM under burst | Medium | High | `maxmemory-policy noeviction`, alert on memory > 70 %, Phase 2 splits queue Redis from cache Redis |
| Workers and backend drift on schema/env | Medium | Medium | Same image, same env anchor, same migrations container |
| Bull-Board admin route exposed without auth | Low | Critical | Mount behind GoTrue admin check, never exposed via public nginx |
| Dead-letter queue grows silently | Medium | Medium | DLQ depth alert + weekly DLQ review in ops cadence |
| Runaway LLM retries → cost surprise | Medium | High | Per-queue retry cap; `llm-call` jobs carry a cost budget and refuse if exceeded |
| Long jobs lost on worker SIGTERM | Medium | Medium | BullMQ graceful shutdown, lock-extend heartbeat, idempotent processors |

---

## 10. Open questions

- Which is the highest-pain endpoint we should migrate first? *(Candidate: `POST /files/:id/analyze`)*
- Do we want per-tenant fairness scheduling in Phase 2 to prevent one large customer starving others?
- `report-gen` engine — Puppeteer (heavy, accurate) vs lighter template renderer?
- Alert vs auto-scale threshold for queue depth?
- Phase 2 worker host — Hetzner CX32, AWS t3.large, or DO droplet? Cost vs latency vs ops familiarity.
- Do we centralize `glitchtip-worker` and our new app workers on the same secondary host, or separate?

---

## 11. Out of scope (explicit)

- Replacing GoTrue, PostgREST, or any existing service
- Multi-region deployment
- GPU workloads (we use hosted LLMs)
- Stream processing / real-time ML
- Replacing GlitchTip

---

## 12. Decision needed

Approve **Phase 1** to proceed → branch `feature/distributed-workers` → PR within 1 week.

Phases 2 and 3 are committed in principle but gated on **Phase 1 stability for ≥ 2 weeks in production**.

---

## Appendix A — Why not the alternatives

- **Celery** — Python worker process. We're a Node shop. Code reuse with backend wins.
- **RabbitMQ + amqplib direct** — we'd write our own retry, DLQ, and dashboard. BullMQ gives all three.
- **AWS SQS** — managed dependency, weaker dashboard, slower. Reasonable when we go multi-region.
- **Temporal** — excellent but heavyweight (separate Temporal server, learning curve). Right call for complex workflows; overkill for "run this OCR job".
- **AWS burst GPU** — no GPU work to burst. Inference is hosted. Discussed and dismissed.

## Appendix B — Precedent

`Exp_dental`'s `docker-compose.yml` (branch `poly_updates`) implements an identical pattern with Celery: `worker_segmentation`, `worker_crown_generation`, `worker_decimation`, `worker_marginline` all consume named queues from RabbitMQ, with `flower` as the dashboard equivalent of Bull-Board. The architecture proposed here is the Node-ecosystem expression of the same proven shape.
