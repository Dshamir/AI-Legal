# PRD: MARS MCP Server — Nexless Infrastructure Backbone

## Executive Summary

MARS MCP Server is a dedicated infrastructure service hosted on the MARS server that provides centralized credentials management, authentication, OTP (send + intercept), transactional email, Telegram notifications, and SMS gateway capabilities to the entire Nexless app portfolio via MCP protocol and REST API.

Every Nexless app integrates via a standardized client module (`@nexless/mars-client`) — one SDK, one connection, access to all infrastructure services.

**Host:** MARS server (dedicated, always-on)
**Network:** ngrok TCP tunnels
**Protocol:** MCP (primary) + REST (fallback)
**Hardware:** Sierra MC7700 LTE modem + SIM (+1 438 829 9035)
**First consumers:** Mike (legal AI), Marketing Engine (Paperclip), Claude Code sessions

---

## Problem Statement

Today across the Nexless portfolio:

1. **Credential sprawl** — same API keys duplicated across N apps' databases and .env files
2. **No provider health visibility** — blocked Gemini key silently breaks apps
3. **Manual 2FA** — Paperclip agents can't complete Facebook/Instagram logins because OTP codes require a human to read from a phone
4. **No centralized auth** — Mike uses GoTrue (fragile), Marketing Engine uses Keycloak, others use nothing
5. **No transactional email** — dependent on SendGrid/Resend for basic password resets and notifications
6. **No ops notifications** — no way to alert the operator when infrastructure breaks
7. **Every app reinvents** — each app builds its own auth, key management, notification system

---

## Architecture Overview

```
MARS Server (Dedicated Infrastructure Host)
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  VAULT   │  │   AUTH   │  │   OTP    │  │   MAIL     │  │
│  │  :8200   │  │  :8300   │  │  :8500   │  │  :2525     │  │
│  │          │  │          │  │          │  │  :8400 API  │  │
│  │ Creds    │  │ JWT      │  │ Send OTP │  │            │  │
│  │ Health   │  │ Login    │  │ Verify   │  │ SMTP out   │  │
│  │ Fallback │  │ Signup   │  │ TOTP     │  │ Templates  │  │
│  │ MCP      │  │ 2FA gate │  │ Intercpt │  │            │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │             │             │               │         │
│  ┌────┴─────────────┴─────────────┴───────────────┴──────┐  │
│  │                    POSTGRES                           │  │
│  │  schemas: vault | auth | otp | mail                   │  │
│  │  :5432 (internal only)                                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ SMS GATEWAY  │  │ TELEGRAM BOT │  │   ngrok TCP       │  │
│  │              │  │              │  │                   │  │
│  │ Sierra       │  │ Bot API      │  │ :8200 → vault     │  │
│  │ MC7700       │  │ Send msgs    │  │ :8300 → auth      │  │
│  │ + gammu-smsd │  │ Receive cmds │  │ :8500 → otp       │  │
│  │              │  │ Inline btns  │  │ :2525 → smtp      │  │
│  │ SEND + RECV  │  │ Ops alerts   │  │                   │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                         │
                    ngrok TCP tunnels
                         │
         ┌───────────────┼───────────────────────┐
         │               │                       │
    Dev Server      Deployed Apps           Claude Code
    (WSL2)          (anywhere)              (any session)
         │               │                       │
    ┌────┴────┐    ┌─────┴──────┐          ┌─────┴─────┐
    │  Mike   │    │ Marketing  │          │  MCP      │
    │  Node   │    │ Engine     │          │  Tools    │
    │  Fleet  │    │ Paperclip  │          │           │
    └─────────┘    └────────────┘          └───────────┘
         │               │                       │
    All use @nexless/mars-client SDK              │
    or MCP protocol directly ─────────────────────┘
```

---

## Services

### 1. VAULT — Credential Store + Provider Intelligence

Encrypted credential storage with health monitoring, fallback chains, and MCP access.

**Database: `vault` schema**

