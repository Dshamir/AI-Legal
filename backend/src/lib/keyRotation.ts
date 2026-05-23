import crypto from "crypto";
import { logger } from "./logger";

const secrets = [
  process.env.USER_API_KEYS_ENCRYPTION_SECRET,
  process.env.USER_API_KEYS_ENCRYPTION_SECRET_V2,
].filter(Boolean) as string[];

export function getEncryptionKeys(): Buffer[] {
  return secrets.map((s) => crypto.createHash("sha256").update(s).digest());
}

export function currentEncryptionKey(): Buffer {
  const keys = getEncryptionKeys();
  if (keys.length === 0) {
    throw new Error("No encryption secrets configured");
  }
  return keys[keys.length - 1];
}

export function deriveKeyWithSalt(secretEnvValue: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secretEnvValue, salt, "ailegal-api-key-v1", 32));
}

export function getEncryptionKeysWithSalt(salt: Buffer): Buffer[] {
  return secrets.map((s) => deriveKeyWithSalt(s, salt));
}

export function tryDecrypt(encrypted: string, iv: string, authTag: string): string | null {
  const keys = getEncryptionKeys().reverse();
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(authTag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      continue;
    }
  }
  logger.error("Failed to decrypt with any available key");
  return null;
}
