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

export function tryDecrypt(
  encrypted: string,
  iv: string,
  authTag: string,
): string | null {
  const keys = getEncryptionKeys().reverse();
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64"),
      );
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