```sql
CREATE TABLE vault.credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,              -- 'anthropic', 'openai', 'gemini', 'sendgrid', 'twilio', 'meta', 'google_ads'
  scope           TEXT NOT NULL,              -- 'global', 'app:mike', 'user:<uuid>'
  key_name        TEXT NOT NULL,              -- 'ANTHROPIC_API_KEY', 'META_ACCESS_TOKEN'
  encrypted_value TEXT NOT NULL,
  iv              TEXT NOT NULL,
  auth_tag        TEXT NOT NULL,
  status          TEXT DEFAULT 'active',      -- 'active', 'blocked', 'expired', 'degraded', 'rotating'
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  last_health_check TIMESTAMPTZ,
  UNIQUE(provider, scope, key_name)
);

CREATE TABLE vault.access_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id   UUID REFERENCES vault.credentials(id),
  app_id          TEXT NOT NULL,
  action          TEXT NOT NULL,              -- 'read', 'rotate', 'create', 'delete', 'health_check', 'fallback'
  ip_address      TEXT,
  timestamp       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE vault.fallback_chains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          TEXT NOT NULL,
  purpose         TEXT NOT NULL,              -- 'chat', 'embedding', 'title_gen', 'image'
  chain           TEXT[] NOT NULL,            -- ['anthropic', 'openai', 'gemini']
  UNIQUE(app_id, purpose)
);
```

**Scope resolution order:** `user:<uuid>` > `app:<name>` > `global`

**Provider health monitor (every 5 minutes):**

- Anthropic: `POST /v1/messages` (minimal, catches auth errors)
- OpenAI: `GET /v1/models`
- Gemini: `GET /v1beta/models`
- SendGrid: `GET /v3/scopes`
- Twilio: `GET /2010-04-01/Accounts/{sid}`
- On status change → Telegram alert to operator

**Encryption:** AES-256-GCM + HKDF per-row salt. Vault master key in MARS `.env` only.

---

### 2. AUTH — Unified Authentication

Replaces GoTrue (Mike) and Keycloak (Marketing Engine) with a lightweight, shared auth service.

**Database: `auth` schema**

```sql
CREATE TABLE auth.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,              -- bcrypt
  display_name    TEXT,
  phone           TEXT,
  telegram_chat_id TEXT,
  totp_secret     TEXT,                       -- encrypted, for authenticator apps
  totp_enabled    BOOLEAN DEFAULT false,
  email_verified  BOOLEAN DEFAULT false,
  phone_verified  BOOLEAN DEFAULT false,
  status          TEXT DEFAULT 'active',      -- 'active', 'suspended', 'pending_verification'
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE auth.sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users(id),
  token_hash      TEXT NOT NULL,
  app_id          TEXT NOT NULL,              -- which app issued this session
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE auth.app_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          TEXT NOT NULL UNIQUE,
  token_hash      TEXT NOT NULL,              -- bcrypt hash of the app's MARS token
  permissions     TEXT[] DEFAULT '{}',        -- ['vault:read', 'otp:send', 'auth:verify', 'notify:telegram']
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

**JWT issuance:**

- `POST /auth/signup` → create user, send verification (email/SMS/Telegram)
- `POST /auth/login` → validate credentials, issue JWT
- `POST /auth/verify-otp` → 2FA gate before JWT issuance
- `GET /auth/user` → validate JWT, return user profile (replaces GoTrue's `/user`)
- `POST /auth/refresh` → refresh expired JWT

**Migration from GoTrue:** Mike points `SUPABASE_URL` at MARS auth service. The `/user` endpoint returns the same shape GoTrue does — Mike's `auth.ts` middleware works unchanged.

---

### 3. OTP — Send + Verify + Intercept

Three capabilities in one service:

#### 3A. OTP Send (Outbound)

Generate and send one-time codes for login verification.

```
Channel priority per user: TOTP > Telegram > SMS > Email

User has authenticator app → no outbound send needed
User has Telegram linked   → send via Bot API (instant, free)
User has phone verified    → send via Sierra MC7700 (free, 3-10s)
Fallback                   → send via Mail Server (free, 1-30s)
```

#### 3B. OTP Verify

```sql
CREATE TABLE otp.codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID,
  destination     TEXT NOT NULL,              -- phone number or email
  code            TEXT NOT NULL,              -- 6-digit code
  channel         TEXT NOT NULL,              -- 'sms', 'email', 'telegram'
  purpose         TEXT DEFAULT 'login',       -- 'login', 'verify_phone', 'verify_email', 'action_confirm'
  verified        BOOLEAN DEFAULT false,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

Codes expire after 5 minutes. Max 3 attempts per code. Rate limit: 1 code per 60 seconds per destination.

