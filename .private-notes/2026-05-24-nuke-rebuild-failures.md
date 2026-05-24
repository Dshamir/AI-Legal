# Nuke & Rebuild Failure Log — 2026-05-24

## Context

User ran `./ailegal.sh nuke` to do a full reset. The build succeeded but the stack failed to start. A cascade of 12 failures were discovered and fixed over the session.

---

## Failure 1: Port 5432 Already Allocated

**Symptom:** `Bind for 0.0.0.0:5432 failed: port is already allocated`
**Root cause:** Stale `ai-legal-*` containers (old project name) were still running from 16 hours ago, holding ports 5432, 6379, 9000, 3002, 8000.
**Fix:** `docker stop` + `docker rm` all `ai-legal-*` containers, then removed their volumes and networks.
**Lesson:** The `nuke` command only cleans the `mike-*` project. Old project-name containers persist.

## Failure 2: GoTrue `auth` Schema Missing

**Symptom:** GoTrue fatal: `schema "auth" does not exist (SQLSTATE 3F000)`
**Root cause:** GoTrue expects a pre-existing `auth` schema in Postgres. A fresh volume (from nuke) has no schemas beyond `public`.
**Fix:** Created `docker/postgres/00-init-auth-schema.sql` mounted at `/docker-entrypoint-initdb.d/`, which runs `CREATE SCHEMA IF NOT EXISTS auth` on first boot.

## Failure 3: GoTrue `postgres` Role Missing

**Symptom:** GoTrue migration fatal: `role "postgres" does not exist (SQLSTATE 42704)`
**Root cause:** GoTrue's built-in migration grants permissions to the `postgres` role, but our DB user is `mike`.
**Fix:** Added `CREATE ROLE postgres SUPERUSER LOGIN` to the init script (idempotent check).

## Failure 4: GoTrue `factor_type` Enum in Wrong Schema

**Symptom:** GoTrue migration fatal: `type "auth.factor_type" does not exist`
**Root cause:** GoTrue migration `20221003` creates `factor_type` without a schema qualifier (lands in `public`), but migration `20240729` references `auth.factor_type`. Self-hosted GoTrue doesn't set `search_path`.
**Fix:** Added `&search_path=auth` to `GOTRUE_DB_DATABASE_URL` connection string so all unqualified creates land in `auth`.

## Failure 5: Backend `pino-pretty` Missing in Production

**Symptom:** `Error: unable to determine transport target for "pino-pretty"`
**Root cause:** `NODE_ENV` was `development` in docker-compose (`${NODE_ENV:-development}`), but the Docker image uses `npm ci --omit=dev` (no pino-pretty). The logger only loads pino-pretty when `NODE_ENV !== "production"`.
**Fix:** Changed docker-compose default from `development` to `production`.

## Failure 6: Prisma 7.x Client Engine Requires Adapter

**Symptom:** `PrismaClientConstructorValidationError: Using engine type "client" requires either "adapter" or "accelerateUrl"`
**Root cause:** Prisma 7.x with `provider = "prisma-client"` uses the client engine which needs a driver adapter. The project had no adapter installed.
**Fix:** Installed `@prisma/adapter-pg` + `pg`, wired `new PrismaPg(process.env.DATABASE_URL!)` into `prisma.ts`.

## Failure 7: Frontend Binds to Container IP, Not 0.0.0.0

**Symptom:** Healthcheck `wget -q --spider http://localhost:3000/` fails with "Connection refused", but `127.0.0.1:3000` works.
**Root cause:** Next.js standalone `server.js` binds to the container's assigned IP (e.g., `172.25.0.10:3000`) rather than `0.0.0.0`.
**Fix:** Added `HOSTNAME: "0.0.0.0"` to the frontend service environment in docker-compose.

## Failure 8: Docker Healthchecks — IPv6, Missing Binaries

**Symptom:** Multiple containers report `unhealthy` despite running services.
**Root cause:**

- `localhost` resolves to `::1` (IPv6) but services bind to IPv4 only → "Connection refused"
- GlitchTip image (Python-based) doesn't have `wget`
- PostgREST image (distroless) has no shell at all
  **Fix:**
- All healthchecks: `localhost` → `127.0.0.1`
- GlitchTip: `wget` → `python -c "import urllib.request; urllib.request.urlopen(...)"`
- PostgREST: disabled healthcheck (`test: ["NONE"]`)

## Failure 9: GlitchTip Database Missing

**Symptom:** GlitchTip unable to start — database `glitchtip` not found.
**Root cause:** docker-compose configures GlitchTip with `DATABASE_URL=...@postgres:5432/glitchtip` but only the `mike` database exists.
**Fix:** Created `docker/postgres/01-create-glitchtip-db.sh` init script.

## Failure 10: PgAdmin Email Validation

**Symptom:** pgAdmin crash loop: `'admin@mike.local' does not appear to be a valid email address`
**Root cause:** Newer pgAdmin validates email deliverability; `.local` TLD is rejected.
**Fix:** Changed `PGADMIN_DEFAULT_EMAIL` from `admin@mike.local` to `admin@localhost.dev`.

## Failure 11: Frontend `.dockerignore` Missing (7.2 GB Context)

**Symptom:** Docker build hangs for 15+ minutes during context transfer.
**Root cause:** No `.dockerignore` in `frontend/` — Docker sends the entire 7.2 GB `node_modules` directory as build context over WSL2's filesystem bridge.
**Fix:** Created `frontend/.dockerignore` and `backend/.dockerignore` excluding `node_modules`, `.next`, `dist`, `.env*`.

