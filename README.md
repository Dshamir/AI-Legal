# Mike

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![CI](https://github.com/Dshamir/AI-Legal/actions/workflows/ci.yml/badge.svg)](https://github.com/Dshamir/AI-Legal/actions/workflows/ci.yml)

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-4-3E67B1?logo=zod&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-4-6E9F18?logo=vitest&logoColor=white)
![MinIO](https://img.shields.io/badge/MinIO-S3_Compatible-C72E49?logo=minio&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-Reverse_Proxy-009639?logo=nginx&logoColor=white)
![Pino](https://img.shields.io/badge/Pino-Structured_Logging-687634)
![MCP](https://img.shields.io/badge/MCP-Ready-8B5CF6)

**Mike** is a self-hosted, open-source legal document assistant. Upload contracts, analyze clauses, compare documents side-by-side, run reusable workflows, and chat with your documents using AI — all on infrastructure you own.

Website: [mikeoss.com](https://mikeoss.com)

---

## Key Features

- **AI Document Chat** — Ask questions about uploaded documents with streaming responses. Supports Claude, Gemini, and OpenAI with per-user API key management.
- **Tabular Reviews** — Spreadsheet-style multi-document comparison and analysis.
- **Workflows** — Reusable automation templates for contract review, clause extraction, and document analysis.
- **Document Management** — Upload, version, organize into projects and subfolders. DOC/DOCX auto-converted to PDF.
- **Project Sharing** — Share projects with collaborators via email-based access control.
- **Rich Editor** — Tiptap-powered markdown editor with document annotations.
- **Self-Hosted** — Every service runs on your hardware. No cloud dependencies. Full data sovereignty.

---

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/Dshamir/AI-Legal.git
cd AI-Legal
cp .env.example .env
# Edit .env — add at least one LLM provider key (Anthropic, Gemini, or OpenAI)

# 2. Start all 11 services
./ailegal.sh up

# 3. Open http://localhost
```

Sign up, add an API key in **Account > Models & API Keys** if not set in `.env`, then create a project and start chatting with documents.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            nginx (:80)                                    │
│                   reverse proxy + rate limiting                            │
├──────────┬───────────┬────────────┬─────────────┬────────────────────────┤
│    /     │   /api/   │   /rest/   │  /pgadmin/  │     /glitchtip/         │
│    │     │     │     │      │     │      │      │          │              │
│    ▼     │     ▼     │      ▼     │      ▼      │          ▼              │
│ frontend │  backend  │  postgrest │   pgadmin   │      glitchtip          │
│ (:3000)  │  (:3001)  │  (:3002)   │   (:5050)   │      (:8000)           │
│          │           │            │             │          │              │
│ Next.js  │  Express  │  Auto REST │   DB Admin  │    Error Tracking       │
│ React 19 │  Prisma   │    API     │     GUI     │          │              │
│ Tailwind │  Zod,Pino │            │             │   glitchtip-worker      │
├──────────┴─────┬─────┴──────┬─────┴───────┬─────┴──────────┬─────────────┤
│                │            │             │                │              │
│                ▼            ▼             ▼                ▼              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                        Data Layer                                │    │
│  │                                                                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │    │
│  │  │  postgres    │  │    redis    │  │    minio    │              │    │
│  │  │  (:5432)     │  │   (:6379)   │  │(:9000/9001) │              │    │
│  │  │             │  │             │  │             │              │    │
│  │  │PostgreSQL 16│  │  Cache &    │  │S3-compatible│              │    │
│  │  │ Prisma ORM  │  │  Sessions   │  │Object Store │              │    │
│  │  │ 17 models   │  │             │  │ Docs, PDFs  │              │    │
│  │  │ Soft-delete │  │             │  │             │              │    │
│  │  │ Audit trail │  │             │  │             │              │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘              │    │
│  │                                                                  │    │
│  │  ┌─────────────┐                                                 │    │
│  │  │   gotrue     │                                                 │    │
│  │  │  (:9999)     │                                                 │    │
│  │  │ JWT Auth     │                                                 │    │
│  │  │ Supabase-    │                                                 │    │
│  │  │ compatible   │                                                 │    │
│  │  └─────────────┘                                                 │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘

                        LLM Providers
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │  Anthropic  │  │   Google   │  │   OpenAI   │
    │   Claude    │  │   Gemini   │  │    GPT     │
    └────────────┘  └────────────┘  └────────────┘

                  Future: Plugin & MCP Layer
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │  Ollama /   │  │ AWS Bedrock│  │  MCP Tools │
    │   vLLM      │  │ SageMaker  │  │  Plugins   │
    │  (local)    │  │  (cloud)   │  │  (extend)  │
    └────────────┘  └────────────┘  └────────────┘
```

### Backend

Express REST API with TypeScript (CommonJS). Entry point: `backend/src/index.ts`.

| Layer          | Technology                                              | Purpose                                                     |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| ORM            | Prisma 7                                                | 17 models, 7 enums, soft-delete extension, audit trail      |
| Validation     | Zod 4                                                   | Request validation middleware with RFC 7807 error responses |
| Logging        | Pino                                                    | Structured JSON logging with sensitive field redaction      |
| Security       | Helmet (CSP), express-rate-limit, HMAC-signed downloads | Request hardening                                           |
| Encryption     | AES-256-GCM                                             | User API keys encrypted at rest with key rotation (V1/V2)   |
| Upload         | Multer + file-type                                      | Magic-byte MIME validation (not just extension checking)    |
| Conversion     | LibreOffice                                             | DOC/DOCX to PDF server-side conversion                      |
| Error tracking | GlitchTip/Sentry                                        | Self-hosted, Sentry-compatible error capture                |

### Frontend

Next.js 16 App Router with React 19.

| Layer          | Technology                           | Purpose                                  |
| -------------- | ------------------------------------ | ---------------------------------------- |
| Styling        | Tailwind CSS 4, shadcn/ui (New York) | Utility-first CSS with component library |
| Icons          | Lucide                               | Consistent icon set                      |
| Editor         | Tiptap 3                             | Rich text editing with markdown support  |
| Charts         | Recharts 3                           | Data visualization for analytics         |
| Auth           | Middleware + GoTrue                  | Route protection, JWT cookie validation  |
| Optimization   | React Compiler, standalone output    | Performance and bundle size              |
| Error tracking | GlitchTip/Sentry                     | Frontend error capture                   |

### LLM Integration

Provider abstraction layer (`backend/src/lib/llm/`) supporting:

- **Anthropic Claude** — claude-sonnet, claude-opus, claude-haiku
- **Google Gemini** — gemini-pro, gemini-flash
- **OpenAI** — gpt-4o, o-series

Switchable per request. Streaming via SSE. Function calling / tool use for document context retrieval. User-managed API keys encrypted with AES-256-GCM.

---

## Services

| Service              | Port        | Purpose                                  |
| -------------------- | ----------- | ---------------------------------------- |
| **nginx**            | 80          | Reverse proxy (single entry point)       |
| **frontend**         | 3000        | Next.js web application                  |
| **backend**          | 3001        | Express REST API                         |
| **postgres**         | 5432        | PostgreSQL 16 database                   |
| **gotrue**           | 9999        | Authentication (Supabase-compatible JWT) |
| **postgrest**        | 3002        | Auto-generated REST API over Postgres    |
| **minio**            | 9000 / 9001 | S3-compatible object storage + console   |
| **redis**            | 6379        | Caching layer                            |
| **pgadmin**          | 5050        | Database admin GUI                       |
| **glitchtip**        | 8000        | Error tracking (Sentry-compatible)       |
| **glitchtip-worker** | —           | Background job processor                 |

---

## Orchestration (`ailegal.sh`)

Single script to manage the full stack. Dynamic port allocation with conflict detection. ASCII banner on startup.

```bash
# Lifecycle
./ailegal.sh up                # Start all services (health-waited)
./ailegal.sh down              # Stop all services
./ailegal.sh restart [service] # Restart service(s)
./ailegal.sh build [service]   # Build containers
./ailegal.sh rebuild [service] # Force rebuild (no cache)

# Observability
./ailegal.sh health            # Three-layer health check table (container/docker/HTTP)
./ailegal.sh status            # Service status with ports and uptime
./ailegal.sh logs [service]    # Tail logs (all or specific service)
./ailegal.sh ports             # Port allocation table with conflict detection
./ailegal.sh smoke             # Curl-based smoke tests on all endpoints
./ailegal.sh shell <service>   # Open shell in container

# Database
./ailegal.sh db:migrate        # Run Prisma migrations
./ailegal.sh db:seed           # Seed development data
./ailegal.sh db:studio         # Open Prisma Studio
./ailegal.sh db:backup         # Backup to timestamped file
./ailegal.sh db:restore <file> # Restore from backup

# Quality
./ailegal.sh test              # Run Vitest test suite
./ailegal.sh lint              # Run linters

# Versioning
./ailegal.sh bump <type>       # Version bump (patch/minor/major) + git tag

# Reset
./ailegal.sh clean             # Remove containers and volumes
./ailegal.sh nuke              # Full reset: clean + rebuild + migrate + seed
```

---

## Prerequisites

**Docker (recommended):**

- Docker and Docker Compose
- At least one LLM provider API key: Anthropic, Google Gemini, or OpenAI

**Without Docker:**

- Node.js 20+
- PostgreSQL 16
- Redis 7
- MinIO or S3-compatible storage
- LibreOffice (for DOC/DOCX to PDF conversion)

---

## Environment

Copy `.env.example` to `.env` at the repo root. Organized by service:

| Section   | Key Variables                                                                      |
| --------- | ---------------------------------------------------------------------------------- |
| Postgres  | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`                               |
| GoTrue    | `GOTRUE_JWT_SECRET`, `GOTRUE_SITE_URL`, `GOTRUE_MAILER_AUTOCONFIRM`                |
| PostgREST | `PGRST_DB_URI`, `PGRST_JWT_SECRET`                                                 |
| MinIO     | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `R2_BUCKET_NAME`                         |
| Redis     | `REDIS_URL`                                                                        |
| Backend   | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DOWNLOAD_SIGNING_SECRET` |
| Frontend  | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_API_BASE_URL`                             |
| GlitchTip | `GLITCHTIP_SECRET_KEY`, `SENTRY_DSN`                                               |
| pgAdmin   | `PGADMIN_DEFAULT_EMAIL`, `PGADMIN_DEFAULT_PASSWORD`                                |

Provider keys can be configured globally in `.env` or per user in **Account > Models & API Keys**.

---

## Development

```bash
# Install
npm install --prefix backend
npm install --prefix frontend

# Start (separate terminals)
npm run dev --prefix backend    # Express on :3001 (tsx watch, auto-reloads)
npm run dev --prefix frontend   # Next.js on :3000

# Open http://localhost:3000
```

Requires a running PostgreSQL with `DATABASE_URL` set, plus MinIO/S3 and Redis if using those features.

### Database

Prisma ORM with PostgreSQL. 17 models, 7 enums, soft-delete on projects/documents/chats/workflows/reviews. All mutations logged to `audit_log`.

```bash
cd backend && npx prisma migrate dev    # Run migrations
cd backend && npx prisma studio         # Visual editor
cd backend && npx prisma db seed        # Seed data

# Or via Docker
./ailegal.sh db:migrate
./ailegal.sh db:seed
./ailegal.sh db:studio
```

### Testing

```bash
npm test --prefix backend       # Vitest
npm run lint --prefix frontend  # ESLint
```

CI runs automatically via GitHub Actions on push/PR to `main` (lint, build matrix Node 20/22, test). Pre-commit hooks (Husky + lint-staged) auto-format staged files with Prettier.

---

## Platform Roadmap

Mike is evolving from a document assistant into an extensible legal AI platform. The full roadmap is in [`ROADMAP.md`](ROADMAP.md).

### Plugin & MCP Architecture (Foundation)

The core stays lean. New capabilities are added through:

- **MCP Server** — Mike exposes documents, projects, chat, and workflows as MCP tools. Any MCP client (Claude Code, Cursor, custom agents) can interact programmatically.
- **MCP Client** — Mike consumes external MCP servers (credential vaults, legal databases, enterprise connectors).
- **Plugin System** — Standardized interface for registering routes, UI pages, MCP tools, and worker queues without modifying core code.

### Proposed Plugins

| Plugin              | Purpose                                               | Source                                                                                                               |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Knowledge Base      | Article management, search, markdown editor           | [`proposed-upgrades/KB-to add/`](proposed-upgrades/KB-to%20add/)                                                     |
| Custom Agents       | AI agent builder with prompt tuning, skills, bindings | [`proposed-upgrades/KB-to add/custom-agents/`](proposed-upgrades/KB-to%20add/custom-agents/)                         |
| Prompt Templates    | Reusable prompt library with `{{variables}}`          | [`proposed-upgrades/KB-to add/prompt-templates/`](proposed-upgrades/KB-to%20add/prompt-templates/)                   |
| AI Settings         | Named providers, rate limits, cost tracking           | [`proposed-upgrades/KB-to add/ai-settings/`](proposed-upgrades/KB-to%20add/ai-settings/)                             |
| Mission Dashboard   | MCP audit log, operator tracking, vault KPIs          | [`proposed-upgrades/mission-dashboard/`](proposed-upgrades/mission-dashboard/)                                       |
| Distributed Workers | BullMQ queues, Bull-Board, worker fleet               | [`proposed-upgrades/candidate-AI-Legal-distributed-CPU.md`](proposed-upgrades/candidate-AI-Legal-distributed-CPU.md) |

### LLM Compute Expansion

- **Local LLM** (Ollama/vLLM) — Air-gapped inference, zero API costs, full data sovereignty. OpenAI-compatible API, drops into the existing provider abstraction.
- **AWS GPU** (Bedrock, SageMaker, EC2) — Cloud burst for heavy batch workloads. Ties into distributed workers for async dispatch.

---

## Troubleshooting

**Services won't start.** Run `./ailegal.sh health` to see which service is unhealthy. Check logs with `./ailegal.sh logs <service>`.

**Sign-up confirmation email never arrives.** Set `GOTRUE_MAILER_AUTOCONFIRM=true` in `.env` for local development.

**Model picker shows missing-key warning.** Add a key in **Account > Models & API Keys**, or set in `.env` and restart: `./ailegal.sh restart backend`.

**DOC/DOCX conversion fails.** LibreOffice is included in the Docker image. For non-Docker dev, install it locally.

**Database needs reset.** Run `./ailegal.sh nuke` for full teardown, rebuild, and reseed.

**Port conflicts.** Run `./ailegal.sh ports` to see allocation status and detect conflicts.

---

## ⭐ Star History

<a href="https://star-history.com/#willchen96/mike&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=willchen96/mike&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=willchen96/mike&type=Date" />
    <img src="https://api.star-history.com/svg?repos=willchen96/mike&type=Date" alt="Star History Chart" width="80%" />
  </picture>
</a>

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Security vulnerabilities: use GitHub private vulnerability reporting, not public issues.

## License

AGPL-3.0-only
