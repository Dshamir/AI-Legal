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

### Deployment Progression

Mike's deployment path from single-server to production cluster:

```
Docker Compose (current)
    ↓  single host, 11 services, ./ailegal.sh orchestration
k3s (bridge)
    ↓  single-node K8s, same hardware, K8s API, KEDA-ready
Helm Charts (production)
    ↓  multi-node clusters, managed K8s (EKS/GKE/AKS)
```

| Priority | Item                                                                                                                                                                                                       | Depends On                               | Status  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------- |
| Medium   | **k3s deployment manifests** — Translate Docker Compose into k3s-compatible manifests. Single binary install, runs on a $20 VPS, same K8s API as full clusters. Bridge between Compose and production K8s. | Distributed Workers Phase 2              | Planned |
| Medium   | **Helm chart** (`helm/`) — Parameterized chart with `values.yaml` for all 11+ services. Supports `helm install mike ./helm` on any K8s cluster. Configurable replicas, resource limits, ingress, TLS.      | k3s manifests validated                  | Planned |
| Low      | **KEDA ScaledObjects** — Autoscale worker pods based on Redis queue depth. Workers scale to zero when idle, spin up on demand.                                                                             | Helm chart + Distributed Workers Phase 3 | Planned |
| Low      | **Terraform modules** — Infrastructure-as-code for cloud provisioning (VPC, RDS, ElastiCache, S3, EKS). One `terraform apply` for a production-ready cloud stack.                                          | Helm chart                               | Planned |

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

## Foundation: Plugin & MCP Architecture

> This is the architectural direction that gates all proposed upgrades below. Build the platform layer first, then every new feature plugs in rather than being bolted on.

Mike's core stays lean — documents, projects, chat, workflows, tabular reviews. Everything else is extensible through three mechanisms:

### MCP Server (Mike exposes its capabilities)

Mike runs an MCP-compliant server so any MCP client (Claude Code, Cursor, custom agents, external tools) can programmatically:

- Search and retrieve documents, projects, and chat history
- Trigger document analysis and comparison
- Query tabular review data
- Execute workflows

**Interface:** Standard MCP SSE transport, authenticated via GoTrue JWT, exposed at `/mcp/`.

### MCP Client (Mike consumes external services)

Mike connects to external MCP servers for capabilities it doesn't own:

| External MCP Server   | Capability                                                |
| --------------------- | --------------------------------------------------------- |
| `tfai-vault`          | Credential management, API key vault, operator onboarding |
| Legal databases       | Case law lookup, citation verification                    |
| Enterprise connectors | Slack, email, calendar integrations                       |

### Plugin System

Plugins register through a standardized interface — backend routes, frontend pages, MCP tools, and worker queues. No core code changes required to add a plugin.

