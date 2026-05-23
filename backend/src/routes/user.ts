import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "../lib/llm";
import {
  type ApiKeyStatus,
  getUserApiKeyStatus,
  hasEnvApiKey,
  normalizeApiKeyProvider,
  saveUserApiKey,
} from "../lib/userApiKeys";
import { auditLog } from "../lib/audit";
import { createClient } from "@supabase/supabase-js";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

type UserProfileRow = {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: Date;
  tier: string;
  tabularModel: string;
};

function serializeProfile(
  row: UserProfileRow,
  apiKeyStatus?: ApiKeyStatus,
) {
  const creditsUsed = row.messageCreditsUsed ?? 0;
  return {
    displayName: row.displayName,
    organisation: row.organisation,
    messageCreditsUsed: creditsUsed,
    creditsResetDate: row.creditsResetDate.toISOString(),
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
    tier: row.tier || "Free",
    tabularModel: resolveModel(row.tabularModel, DEFAULT_TABULAR_MODEL),
    ...(apiKeyStatus ? { apiKeyStatus } : {}),
  };
}

function validateProfilePayload(body: unknown):
  | {
      ok: true;
      update: {
        displayName?: string | null;
        organisation?: string | null;
        tabularModel?: string;
      };
    }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "tabularModel",
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: {
    displayName?: string | null;
    organisation?: string | null;
    tabularModel?: string;
  } = {};

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    update.displayName = raw.displayName?.trim() || null;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    update.organisation = raw.organisation?.trim() || null;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    const resolved = resolveModel(raw.tabularModel, "");
    if (!resolved) {
      return { ok: false, detail: "Unsupported tabularModel" };
    }
    update.tabularModel = resolved;
  }

  return { ok: true, update };
}

async function ensureProfileRow(userId: string) {
  await prisma.userProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

async function loadProfile(
  userId: string,
  options: { repairMissing?: boolean } = {},
) {
  let profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: {
      displayName: true,
      organisation: true,
      messageCreditsUsed: true,
      creditsResetDate: true,
      tier: true,
      tabularModel: true,
    },
  });

  if (!profile) {
    if (!options.repairMissing) {
      throw new Error("Profile not found");
    }
    await ensureProfileRow(userId);
    profile = await prisma.userProfile.findUniqueOrThrow({
      where: { userId },
      select: {
        displayName: true,
        organisation: true,
        messageCreditsUsed: true,
        creditsResetDate: true,
        tier: true,
        tabularModel: true,
      },
    });
  }

  if (profile.creditsResetDate && new Date() > new Date(profile.creditsResetDate)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    profile = await prisma.userProfile.update({
      where: { userId },
      data: {
        messageCreditsUsed: 0,
        creditsResetDate,
      },
      select: {
        displayName: true,
        organisation: true,
        messageCreditsUsed: true,
        creditsResetDate: true,
        tier: true,
        tabularModel: true,
      },
    });
  }

  return serializeProfile(profile as UserProfileRow);
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  await ensureProfileRow(userId);
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const data = await loadProfile(userId, { repairMissing: true });
  const apiKeyStatus = await getUserApiKeyStatus(userId);
  res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  await ensureProfileRow(userId);

  await prisma.userProfile.update({
    where: { userId },
    data: parsed.update,
  });

  await auditLog({
    userId,
    action: "update",
    entity: "userProfile",
    entityId: userId,
    changes: parsed.update,
  });

  const data = await loadProfile(userId);
  const apiKeyStatus = await getUserApiKeyStatus(userId);
  res.json({ ...data, apiKeyStatus });
});

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const status = await getUserApiKeyStatus(userId);
  res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const provider = normalizeApiKeyProvider(req.params.provider);
  if (!provider)
    return void res.status(400).json({ detail: "Unsupported provider" });

  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key : null;
  try {
    if (hasEnvApiKey(provider)) {
      return void res.status(409).json({
        detail:
          "This provider is configured by the server environment and cannot be changed from the browser.",
      });
    }
    await saveUserApiKey(userId, provider, apiKey);
    const status = await getUserApiKeyStatus(userId);
    res.json(status);
  } catch (err) {
    logger.error({ err, provider }, "[user/api-keys] save failed");
    res.status(500).json({ detail: "Failed to save API key" });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  // Auth user deletion still uses Supabase admin API
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    return void res.status(500).json({ detail: "Server auth is not configured" });
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