#### 3C. OTP Intercept (Inbound) — THE AUTOMATION FEATURE

The Sierra MC7700 receives ALL incoming SMS to +1 438 829 9035. `gammu-smsd` captures them and MARS parses OTP codes automatically.

```
Facebook sends "Your code is 847291" to +1 438 829 9035
  → Sierra MC7700 receives SMS
  → gammu-smsd RunOnReceive triggers parse script
  → Script extracts: sender="FACEBK", code="847291", raw_text="..."
  → Inserts into otp.intercepted_codes table
  → Paperclip agent calls: mars.otp.getInterceptedCode({ source: "facebook" })
  → Returns "847291"
  → Agent completes 2FA login — zero human touch
```

```sql
CREATE TABLE otp.intercepted_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender          TEXT NOT NULL,              -- raw sender ID: "FACEBK", "+1234567890", "Instagram"
  source_service  TEXT,                       -- normalized: 'facebook', 'instagram', 'google', 'twitter', etc.
  code            TEXT NOT NULL,              -- extracted numeric code
  raw_message     TEXT NOT NULL,              -- full SMS text
  consumed        BOOLEAN DEFAULT false,      -- true after an app reads it
  consumed_by     TEXT,                       -- app_id that consumed it
  received_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '10 minutes'
);
```

**Source detection patterns:**

```typescript
const SOURCE_PATTERNS: Record<string, RegExp[]> = {
  facebook: [/FACEBK/i, /Facebook/i, /FB-/i],
  instagram: [/Instagram/i, /IG:/i],
  google: [/Google/i, /G-/i],
  twitter: [/Twitter/i, /X:/i],
  amazon: [/Amazon/i, /AMZN/i],
  microsoft: [/Microsoft/i, /MSFT/i],
  whatsapp: [/WhatsApp/i],
  linkedin: [/LinkedIn/i],
  tiktok: [/TikTok/i],
};

const CODE_PATTERNS = [
  /\b(\d{4,8})\b/, // plain digits: 847291
  /code[:\s]+(\d{4,8})/i, // "code: 847291" or "code is 847291"
  /verification[:\s]+(\d{4,8})/i, // "verification code: 847291"
  /G-(\d{4,8})/, // Google format: G-847291
  /FB-(\d{4,8})/, // Facebook format: FB-847291
];
```

**gammu-smsd configuration:**

```ini
# /etc/gammu-smsdrc on MARS server
[gammu]
device = /dev/ttyUSB0
connection = at

[smsd]
service = sql
driver = native_pgsql
host = localhost
database = mars
user = mars
password = ${POSTGRES_PASSWORD}

RunOnReceive = /opt/mars/scripts/on-sms-received.sh
```

**`on-sms-received.sh`:**

```bash
#!/bin/bash
# Called by gammu-smsd with SMS_1_NUMBER (sender) and SMS_1_TEXT (body)
curl -s -X POST http://localhost:8500/internal/intercept \
  -H "Content-Type: application/json" \
  -d "{\"sender\": \"$SMS_1_NUMBER\", \"text\": \"$SMS_1_TEXT\"}"
```

---

### 4. MAIL — Transactional Email Server

Self-hosted SMTP for OTP codes, password resets, notifications. Not for bulk marketing (Marketing Engine keeps SendGrid for that).

**Software:** Haraka (Node.js SMTP server) — lightweight, plugin-based, same ecosystem as the rest of the stack.

**Capabilities:**

- Send transactional email (OTP, password reset, document share notifications)
- HTML templates with Handlebars
- DKIM signing for deliverability
- Bounce/complaint handling

**API:**

```
POST /mail/send
{
  to: "user@example.com",
  template: "otp",        // or "password_reset", "notification", "share_document"
  data: { code: "847291", app_name: "Mike" }
}
```

---

### 5. TELEGRAM BOT — Notifications + Commands + OTP

One bot that serves all apps.

**Bot name:** `@NexlessOpsBot` (or similar)

**Capabilities:**