| Plugin                      | What it provides                                                          | Source                                                                                             |
| --------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@mike/knowledge-base`      | Article management, categories, search, markdown editor                   | [`proposed-upgrades/KB-to add/`](proposed-upgrades/KB-to%20add/)                                   |
| `@mike/custom-agents`       | Agent builder, provider binding, prompt tuning, skills, test harness      | [`proposed-upgrades/KB-to add/custom-agents/`](proposed-upgrades/KB-to%20add/custom-agents/)       |
| `@mike/prompt-templates`    | Reusable prompt library with `{{variables}}`, test execution              | [`proposed-upgrades/KB-to add/prompt-templates/`](proposed-upgrades/KB-to%20add/prompt-templates/) |
| `@mike/ai-settings`         | Named providers, per-provider rate limits, cost tracking, usage dashboard | [`proposed-upgrades/KB-to add/ai-settings/`](proposed-upgrades/KB-to%20add/ai-settings/)           |
| `@mike/mission-dashboard`   | MCP audit log viewer, operator tracking, vault KPIs                       | [`proposed-upgrades/mission-dashboard/`](proposed-upgrades/mission-dashboard/)                     |
| `@mike/distributed-workers` | BullMQ queues, Bull-Board dashboard, worker fleet                         | See [Distributed CPU Workers](#proposed-upgrade-distributed-cpu-workers)                           |

### Phased Rollout

| Phase                          | Goal                       | Scope                                                                     |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------- |
| **Phase 1** — Plugin Interface | Define plugin contract     | Route registration, UI page mounting, MCP tool declaration, config schema |
| **Phase 2** — MCP Server       | Mike as MCP provider       | SSE transport, tool definitions for documents/projects/chat/workflows     |
| **Phase 3** — MCP Client       | Mike consumes external MCP | Credential vault integration, external knowledge sources                  |
| **Phase 4** — Plugin Registry  | Install/uninstall plugins  | Plugin manifest, dependency resolution, admin UI for plugin management    |

---

## Proposed Upgrade: LLM Compute Providers

Extend Mike's existing multi-LLM provider abstraction (`backend/src/lib/llm/`) to support self-hosted models and cloud GPU compute alongside the current hosted API providers.

### Local LLM Support (Ollama / vLLM)

Run inference on local hardware — fully air-gapped, zero API costs, full data sovereignty.

| Component  | Role                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ollama** | Drop-in local inference server. Single binary, runs quantized models (Llama, Mistral, Phi, Qwen). Best for development and small deployments. |
| **vLLM**   | Production-grade serving with continuous batching, PagedAttention, OpenAI-compatible API. Best for multi-user deployments with GPU hardware.  |

**Integration:** Both expose OpenAI-compatible `/v1/chat/completions` endpoints. Mike's provider abstraction already supports OpenAI — local LLMs register as a provider with a local `baseUrl` (e.g., `http://ollama:11434/v1`). No new code path required.

**Docker Compose addition:**

```yaml
ollama:
  image: ollama/ollama
  volumes: [ollama-models:/root/.ollama]
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: all
            capabilities: [gpu]
```

**Model management:** Pull models via `./ailegal.sh llm:pull <model>`, list with `./ailegal.sh llm:list`, switch per-user in Account settings.

### AWS GPU Compute

Burst to cloud GPUs for heavy workloads (large document batches, fine-tuning, embedding generation at scale) without maintaining local GPU hardware.

| Option                        | Use Case                                          | Integration                                                         |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| **AWS Bedrock**               | Managed inference (Claude, Llama, Mistral on AWS) | OpenAI-compatible via Bedrock runtime SDK. Registers as a provider. |
| **SageMaker Endpoints**       | Custom/fine-tuned models                          | Deploy custom model, expose as endpoint, register `baseUrl` in Mike |
| **EC2 GPU Instances** (g5/p4) | Self-managed vLLM on cloud GPU                    | Same vLLM integration as local, just remote `baseUrl`               |
| **Lambda + EFS**              | Serverless inference for bursty workloads         | Triggered via BullMQ worker queue (requires distributed workers)    |

**Architecture with distributed workers:**

```
User request → Backend (enqueue) → Redis/BullMQ
                                       ↓
                              ┌────────────────────┐
                              │   Worker Fleet      │
                              ├────────────────────┤
                              │ Local Ollama/vLLM  │ ← dev / small
                              │ AWS Bedrock        │ ← managed cloud
                              │ SageMaker endpoint │ ← custom models
                              │ EC2 GPU (vLLM)     │ ← heavy batch
                              └────────────────────┘
```

**Cost control:** Route by model size and urgency. Small queries → local Ollama (free). Large batch jobs → AWS GPU (pay per use). The AI Settings plugin provides cost tracking and budget alerts per provider.

**Status:** Depends on Plugin & MCP Architecture (Phase 1) and optionally Distributed CPU Workers (for async GPU dispatch).

---

## Future Considerations

These are longer-term ideas under evaluation — not yet committed to the roadmap.

- **Multi-tenant support** — workspace isolation, per-tenant billing, admin dashboard
- **Collaborative editing** — real-time multi-user document annotation (CRDT-based)
- **Client portal** — read-only external access for clients to review documents
- **SSO/SAML** — enterprise auth (Okta, Azure AD) alongside GoTrue
- **RAG pipeline** — vector embeddings + semantic search over document corpus
- **Clause library** — extract, tag, and reuse standard clauses across contracts
- **Mobile app** — React Native companion for document review on the go
