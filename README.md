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

Mike is a self-hosted legal document assistant with a Next.js frontend, Express backend, PostgreSQL (via Prisma ORM), GoTrue authentication, MinIO object storage, Redis caching, and GlitchTip error tracking. All 11 services are containerized and managed by a single orchestration script.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` — Next.js 16 application (React 19, Tailwind CSS 4)
- `backend/` — Express REST API with Prisma ORM, Pino logging, Zod validation
- `backend/prisma/schema.prisma` — database schema (17 models, 7 enums)
- `nginx/` — reverse proxy configuration
- `ailegal.sh` — orchestration script for all services
- `docker-compose.yml` — 11-service container stack

## Quick Start (Docker)

```bash
# 1. Clone and configure
git clone https://github.com/Dshamir/AI-Legal.git
cd AI-Legal
cp .env.example .env
# Edit .env — add at least one LLM provider key (Anthropic, Gemini, or OpenAI)

# 2. Start everything
./ailegal.sh up

# 3. Open http://localhost
```

Sign up, add an API key in **Account > Models & API Keys** if not set in `.env`, then create a project and start chatting with documents.

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

## Orchestration (`ailegal.sh`)

```bash
./ailegal.sh up                # Start all services (health-waited)
./ailegal.sh down              # Stop all services
./ailegal.sh health            # Health check status table
./ailegal.sh status            # Service status with ports and uptime
./ailegal.sh logs [service]    # Tail logs (all or specific service)
./ailegal.sh shell <service>   # Open shell in container
./ailegal.sh build [service]   # Build containers
./ailegal.sh rebuild [service] # Force rebuild (no cache)
./ailegal.sh restart [service] # Restart service(s)

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

## Prerequisites

- Docker and Docker Compose
- At least one LLM provider API key: Anthropic, Google Gemini, or OpenAI

For development without Docker:

- Node.js 20+
- npm
- PostgreSQL 16
- Redis
- MinIO or S3-compatible storage
- LibreOffice (for DOC/DOCX to PDF conversion)

## Environment

Copy `.env.example` to `.env` at the repo root. The file is organized by service:

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

## Development Without Docker

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

## Database

Mike uses **Prisma ORM** with PostgreSQL.

```bash
# Run migrations
cd backend && npx prisma migrate dev

# Open visual editor
cd backend && npx prisma studio

# Seed development data
cd backend && npx prisma db seed

# Or via the orchestration script (Docker)
./ailegal.sh db:migrate
./ailegal.sh db:seed
./ailegal.sh db:studio
```

Schema: `backend/prisma/schema.prisma` — 17 models with soft-delete on projects, documents, chats, workflows, and reviews. All mutations are logged to an `audit_log` table.

## Testing

```bash
npm test --prefix backend       # Run Vitest (17 tests)
npm run lint --prefix frontend  # ESLint
```

CI runs automatically via GitHub Actions on push/PR to `main` (lint, build on Node 20/22, test).

Pre-commit hooks (Husky + lint-staged) auto-format staged files with Prettier.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        nginx (:80)                              │
│                     reverse proxy + rate limiting                │
├─────────┬──────────┬───────────┬────────────┬───────────────────┤
│  /      │  /api/   │  /rest/   │  /pgadmin/ │  /glitchtip/      │
│    │    │    │     │     │     │      │     │       │            │
│    ▼    │    ▼     │     ▼     │      ▼     │       ▼            │
│ frontend│ backend  │ postgrest │   pgadmin  │   glitchtip       │
│ (:3000) │ (:3001)  │ (:3002)   │   (:5050)  │   (:8000)         │
│         │          │           │            │       │            │
│ Next.js │ Express  │ Auto REST │  DB Admin  │   Error Tracking  │
│ React19 │ Prisma   │    API    │    GUI     │       │            │
│ Tailwind│ Zod,Pino │           │            │   glitchtip-worker│
└─────────┴────┬─────┴─────┬─────┴──────┬─────┴───────┬───────────┘
               │           │            │             │
        ┌──────┴───────────┴────────────┴─────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│                      Data Layer                               │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │  postgres     │  │    redis     │  │      minio       │    │
│  │  (:5432)      │  │   (:6379)    │  │  (:9000/:9001)   │    │
│  │              │  │              │  │                  │    │
│  │ PostgreSQL 16 │  │   Cache &    │  │  S3-compatible   │    │
│  │ Prisma ORM    │  │   Sessions   │  │  Object Storage  │    │
│  │ 17 models     │  │              │  │  Documents, PDFs │    │
│  │ Soft-delete   │  │              │  │                  │    │
│  │ Audit trail   │  │              │  │                  │    │
│  └──────────────┘  └──────────────┘  └──────────────────┘    │
│                                                               │
│  ┌──────────────┐                                             │
│  │   gotrue      │                                             │
│  │  (:9999)      │                                             │
│  │              │                                             │
│  │ JWT Auth      │                                             │
│  │ Supabase-     │                                             │
│  │ compatible    │                                             │
│  └──────────────┘                                             │
└───────────────────────────────────────────────────────────────┘

LLM Providers (external APIs):
  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │  Anthropic  │  │   Google   │  │   OpenAI   │
  │   Claude    │  │   Gemini   │  │  GPT/o-ser │
  └────────────┘  └────────────┘  └────────────┘
```

**Backend stack**: Express, Prisma ORM, Zod validation, Pino structured logging, Helmet (CSP), rate limiting, HMAC-signed downloads, AES-256 encrypted user API keys with key rotation, magic-byte MIME file validation.

**Frontend stack**: Next.js 16 App Router, React 19, Tailwind CSS 4, shadcn/ui, Tiptap editor, Recharts, React Compiler. Auth middleware protects routes. GlitchTip/Sentry for error tracking.

**Multi-LLM support**: Anthropic Claude, Google Gemini, OpenAI — switchable per request via provider abstraction layer.

## Troubleshooting

**Services won't start.** Run `./ailegal.sh health` to see which service is unhealthy. Check logs with `./ailegal.sh logs <service>`.

**Sign-up confirmation email never arrives.** Set `GOTRUE_MAILER_AUTOCONFIRM=true` in `.env` for local development (auto-confirms all sign-ups).

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or set it in `.env` and restart: `./ailegal.sh restart backend`.

**DOC or DOCX conversion fails.** LibreOffice is included in the Docker backend image. For non-Docker development, install LibreOffice locally.

**Database needs reset.** Run `./ailegal.sh nuke` for a full teardown, rebuild, and reseed.

## License

AGPL-3.0-only
