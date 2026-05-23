import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { deriveKeyWithSalt } from "../../src/lib/keyRotation";

describe("deriveKeyWithSalt (HKDF)", () => {
  const secret = "test-secret-value";

  it("produces a 32-byte key", () => {
    const salt = crypto.randomBytes(16);
    const key = deriveKeyWithSalt(secret, salt);
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same secret + salt", () => {
    const salt = crypto.randomBytes(16);
    const k1 = deriveKeyWithSalt(secret, salt);
    const k2 = deriveKeyWithSalt(secret, salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("produces different keys for different salts", () => {
    const s1 = crypto.randomBytes(16);
    const s2 = crypto.randomBytes(16);
    const k1 = deriveKeyWithSalt(secret, s1);
    const k2 = deriveKeyWithSalt(secret, s2);
    expect(k1.equals(k2)).toBe(false);
  });

  it("produces different keys for different secrets", () => {
    const salt = crypto.randomBytes(16);
    const k1 = deriveKeyWithSalt("secret-a", salt);
    const k2 = deriveKeyWithSalt("secret-b", salt);
    expect(k1.equals(k2)).toBe(false);
  });
});