## Failure 12: `backend/.env` Overrides Root `.env`

**Symptom:** Backend container has `DATABASE_URL=postgresql://johndoe:randompassword@localhost:5432/mydb` — a Prisma placeholder.
**Root cause:** `backend/.env` (auto-generated by Prisma init) contained placeholder credentials. Docker Compose's `${DATABASE_URL}` resolution picks up the closest `.env` file, which was `backend/.env` overriding the root `.env`.
**Fix:** Deleted `backend/.env`, added it to `.gitignore`.

---

## Post-Nuke Failures (App Runtime)

## Failure 13: CORS on GoTrue Auth

**Symptom:** `Access-Control-Allow-Origin` header missing on `POST http://localhost:9999/auth/v1/signup`
**Root cause:** Browser at `localhost:3000` (or `:80`) is cross-origin to GoTrue at `localhost:9999`.
**Fix:** Proxied GoTrue through nginx at `/auth/v1/` with rewrite to strip the prefix. Changed `NEXT_PUBLIC_SUPABASE_URL` from `http://localhost:9999` to `http://localhost` (same origin).

## Failure 14: Auth Middleware — Supabase JS Client Path Mismatch

**Symptom:** All API calls return 401 `"Invalid or expired token"` even with valid JWT.
**Root cause:** The `@supabase/supabase-js` `createClient` prepends `/auth/v1/` to all auth requests. Self-hosted GoTrue serves at root (`/user`, `/token`, etc.), not `/auth/v1/user`. The backend's `admin.auth.getUser(token)` hit `http://gotrue:9999/auth/v1/user` → 404.
**Fix:** Replaced Supabase JS client with direct `fetch` to `${SUPABASE_URL}/user`.

## Failure 15: Database Tables Missing After `prisma db push`

**Symptom:** `relation "public.user_profiles" does not exist` — all DB operations fail.
**Root cause:** The `nuke` wiped all volumes (fresh DB), but migrations never ran because GoTrue was failing at that point. Tables were never created.
**Fix:** Ran `prisma db push` from the host after all other services stabilized.

## Failure 16: ngrok Tunnel — Container Can't Reach Host

**Symptom:** `ERR_NGROK_3200` (tunnel not found) or 502 Bad Gateway.
**Root cause:** `docker run ngrok/ngrok http 80` — inside the ngrok container, `localhost:80` is the container itself, not the host. On WSL2, `--net=host` doesn't work. The missing `--add-host=host.docker.internal:host-gateway` flag meant `host.docker.internal` wasn't resolvable.
**Fix:** `docker run --add-host=host.docker.internal:host-gateway ngrok/ngrok http host.docker.internal:80`

## Failure 17: MinIO Bucket Not Created

**Symptom:** `NoSuchBucket: The specified bucket does not exist` on document upload.
**Root cause:** MinIO starts empty — the `mike` bucket must be created after first boot.
**Fix:** `docker exec mike-minio-1 mc alias set local http://localhost:9000 ... && mc mb local/mike`

## Failure 18: Document Context Not Loading in Chat (THE BIG ONE)

**Symptom:** Chat attaches documents but LLM says "I'm unable to access the attached document." `[buildDocContext] available docs` is empty `[]` even though documents exist with `status = ready`.
**Root cause:** **camelCase/snake_case field mapping mismatch.** Prisma returns `{ currentVersionId, fileType }` (camelCase), but the code casts via `as unknown as { current_version_id, file_type }` (snake_case). The cast makes the fields silently `undefined`. Then `attachActiveVersionPaths()` checks `d.current_version_id` — always `undefined` — so `versionIds` is empty, every doc gets `storage_path = null`, and the `if (!doc.storage_path) continue` skips all documents.
**Fix:** Replaced unsafe `as unknown as` cast with explicit `.map()` that correctly maps `d.currentVersionId → current_version_id`, `d.fileType → file_type`. Applied to both `buildDocContext` and `buildProjectDocContext`.
**Lesson:** Never use `as unknown as` to cast between naming conventions. Always map fields explicitly. This bug was invisible — no errors, no warnings, just silent data loss.

---

## Summary

| #   | Category              | Severity | Time to Diagnose |
| --- | --------------------- | -------- | ---------------- |
| 1   | Stale containers      | Low      | 2 min            |
| 2   | GoTrue schema         | High     | 5 min            |
| 3   | GoTrue role           | High     | 3 min            |
| 4   | GoTrue search_path    | High     | 10 min           |
| 5   | NODE_ENV default      | Medium   | 5 min            |
| 6   | Prisma 7.x adapter    | High     | 10 min           |
| 7   | Frontend hostname     | Medium   | 5 min            |
| 8   | Healthcheck IPv6      | Medium   | 10 min           |
| 9   | GlitchTip DB          | Medium   | 3 min            |
| 10  | PgAdmin email         | Low      | 2 min            |
| 11  | .dockerignore         | Low      | 5 min            |
| 12  | backend/.env override | High     | 10 min           |
| 13  | CORS GoTrue           | High     | 10 min           |
| 14  | Auth path mismatch    | Critical | 15 min           |
| 15  | Missing tables        | Medium   | 3 min            |
| 16  | ngrok host mapping    | Medium   | 10 min           |
| 17  | MinIO bucket          | Low      | 2 min            |
| 18  | Doc context camelCase | Critical | 30 min           |

**Total:** 18 failures, ~2 hours to resolve. Failures 14 and 18 were the hardest — both involved silent mismatches with no error messages.
