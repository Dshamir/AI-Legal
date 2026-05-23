import { describe, it, expect, beforeAll } from "vitest";
import { signDownload, verifyDownload } from "../../src/lib/downloadTokens";

beforeAll(() => {
  process.env.DOWNLOAD_SIGNING_SECRET = "test-signing-secret-for-unit-tests";
});

describe("downloadTokens", () => {
  it("round-trips sign → verify", () => {
    const result = verifyDownload(signDownload("docs/file.pdf", "file.pdf"));
    expect(result).toEqual({ path: "docs/file.pdf", filename: "file.pdf" });
  });

  it("rejects tampered token", () => {
    const token = signDownload("docs/file.pdf", "file.pdf");
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyDownload(tampered)).toBeNull();
  });

  it("rejects malformed token without separator", () => {
    expect(verifyDownload("noseparatorhere")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifyDownload("")).toBeNull();
  });

  it("rejects token with different-length signature", () => {
    const token = signDownload("docs/file.pdf", "file.pdf");
    const [enc] = token.split(".");
    expect(verifyDownload(`${enc}.short`)).toBeNull();
  });
});
