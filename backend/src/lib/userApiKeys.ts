import crypto from "crypto";
import { prisma } from "./prisma";
import type { UserApiKeys } from "./llm";
import { logger } from "./logger";
import {
  currentEncryptionKey,
  tryDecrypt,
  deriveKeyWithSalt,
  getEncryptionKeysWithSalt,
} from "./keyRotation";

export type ApiKeyProvider = "claude" | "gemini" | "openai";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources: Record<ApiKeyProvider, ApiKeySource>;
};

type EncryptedKeyRow = {
  provider: ApiKeyProvider;
  encryptedKey: string;
  iv: string;
  authTag: string;
  salt?: string | null;
};

const PROVIDERS: ApiKeyProvider[] = ["claude", "gemini", "openai"];

function envApiKey(provider: ApiKeyProvider): string | null {
  if (provider === "claude") {
    return process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_API_KEY?.trim() || null;
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY?.trim() || null;
  }
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
  return !!envApiKey(provider);
}

function encryptionKey(): Buffer {
  return currentEncryptionKey();
}

function encrypt(value: string): {
  encryptedKey: string;
  iv: string;
  authTag: string;
  salt: string;
} {
  const saltBuf = crypto.randomBytes(16);
  const key = deriveKeyWithSalt(
    (process.env.USER_API_KEYS_ENCRYPTION_SECRET_V2 ||
      process.env.USER_API_KEYS_ENCRYPTION_SECRET)!,
    saltBuf,
  );
  const ivBuf = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    encryptedKey: encrypted.toString("base64"),
    iv: ivBuf.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    salt: saltBuf.toString("base64"),
  };
}

function decrypt(row: EncryptedKeyRow): string | null {
  if (row.salt) {
    const saltBuf = Buffer.from(row.salt, "base64");
    const keys = getEncryptionKeysWithSalt(saltBuf).reverse();
    for (const key of keys) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
        decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(row.encryptedKey, "base64")),
          decipher.final(),
        ]);
        return decrypted.toString("utf8");
      } catch {
        continue;
      }
    }
    logger.error({ provider: row.provider }, "[user-api-keys] failed to decrypt with HKDF path");
    return null;
  }
  const result = tryDecrypt(row.encryptedKey, row.iv, row.authTag);
  if (result === null) {
    logger.error({ provider: row.provider }, "[user-api-keys] failed to decrypt stored key");
  }
  return result;
}

function isProvider(value: string): value is ApiKeyProvider {
  return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
  return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(userId: string): Promise<ApiKeyStatus> {
  const status: ApiKeyStatus = {
    claude: false,
    gemini: false,
    openai: false,
    sources: {
      claude: null,
      gemini: null,
      openai: null,
    },
  };

  for (const provider of PROVIDERS) {
    if (hasEnvApiKey(provider)) {
      status[provider] = true;
      status.sources[provider] = "env";
    }
  }

  const keys = await prisma.userApiKey.findMany({
    where: { userId },
    select: { provider: true },
  });

  for (const row of keys) {
    const provider = normalizeApiKeyProvider(String(row.provider));
    if (provider && !status[provider]) {
      status[provider] = true;
      status.sources[provider] = "user";
    }
  }

  return status;
}

export async function getUserApiKeys(userId: string): Promise<UserApiKeys> {
  const apiKeys: UserApiKeys = {
    claude: envApiKey("claude"),
    gemini: envApiKey("gemini"),
    openai: envApiKey("openai"),
  };

  const keys = await prisma.userApiKey.findMany({
    where: { userId },
    select: { provider: true, encryptedKey: true, iv: true, authTag: true, salt: true },
  });

  for (const row of keys) {
    const provider = normalizeApiKeyProvider(String(row.provider));
    if (!provider) continue;
    if (apiKeys[provider]?.trim()) continue;
    apiKeys[provider] = decrypt(row as EncryptedKeyRow);
  }

  return apiKeys;
}

export async function saveUserApiKey(
  userId: string,
  provider: ApiKeyProvider,
  value: string | null,
): Promise<void> {
  const normalized = value?.trim() || null;
  if (!normalized) {
    await prisma.userApiKey.deleteMany({
      where: { userId, provider },
    });
    return;
  }

  await prisma.userApiKey.upsert({
    where: { userId_provider: { userId, provider } },
    create: {
      userId,
      provider,
      ...encrypt(normalized),
    },
    update: {
      ...encrypt(normalized),
    },
  });
}
