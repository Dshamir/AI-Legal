# Roadmap

> Mike's development roadmap, organized by category and priority.
> Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Completed

- [x] Self-hosted Docker infrastructure (11 services, single orchestration script)
- [x] Backend hardening (Zod validation, RFC 7807 error handling, Pino structured logging)
- [x] Prisma ORM migration with soft-delete and audit trail (17 models, 7 enums)
- [x] Frontend route protection and accessibility baseline
- [x] CI/CD pipeline with GitHub Actions (lint, build matrix, test)
- [x] Redis caching infrastructure and AES-256 encryption key rotation
- [x] GlitchTip error tracking (backend + frontend)
- [x] Magic-byte MIME file validation for uploads
- [x] Pre-commit hooks (Husky + lint-staged + Prettier)

---

## In Progress

### Performance & Caching

| Priority | Item                                                                  | Status  |
| -------- | --------------------------------------------------------------------- | ------- |
| High     | Apply Redis cache-aside to project and document list endpoints        | Planned |
| High     | Fix N+1 queries in project listing with Prisma `_count` and `include` | Planned |
| Medium   | Add cache invalidation on write operations (create, update, delete)   | Planned |
| Low      | Response compression middleware (gzip/brotli)                         | Planned |

### Testing & Quality

| Priority | Item                                                           | Status  |
| -------- | -------------------------------------------------------------- | ------- |
| High     | E2E tests with Playwright (auth flow, document upload, chat)   | Planned |
| High     | Integration tests for route handlers with test database        | Planned |
| Medium   | Increase unit test coverage (currently 17 tests — target 80%+) | Planned |
| Medium   | Eliminate `as any` casts in Prisma JSON field handling         | Planned |
| Low      | Visual regression tests for UI components                      | Planned |

### Security & Access Control

| Priority | Item                                                   | Status  |
| -------- | ------------------------------------------------------ | ------- |
| High     | Per-user rate limiting (currently IP-only)             | Planned |
| Medium   | RBAC roles beyond owner/viewer for project sharing     | Planned |
| Medium   | API key scoping (read-only vs. read-write permissions) | Planned |
| Low      | Brute-force protection on auth endpoints               | Planned |

### Infrastructure & DevOps

| Priority | Item                                                                           | Status  |
| -------- | ------------------------------------------------------------------------------ | ------- |
| High     | Prometheus + Grafana monitoring stack                                          | Planned |
| Medium   | MinIO lifecycle policies for storage cleanup (expired uploads, orphaned files) | Planned |
| Medium   | Automated database backup schedule (cron)                                      | Planned |
| Medium   | Ngrok integration for external access tunneling                                | Planned |
| Low      | Container image size optimization (distroless base images)                     | Planned |
| Low      | Docker secrets for sensitive environment variables                             | Planned |

### API & Backend

| Priority | Item                                                        | Status  |
| -------- | ----------------------------------------------------------- | ------- |
| High     | API versioning (`/api/v1/` prefix) with deprecation headers | Planned |
| Medium   | WebSocket support for real-time chat streaming              | Planned |
| Medium   | Webhook system for external integrations                    | Planned |
| Low      | OpenAPI/Swagger spec generation from Zod schemas            | Planned |
| Low      | Request/response pagination envelope standardization        | Planned |

### Frontend & UX

| Priority | Item                                             | Status  |
| -------- | ------------------------------------------------ | ------- |
| High     | WCAG 2.1 AA accessibility audit with axe-core    | Planned |
| Medium   | Dark mode support                                | Planned |
| Medium   | Keyboard navigation for all interactive elements | Planned |
| Medium   | Offline-capable PWA shell with service worker    | Planned |
| Low      | i18n framework for multi-language support        | Planned |

---

## Proposed Upgrade: Distributed CPU Workers

> Full proposal: [`proposed-upgrades/candidate-AI-Legal-distributed-CPU.md`](proposed-upgrades/candidate-AI-Legal-distributed-CPU.md)

Move all long-running and CPU-heavy work (PDF/OCR ingestion, embedding generation, LLM calls, report rendering) off the web tier onto a distributed BullMQ worker fleet backed by Redis. Same image, different entrypoint — zero code drift.

**Why:** A single 200-page contract analysis currently starves the request path. Workers isolate blast radius, scale independently, and keep p95 web latency under 300 ms regardless of background load.

**Precedent:** Proven pattern from [Exp_dental](https://github.com/Dshamir/Exp_dental) Celery worker fleet (`worker_segmentation`, `worker_crown_generation`, etc.) — this is the Node-ecosystem expression of the same architecture.

### Phased Rollout

| Phase                      | Goal                           | Scope                                                                                                        | Effort  |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------- |
| **Phase 1** — Foundation   | Prove the pattern on same host | BullMQ queues, worker service in Docker Compose, Bull-Board dashboard, first endpoint migrated (PDF analyze) | ~3 days |
| **Phase 2** — Distribution | Workers on separate host       | TLS Redis, `docker-compose.workers.yml`, health/metrics endpoints, runbooks                                  | ~4 days |
| **Phase 3** — Autoscaling  | Scale to zero when idle        | k3s/KEDA, Redis stream length triggers, cost dashboard                                                       | ~5 days |

### Queue Topology

| Queue        | Latency Class | Concurrency | Workload                      |
| ------------ | ------------- | ----------- | ----------------------------- |
| `pdf-ingest` | 30 s – 5 min  | 1           | OCR + text extraction         |
| `embeddings` | 5 – 60 s      | 4           | Chunk, embed, upsert vectors  |
| `llm-call`   | 5 – 90 s      | 50          | Anthropic/Gemini/OpenAI calls |
| `report-gen` | 2 – 20 s      | 2           | PDF/DOCX report rendering     |
| `notify`     | < 2 s         | 20          | Email, webhook fan-out        |
| `cleanup`    | minutes       | 1           | Retention sweeps, orphan GC   |

**Status:** Awaiting Phase 1 approval. Gate: Phase 1 stable for 2+ weeks before Phase 2 begins.

---

## Future Considerations

These are longer-term ideas under evaluation — not yet committed to the roadmap.

- **Multi-tenant support** — workspace isolation, per-tenant billing, admin dashboard
- **Plugin system** — extensible document processors and analysis pipelines
- **Collaborative editing** — real-time multi-user document annotation (CRDT-based)
- **Audit log dashboard** — searchable UI for the existing audit trail
- **Self-hosted LLM support** — Ollama/vLLM integration for fully air-gapped deployments
- **Mobile app** — React Native companion for document review on the go