| Category               | Examples                                                                    |
| ---------------------- | --------------------------------------------------------------------------- |
| **OTP delivery**       | "Your Mike login code: 847291"                                              |
| **Vault alerts**       | "Gemini API key blocked (403). Falling back to OpenAI."                     |
| **Health monitoring**  | "Mike backend unreachable since 10:42 AM"                                   |
| **Key rotation**       | "OpenAI key rotated. 3 apps refreshed."                                     |
| **Security alerts**    | "5 failed login attempts for dshamir@blucap.ca"                             |
| **Paperclip ops**      | "Marketing Engine: 108 agents active, 3 errors in last hour"                |
| **Approval workflows** | "[Approve] [Deny] — Send 5,000 emails to Carrot Sun list?"                  |
| **Daily digest**       | "Yesterday: 847 LLM calls ($12.40), all providers healthy, 2 key rotations" |

**Incoming commands (operator → bot → MARS):**

```
/health         — show all service status
/providers      — show vault provider health
/rotate <prov>  — trigger key rotation
/otp <phone>    — send test OTP
/codes          — show recent intercepted codes
/usage          — show credential usage stats
```

---

### 6. SMS GATEWAY — Sierra MC7700 + Gammu

**Hardware:** Sierra MC7700 Mini PCI-E LTE modem (+ Mini PCI-E to USB adapter if needed)
**SIM:** +1 438 829 9035 (dedicated for internet/SMS use)
**Software:** `gammu-smsd` daemon (background service)

**Capabilities:**

- **Send SMS** — OTP codes, alerts, notifications
- **Receive SMS** — intercept incoming OTPs from Facebook, Instagram, Google, etc.
- **Query inbox** — apps can query recent incoming messages
- **Auto-parse** — extract OTP codes from known services

**Modem setup on MARS:**

```bash
# Install
apt install gammu gammu-smsd usb-modeswitch

# Detect modem
gammu identify
# → Device: /dev/ttyUSB0
# → Manufacturer: Sierra Wireless
# → Model: MC7700

# Test send
gammu sendsms TEXT +15551234567 -text "MARS SMS gateway online"

# Start daemon (handles send queue + receive interception)
systemctl enable gammu-smsd
systemctl start gammu-smsd
```

---

## MCP Interface (Complete Tool Set)

### Vault Tools

```
vault.get_credential
  { provider, scope?, purpose? }
  → { key, provider, status, model_hint?, expires_at? }

vault.get_best_provider
  { purpose: "chat"|"embedding"|"title_gen"|"image", excluded?: [] }
  → { provider, key, reason }

vault.list_providers
  { app_id? }
  → [{ provider, status, last_check, models_available }]

vault.rotate_key
  { provider, scope, new_key }
  → { rotated, apps_notified[] }

vault.check_health
  { provider? }
  → { [provider]: { status, latency_ms, last_check, error? } }

vault.set_fallback_chain
  { app_id, purpose, chain: string[] }
  → { saved }
```

### Auth Tools

```
auth.verify_token
  { token }
  → { valid, user_id, email, expires_at }

auth.create_user
  { email, password, display_name? }
  → { user_id, verification_sent_via }

auth.issue_token
  { user_id, app_id }
  → { access_token, refresh_token, expires_in }
```

### OTP Tools

```
otp.send
  { destination, channel: "sms"|"email"|"telegram"|"auto", purpose? }
  → { sent, channel_used, expires_at }

otp.verify
  { destination, code }
  → { valid, purpose }

otp.get_intercepted_code
  { source: "facebook"|"instagram"|"google"|..., max_age_seconds?: 600 }
  → { code, sender, received_at, raw_message }

otp.list_intercepted
  { since?, source?, consumed?: false }
  → [{ id, source, code, sender, received_at, consumed }]

otp.mark_consumed
  { id, app_id }
  → { ok }
```

### Notify Tools

```
notify.telegram
  { message, parse_mode?: "Markdown"|"HTML", buttons?: [{text, callback_data}] }
  → { sent, message_id }

notify.sms
  { to, text }
  → { sent, gateway: "sierra_mc7700" }

notify.email
  { to, template, data }
  → { sent, message_id }
```

### System Tools

```
system.health
  → { services: { vault, auth, otp, mail, sms, telegram, postgres }, uptime }

system.usage
  { app_id?, since? }
  → { vault_reads, otp_sent, sms_sent, emails_sent, telegram_sent }
```

### MCP Resources (Read-Only)

```
mars://providers/status         — live health status
mars://otp/intercepted          — recent intercepted codes feed
mars://usage/summary            — usage dashboard data
mars://config/fallbacks         — fallback chain configs
```

