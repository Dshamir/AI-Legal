import { describe, it, expect } from "vitest";
import { zodUUID, zodNonEmptyString, zodPagination, zodParamsWithId } from "../../src/lib/validation/common";

describe("zodUUID", () => {
  it("accepts valid UUID", () => {
    expect(() => zodUUID.parse("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("rejects invalid UUID", () => {
    expect(() => zodUUID.parse("not-a-uuid")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => zodUUID.parse("")).toThrow();
  });
});

describe("zodNonEmptyString", () => {
  it("rejects empty string", () => {
    expect(() => zodNonEmptyString.parse("")).toThrow();
  });

  it("accepts non-empty string", () => {
    expect(() => zodNonEmptyString.parse("hello")).not.toThrow();
  });

  it("rejects strings over 10000 characters", () => {
    expect(() => zodNonEmptyString.parse("a".repeat(10001))).toThrow();
  });
});

describe("zodPagination", () => {
  it("applies defaults when no values provided", () => {
    const result = zodPagination.parse({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("coerces string values to numbers", () => {
    const result = zodPagination.parse({ limit: "10", offset: "5" });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
  });

  it("rejects limit > 100", () => {
    expect(() => zodPagination.parse({ limit: 101 })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => zodPagination.parse({ offset: -1 })).toThrow();
  });
});

describe("zodParamsWithId", () => {
  it("accepts valid UUID in params.id", () => {
    const result = zodParamsWithId.parse({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });
    expect(result.params.id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects invalid UUID in params.id", () => {
    expect(() => zodParamsWithId.parse({ params: { id: "bad" } })).toThrow();
  });
});
