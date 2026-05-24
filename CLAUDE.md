# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mike is an open-source legal document assistant (AGPL-3.0). It has a Next.js frontend, an Express backend, self-hosted PostgreSQL with GoTrue auth, MinIO (S3-compatible) storage, Redis caching, and GlitchTip error tracking. All services are containerized and orchestrated by `./ailegal.sh`. Website: mikeoss.com

## Common Commands

```bash
# Docker (preferred for full stack)
./ailegal.sh up              # Start all 11 services
./ailegal.sh down            # Stop all services
./ailegal.sh health          # Health check status table
./ailegal.sh logs backend    # Tail backend logs
./ailegal.sh db:migrate      # Run Prisma migrations
./ailegal.sh db:backup       # Backup database
./ailegal.sh test            # Run test suite
./ailegal.sh nuke            # Full reset + rebuild

# Direct (without Docker)
npm install --prefix backend
npm install --prefix frontend
npm run dev --prefix backend    # Express on :3001 (tsx watch)
npm run dev --prefix frontend   # Next.js on :3000

# Build
npm run build --prefix backend   # tsc → dist/
npm run build --prefix frontend  # next build

# Test
npm test --prefix backend        # Vitest

# Lint
npm run lint --prefix frontend
```

## Architecture

**Monorepo** with two independent apps, 11 Docker services:

- `backend/` — Express REST API (TypeScript, CommonJS). Node.js 20+.
- `frontend/` — Next.js 16 App Router (TypeScript, React 19).

### Backend

Entry point: `backend/src/index.ts` — Express server with Helmet (CSP enabled), CORS, Pino structured logging, request ID middleware, Zod validation, global error handler (RFC 7807).

**Routes** (`backend/src/routes/`):

- `chat.ts` / `projectChat.ts` — AI chat with streaming
- `tabular.ts` — spreadsheet-style multi-document comparison
- `documents.ts` — document CRUD, upload (with magic-byte MIME validation), versions
- `projects.ts` — project CRUD, sharing, folders
- `workflows.ts` — reusable automation templates
- `user.ts` — profile, API key management
- `downloads.ts` — secure document downloads with HMAC-signed tokens

**Libraries** (`backend/src/lib/`):

- `prisma.ts` — Prisma client with soft-delete extension
- `logger.ts` — Pino structured logger with sensitive field redaction
- `audit.ts` — Audit log utility (writes to `audit_log` table)
- `redis.ts` — Redis cache-aside helpers (get, set, delete)
- `validation.ts` + `validation/` — Zod schema validation middleware
- `errorTracking.ts` — GlitchTip/Sentry integration
- `keyRotation.ts` — AES-256 encryption key rotation (V1→V2), HKDF per-row salt derivation
- `sanitize.ts` — `sanitizeLlmInput()` for prompt injection defense (NFC normalize, strip control chars, collapse newlines)
- `streamTimeout.ts` — `withStreamTimeout()` wrapper for SSE stream timeout (180s default)
- `credits.ts` — `checkCredits()` / `incrementCredits()` for monthly message credit enforcement
- `llm/` — Provider abstraction (Claude, Gemini, OpenAI)
- `chatTools.ts` — Chat logic, document context, tool definitions
- `storage.ts` — S3/MinIO file operations
- `upload.ts` — Multer upload with magic-byte file type validation
- `convert.ts` — DOC/DOCX to PDF via LibreOffice

**Middleware** (`backend/src/middleware/`):

- `auth.ts` — JWT validation via GoTrue `getUser()`
- `errorHandler.ts` — Global error handler (RFC 7807 responses)
- `requestId.ts` — X-Request-ID propagation
- `cache.ts` — HTTP Cache-Control headers

### Frontend

Next.js App Router in `frontend/src/app/`:

- `middleware.ts` — Auth route protection (redirects unauthenticated users)
- `(pages)/` — route group: `assistant/`, `projects/`, `tabular-reviews/`, `workflows/`, `account/`
- `components/` — React components by feature area
- `hooks/` — custom hooks (`useAssistantChat.ts` for chat state)
- `lib/` — `mikeApi.ts` (backend API client), `errorTracking.ts` (GlitchTip)

UI stack: Tailwind CSS 4, shadcn/ui (New York style), Lucide icons, React Compiler.

### Database

PostgreSQL via **Prisma ORM**.

- Schema: `backend/prisma/schema.prisma` (17 models, 7 enums)
- Migrations: `npx prisma migrate dev` or `./ailegal.sh db:migrate`
- Seed: `npx prisma db seed` or `./ailegal.sh db:seed`
- Studio: `npx prisma studio` or `./ailegal.sh db:studio`
- Soft-delete enabled on: Project, Document, DocumentVersion, Chat, Workflow, TabularReview
- Audit trail: all create/update/delete operations logged to `audit_log` table

### Docker Services

| Service   | Port      | Purpose                |
| --------- | --------- | ---------------------- |
| postgres  | 5432      | PostgreSQL 16          |
| redis     | 6379      | Cache                  |
| minio     | 9000/9001 | S3-compatible storage  |
| gotrue    | 9999      | Auth (self-hosted JWT) |
| postgrest | 3002      | REST API over Postgres |
| pgadmin   | 5050      | Database admin GUI     |
| glitchtip | 8000      | Error tracking         |
| backend   | 3001      | Express API            |
| frontend  | 3000      | Next.js app            |
| nginx     | 80        | Reverse proxy          |

## Environment Setup

Copy `.env.example` to `.env` at the repo root. Key groups:

- Postgres credentials + `DATABASE_URL`
- GoTrue auth (`GOTRUE_JWT_SECRET`, `GOTRUE_SITE_URL`)
- MinIO/S3 storage credentials
- Redis URL
- LLM provider API keys (Anthropic/Gemini/OpenAI — at least one)
- GlitchTip DSN (for error tracking)

## Testing

- Framework: Vitest
- Run: `npm test --prefix backend` or `./ailegal.sh test`
- Test files: `backend/tests/` (40 tests across validation, middleware, and lib)
- CI: GitHub Actions (`.github/workflows/ci.yml`) — lint, build (Node 20/22), test

## Contribution Guidelines

- Keep PRs small and focused on one change.
- Pre-commit hooks run Prettier + lint-staged automatically.
- Do not propose local-hosting refactors (local LLMs, local databases, local filesystem storage).
- Only `NEXT_PUBLIC_`-prefixed variables are safe for browser exposure.
- Test with disposable infrastructure and synthetic documents (see `docs/safe-local-testing.md`).
- Security vulnerabilities: use GitHub private vulnerability reporting, not public issues.