---

## Client SDK: @nexless/mars-client

Every Nexless app integrates via one module. Handles connection, auth, caching, reconnection.

### Installation

```bash
npm install @nexless/mars-client
```

### Usage

```typescript
import { MarsClient } from "@nexless/mars-client";

const mars = new MarsClient({
  url: process.env.MARS_URL, // ngrok TCP address
  token: process.env.MARS_TOKEN, // app-specific vault token
  appId: "mike", // identifies this app
  cache: { ttl: 30 * 60 * 1000 }, // 30-min credential cache
});

// ── VAULT ──
const key = await mars.vault.getCredential("anthropic");
const best = await mars.vault.getBestProvider({ purpose: "chat" });
await mars.vault.rotateKey("openai", "sk-new-key...");

// ── AUTH ──
const user = await mars.auth.verifyToken(bearerToken);
const jwt = await mars.auth.issueToken(userId);

// ── OTP (send) ──
await mars.otp.send({ destination: "+15551234567", channel: "auto" });
const valid = await mars.otp.verify({ destination: "+15551234567", code: "847291" });

// ── OTP (intercept — for automation) ──
const fbCode = await mars.otp.getInterceptedCode({ source: "facebook", maxAge: 300 });
console.log(`Facebook 2FA code: ${fbCode.code}`);

// ── NOTIFICATIONS ──
await mars.notify.telegram("Deployment complete");
await mars.notify.sms("+15551234567", "Alert: server down");
await mars.notify.email({ to: "user@example.com", template: "otp", data: { code: "847291" } });

// ── SYSTEM ──
const health = await mars.system.health();
const usage = await mars.system.usage({ since: "24h" });
```

### Credential Caching Protocol

```typescript
// Built into the SDK — apps don't need to implement this
class CredentialCache {
  private cache: Map<string, { key: string; fetchedAt: number }>;
  private ttl: number;

  async get(provider: string): Promise<string> {
    const cached = this.cache.get(provider);

    // Fresh cache → return immediately
    if (cached && Date.now() - cached.fetchedAt < this.ttl) {
      return cached.key;
    }

    // Fetch from MARS
    try {
      const result = await this.client.vault.getCredential(provider);
      this.cache.set(provider, { key: result.key, fetchedAt: Date.now() });
      return result.key;
    } catch {
      // MARS unreachable → serve stale cache
      if (cached) {
        console.warn(
          `MARS unreachable, using cached ${provider} key (age: ${Date.now() - cached.fetchedAt}ms)`,
        );
        return cached.key;
      }
      throw new Error(`MARS unreachable and no cached credential for ${provider}`);
    }
  }
}
```

### App Integration Pattern (Mike Example)

**New file:** `backend/src/lib/marsClient.ts`

```typescript
import { MarsClient } from "@nexless/mars-client";

export const mars = new MarsClient({
  url: process.env.MARS_URL!,
  token: process.env.MARS_TOKEN!,
  appId: "mike",
});
```

**Modified:** `backend/src/lib/userSettings.ts`

```typescript
export async function getUserModelSettings(userId: string): Promise<UserModelSettings> {
  // 1. Check user's own keys (Mike's DB)
  const userKeys = await getStoredUserApiKeys(userId);
  if (hasAnyKey(userKeys)) {
    return { title_model: resolveTitleModel(userKeys), api_keys: userKeys };
  }

  // 2. Fall back to MARS vault (platform keys)
  const platformKeys = await mars.vault.getBestProvider({ purpose: "chat" });
  return {
    title_model: resolveTitleModel(platformKeys),
    api_keys: platformKeys,
  };
}
```

**Modified:** `backend/src/middleware/auth.ts`

```typescript
// Replace GoTrue fetch with MARS auth
const user = await mars.auth.verifyToken(token);
if (!user.valid) return res.status(401).json({ detail: "Invalid token" });
res.locals.userId = user.user_id;
res.locals.userEmail = user.email;
```

---

## App Integration Patterns (Other Apps)

### Marketing Engine (Paperclip)

