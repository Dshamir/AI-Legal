# Changelog

## [Unreleased] — 2026-05-24

### Docker & Deployment Fixes

- Fixed GoTrue `auth` schema creation — added `docker/postgres/00-init-auth-schema.sql` init script that creates the `auth` schema and `postgres` role on first boot
- Fixed GoTrue migration failure — added `search_path=auth` to GoTrue DB connection string so unqualified type creates land in the correct schema
- Fixed GlitchTip database — added `docker/postgres/01-create-glitchtip-db.sh` to auto-create the `glitchtip` database
- Fixed backend crash in Docker — `NODE_ENV` defaulted to `development` in docker-compose, causing `pino-pretty` import failure in production image; changed default to `production`
- Fixed Prisma 7.x client engine — installed `@prisma/adapter-pg` and `pg` driver, wired `PrismaPg` adapter into `prisma.ts`
- Fixed frontend Docker binding — added `HOSTNAME: "0.0.0.0"` env var so Next.js standalone binds to all interfaces, not just container IP
- Fixed all Docker healthchecks — switched from `localhost` to `127.0.0.1` (IPv6 resolution failure), switched GlitchTip from `wget` to Python `urllib`, disabled PostgREST healthcheck (distroless image has no shell)
- Fixed nginx healthcheck port — corrected from port 3000 to port 80
- Added `.dockerignore` for frontend (7.2 GB `node_modules` was being sent as Docker context) and backend (2.5 GB)
- Removed stale `backend/.env` with Prisma placeholder `DATABASE_URL` that overrode the root `.env` in Docker Compose

### Auth & Networking

- Fixed CORS on GoTrue auth — proxied GoTrue through nginx at `/auth/v1/` (rewrite to `/`) so browser auth requests are same-origin; changed `NEXT_PUBLIC_SUPABASE_URL` from `http://localhost:9999` to `http://localhost`
- Rewrote `auth.ts` middleware — replaced Supabase JS client (which prepends `/auth/v1/` path not supported by self-hosted GoTrue) with direct `fetch` to GoTrue's `/user` endpoint
- Added ngrok tunnel support — `mike-ngrok` container with `--add-host=host.docker.internal:host-gateway` for WSL2 compatibility; added `https://ailegal.ngrok.dev` to `GOTRUE_URI_ALLOW_LIST`

### Bug Fixes

- Fixed document context loading in chat — `buildDocContext()` had camelCase/snake_case mismatch: Prisma returns `currentVersionId`/`fileType` but code cast to `current_version_id`/`file_type` via `as unknown as`, causing all documents to be skipped with `storage_path = undefined`
- Fixed MinIO bucket creation — added `mc mb local/mike` on first boot (bucket did not exist)
- Fixed PgAdmin startup — changed `PGADMIN_DEFAULT_EMAIL` from `admin@mike.local` (rejected by newer pgAdmin email validation) to `admin@localhost.dev`

### Security Hardening (Upstream PR Integration)

- Added LLM prompt injection defense — `sanitizeLlmInput()` strips control characters, collapses newlines, and truncates untrusted filenames before system prompt interpolation (PR #158)
- Fixed timing oracle in HMAC download token verification — buffers now padded to equal length before `timingSafeEqual` (PR #81)
- Added HKDF per-row salt for user API key encryption — new keys use `crypto.hkdfSync` with random 16-byte salt; existing rows decrypt via legacy SHA-256 path (PR #76)
- Fixed case-insensitive email comparison in `GET /projects/:projectId` shared-with check (PR #79)
- Added Row-Level Security deny-all policy on all public tables with auto-enable event trigger for future tables — blocks direct PostgREST data access (PR #145)
- Added 180-second SSE stream timeout via `Promise.race` — stalled LLM calls no longer hold connections open indefinitely (PR #112)
- Capped `POST /download-zip` at 50 documents to prevent memory exhaustion (PR #111)

### Features

- Added `GET /chat` cursor pagination with `?before=` (ISO timestamp) keyset pagination, default limit 50 (PR #110)
- Added Zod validation middleware on `POST /projects/:projectId/chat` request body (PR #155)
- Wired up monthly message credit enforcement — `checkCredits()` before LLM call (429 if exceeded), `incrementCredits()` after success, auto-reset on expiry (PR #157)
- Added `GET /workflows/:id/export` and `POST /workflows/import` for portable `.mikeworkflow.json` transfer (PR #59)

---

## [0.1.0] — 2026-05-23

### Phase 1: Docker & Orchestration

- Added `docker-compose.yml` with 11 services (Postgres, Redis, MinIO, GoTrue, PostgREST, pgAdmin, GlitchTip, backend, frontend, Nginx)
- Added `ailegal.sh` orchestration script with 20+ commands (up, down, build, health, status, db:\*, test, lint, bump, clean, nuke)
- Added multi-stage Dockerfiles for backend (with LibreOffice) and frontend (standalone Next.js)
- Added Nginx reverse proxy with upstream routing and rate limiting
- Added `.editorconfig`, `.dockerignore`, consolidated `.env.example`

### Phase 2: Backend Hardening

- Added Zod request validation framework with common schemas
- Added global error handler with RFC 7807 Problem Details responses
- Added Pino structured logging with sensitive field redaction (replaced all console.\* calls)
- Added GlitchTip/Sentry error tracking integration
- Added magic-byte MIME file type validation for uploads
- Enabled Content Security Policy headers via Helmet
- Added request ID middleware (X-Request-ID propagation)

### Phase 3: Database Evolution

- Initialized Prisma ORM with complete schema (17 models, 7 enums)
- Migrated all route files and libraries from Supabase SDK to Prisma queries
- Added soft-delete extension for projects, documents, chats, workflows, reviews
- Added `audit_log` table and audit logging utility
- Added `updated_at` auto-update triggers on all mutable tables
- Added database enum constraints (Visibility, UserTier, DocumentStatus, etc.)
- Fixed user_id type consistency across all tables
- Added Prisma seed script for development data

### Phase 4: Frontend Hardening

- Added Next.js auth middleware for route protection (redirects unauthenticated users)
- Added GlitchTip/Sentry frontend error tracking
- Added skip-to-content accessibility link
- Added `@next/bundle-analyzer` for bundle analysis
- Added `@sentry/nextjs` for error tracking

### Phase 5: Testing & CI/CD

- Added Vitest test framework with 17 initial tests (auth, error handler, validation)
- Added GitHub Actions CI pipeline (lint, build matrix Node 20/22, test)
- Added Husky pre-commit hooks with lint-staged
- Added Prettier configuration for consistent formatting

### Phase 6: Caching & Performance

- Added Redis client with cache-aside helpers (get, set, delete)
- Added HTTP Cache-Control header middleware
- Added encryption key rotation support (V1 → V2 seamless migration)