```typescript
// In Paperclip agent — intercept Facebook OTP for automated 2FA
async function loginToFacebook(credentials) {
  await page.goto("https://facebook.com");
  await page.fill("#email", credentials.email);
  await page.fill("#pass", credentials.password);
  await page.click('[name="login"]');

  // Facebook sends SMS OTP to +1 438 829 9035
  // Wait for MARS to intercept it
  await sleep(10_000); // wait for SMS delivery

  const otp = await mars.otp.getInterceptedCode({
    source: "facebook",
    maxAge: 120, // code received in last 2 minutes
  });

  await page.fill("#approvals_code", otp.code);
  await page.click("#checkpointSubmitButton");
  await mars.otp.markConsumed(otp.id);

  // Logged in — no human intervention
}
```

### Claude Code Sessions

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "mars": {
      "type": "sse",
      "url": "https://X.tcp.ngrok.io:XXXXX/mcp",
      "headers": {
        "Authorization": "Bearer <dev-token>"
      }
    }
  }
}
```

Now in any Claude Code session:

- "Check vault health" → `vault.check_health()`
- "What's the latest Facebook OTP?" → `otp.get_intercepted_code({ source: "facebook" })`
- "Rotate the Anthropic key" → `vault.rotate_key(...)`
- "Send me a test Telegram" → `notify.telegram("Test from Claude Code")`

---

## Tech Stack

| Component  | Technology                  | Rationale                         |
| ---------- | --------------------------- | --------------------------------- |
| Runtime    | Node.js 22 + TypeScript     | Consistent with portfolio         |
| MCP Server | `@modelcontextprotocol/sdk` | Official MCP SDK                  |
| REST       | Express                     | Lightweight, same as Mike         |
| Database   | PostgreSQL 16               | Shared, schema-per-service        |
| Encryption | AES-256-GCM + HKDF          | Proven pattern from Mike          |
| SMS        | Sierra MC7700 + gammu-smsd  | Hardware modem, send + receive    |
| Email      | Haraka                      | Node.js SMTP server               |
| Telegram   | Bot API (HTTPS)             | No library needed, just fetch     |
| Container  | Docker Compose              | Single compose file on MARS       |
| Tunnel     | ngrok TCP                   | Existing infra, yulior-registered |
| Logging    | Pino                        | Consistent with portfolio         |
| Client SDK | `@nexless/mars-client`      | npm package, TypeScript           |

---

## Project Structure

```
mars-mcp-server/
├── docker-compose.yml              # All services + postgres + ngrok
├── mars.sh                         # Orchestration script (yulior-registered)
├── .env.example
├── package.json
│
├── src/
│   ├── index.ts                    # Entry: start MCP + REST + health monitor
│   │
│   ├── mcp/
│   │   ├── server.ts               # MCP server setup
│   │   └── tools/
│   │       ├── vault.ts            # vault.* tools
│   │       ├── auth.ts             # auth.* tools
│   │       ├── otp.ts              # otp.* tools
│   │       ├── notify.ts           # notify.* tools
│   │       └── system.ts           # system.* tools
│   │
│   ├── rest/
│   │   ├── router.ts               # Express routes (mirrors MCP tools)
│   │   └── middleware.ts           # App token auth
│   │
│   ├── services/
│   │   ├── vault.ts                # Credential CRUD + encryption
│   │   ├── health-monitor.ts       # Provider health probes (cron)
│   │   ├── auth.ts                 # User management + JWT
│   │   ├── otp-send.ts             # Generate + send OTP
│   │   ├── otp-verify.ts           # Verify OTP codes
│   │   ├── otp-interceptor.ts      # Parse incoming SMS, extract codes
│   │   ├── sms-gateway.ts          # Sierra MC7700 via gammu CLI
│   │   ├── telegram.ts             # Bot API client
│   │   └── mail.ts                 # Haraka / SMTP send
│   │
│   ├── lib/
│   │   ├── db.ts                   # Postgres client
│   │   ├── crypto.ts               # AES-256-GCM + HKDF
│   │   ├── resolver.ts             # Scope resolution (user > app > global)
│   │   └── logger.ts               # Pino
│   │
│   └── types.ts
│
├── scripts/
│   ├── init-app-token.ts           # Generate token for a new consumer app
│   ├── import-from-mike.ts         # Migrate Mike's user_api_keys
│   ├── import-from-vault-yaml.ts   # Migrate Marketing Engine's vault.yaml
│   ├── setup-modem.sh              # Sierra MC7700 detection + gammu config
│   ├── setup-telegram-bot.sh       # BotFather setup guide + webhook config
│   ├── on-sms-received.sh          # gammu-smsd RunOnReceive handler
│   └── backup.sh                   # Encrypted pg_dump
│
├── client/                         # @nexless/mars-client SDK
│   ├── package.json
│   ├── src/
│   │   ├── index.ts                # MarsClient class
│   │   ├── vault.ts                # Vault methods
│   │   ├── auth.ts                 # Auth methods
│   │   ├── otp.ts                  # OTP methods
│   │   ├── notify.ts               # Notification methods
│   │   ├── system.ts               # System methods
│   │   └── cache.ts                # Credential caching
│   └── tsconfig.json
│
├── templates/                      # Email templates (Handlebars)
│   ├── otp.hbs
│   ├── password-reset.hbs
│   ├── notification.hbs
│   └── share-document.hbs
│
├── prisma/
│   └── schema.prisma               # All schemas: vault, auth, otp, mail
│
├── tests/
│   ├── crypto.test.ts
│   ├── resolver.test.ts
│   ├── otp-interceptor.test.ts
│   ├── health-monitor.test.ts
│   └── sms-gateway.test.ts
│
└── Dockerfile
```

---

## Docker Compose (MARS Server)

```yaml
services:
  mars:
    build: .
    ports:
      - "8200:8200" # Vault MCP + REST
      - "8300:8300" # Auth
      - "8500:8500" # OTP
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0" # Sierra MC7700 modem
    environment:
      VAULT_MASTER_KEY: ${VAULT_MASTER_KEY}
      DATABASE_URL: postgresql://mars:${POSTGRES_PASSWORD}@postgres:5432/mars
      JWT_SECRET: ${JWT_SECRET}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mars
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: mars
    volumes:
      - mars-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mars"]
    restart: unless-stopped

  mail:
    image: analogic/poste.io
    ports:
      - "2525:25"
      - "8400:80"
    volumes:
      - mars-mail-data:/data
    environment:
      HTTPS: "OFF"
    restart: unless-stopped

  gammu:
    build:
      context: .
      dockerfile: Dockerfile.gammu
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
    environment:
      DATABASE_URL: postgresql://mars:${POSTGRES_PASSWORD}@postgres:5432/mars
      MARS_OTP_URL: http://mars:8500/internal/intercept
    depends_on:
      - postgres
    restart: unless-stopped

  ngrok:
    image: ngrok/ngrok:latest
    command: start --all --config /etc/ngrok.yml
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
    volumes:
      - ./ngrok.yml:/etc/ngrok.yml:ro
    depends_on:
      - mars
    restart: unless-stopped

volumes:
  mars-pg-data:
  mars-mail-data:
```

---

## Security Model

### Four Layers

```
Layer 1: Transport  — ngrok TCP (TLS at ngrok edge)
Layer 2: App Auth   — per-app token on every request (vault.app_tokens)
Layer 3: Encryption — AES-256-GCM on every stored credential
Layer 4: Isolation  — MARS is a dedicated server, not shared with apps
```

### App Token Permissions

```bash
# Generate app token with specific permissions
npx tsx scripts/init-app-token.ts \
  --app mike \
  --permissions vault:read,auth:verify,otp:send,notify:telegram

npx tsx scripts/init-app-token.ts \
  --app marketing-engine \
  --permissions vault:read,otp:intercept,otp:send,notify:telegram

npx tsx scripts/init-app-token.ts \
  --app claude-code \
  --permissions vault:read,vault:rotate,otp:intercept,notify:telegram,system:health
```

### Vault Master Key

- Encrypts all stored credentials
- Lives ONLY in MARS server's `.env`
- Never transmitted
- Backup: Shamir's Secret Sharing (2-of-3 split, stored in separate physical locations)

---

## Migration Plan

### Phase 1: MARS Core (Days 1-2)

1. Set up MARS server with Docker
2. Deploy vault + auth + postgres
3. Install Sierra MC7700 + gammu
4. Set up ngrok TCP tunnels
5. Import platform API keys as `scope: global`
6. Register in yulior
7. Test: `vault.get_credential('anthropic')` works via MCP

### Phase 2: SMS + Telegram (Day 3)

1. Configure gammu-smsd for send + receive
2. Test: send SMS from MARS terminal
3. Test: receive SMS, verify it appears in `otp.intercepted_codes`
4. Create Telegram bot via @BotFather
5. Test: send Telegram notification from MARS
6. Test: bot commands (/health, /providers, /codes)

### Phase 3: Connect Mike (Day 4)

1. `npm install @nexless/mars-client` in Mike backend
2. Add `MARS_URL` and `MARS_TOKEN` to Mike's `.env`
3. Modify `getUserModelSettings()` → fall back to MARS vault
4. Modify `auth.ts` → verify JWT via MARS auth (or keep GoTrue initially)
5. Test: Mike fetches credentials from MARS, chat works

### Phase 4: Connect Marketing Engine (Day 5)

1. Add `@nexless/mars-client` to Marketing Engine
2. Modify `setup-providers.ts` → read from MARS vault
3. Test: Paperclip agent uses `otp.getInterceptedCode('facebook')` for automated 2FA
4. Test: full agent wake cycle with MARS-sourced credentials

### Phase 5: Connect Claude Code + Decommission Local Keys (Day 6)

1. Add MCP server to `~/.claude/settings.json`
2. Test MCP tools from Claude Code session
3. Remove API keys from Mike's `.env` and Marketing Engine's `.env`
4. All platform credentials flow through MARS
5. Per-user keys in Mike's `user_api_keys` remain for user autonomy

---

## Success Criteria

- [ ] MARS runs on dedicated server, accessible via ngrok TCP
- [ ] Vault: `get_credential("anthropic")` returns valid key from any app
- [ ] Vault: health monitor detects blocked key within 5 minutes, sends Telegram alert
- [ ] Vault: `get_best_provider("chat")` skips blocked providers
- [ ] Auth: JWT issuance + verification works, Mike can replace GoTrue
- [ ] OTP Send: codes delivered via SMS, email, and Telegram
- [ ] OTP Intercept: Facebook/Instagram SMS codes captured and queryable
- [ ] OTP Intercept: Paperclip agent completes Facebook 2FA without human
- [ ] Telegram: operator receives vault alerts and can run /commands
- [ ] SMS: send + receive working via Sierra MC7700
- [ ] SDK: `@nexless/mars-client` installed and working in Mike
- [ ] Caching: apps survive 30+ minutes of MARS downtime on cached credentials
- [ ] All credential access logged in audit table

---

## Open Questions for Implementation

1. **ngrok TCP addressing** — free tier TCP tunnels change address on restart. Reserve a TCP address ($5/mo) or handle dynamic reconnection in the SDK?
2. **MCP transport** — MCP over SSE (HTTP) vs streamable-HTTP vs raw TCP? SSE is simplest for ngrok.
3. **GoTrue migration timing** — replace GoTrue with MARS auth immediately, or run both in parallel during transition?
4. **Mail server choice** — Haraka (Node.js, lightweight) vs Postal (full-featured, web UI, tracking) vs Poste.io (Docker-ready, admin UI)?
5. **SDK distribution** — npm public registry, GitHub Packages, or just a git dependency (`"@nexless/mars-client": "github:Dshamir/mars-client"`)?
6. **Backup destination** — encrypted pg_dump snapshots: S3, Backblaze B2, or USB drive on MARS?
7. **Sierra MC7700 fallback** — if modem fails, fall back to Twilio API (credentials in vault) for SMS?
8. **Multi-SIM** — future: add a second modem for redundancy or separate inbound/outbound?

---

## Estimated Effort

| Phase                                 | Effort       | Dependencies        |
| ------------------------------------- | ------------ | ------------------- |
| Vault core (MCP + REST + DB + health) | 2 days       | MARS server access  |
| Auth service (JWT + user mgmt)        | 1.5 days     | Vault core          |
| OTP send + verify                     | 1 day        | Auth service        |
| SMS gateway (Sierra MC7700 + gammu)   | 1 day        | Hardware installed  |
| OTP interceptor                       | 0.5 day      | SMS gateway         |
| Telegram bot                          | 0.5 day      | Vault core          |
| Mail server                           | 0.5 day      | Docker              |
| Client SDK (@nexless/mars-client)     | 1 day        | All services        |
| Mike integration                      | 1 day        | SDK                 |
| Marketing Engine integration          | 1 day        | SDK + OTP intercept |
| Claude Code MCP config                | 0.5 day      | Vault core          |
| **Total**                             | **~10 days** |                     |
