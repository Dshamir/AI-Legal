import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock the dependencies that globalErrorHandler imports
vi.mock("../../src/lib/errorTracking", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../src/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { globalErrorHandler } from "../../src/middleware/errorHandler";

describe("globalErrorHandler", () => {
  it("returns 500 with server_error type for unhandled errors", async () => {
    const app = express();
    app.get("/test", () => {
      throw new Error("DB connection failed on table users");
    });
    app.use(globalErrorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.type).toBe("server_error");
    // In production the title is generic; in dev it's the error message.
    // Either way, the type and status must be correct.
    expect(res.body.status).toBe(500);
  });

  it("returns 400 with validation_error type for ZodError", async () => {
    const { z } = await import("zod");
    const schema = z.object({ name: z.string() });

    const app = express();
    app.get("/test", () => {
      schema.parse({ name: 123 }); // will throw ZodError
    });
    app.use(globalErrorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(400);
    expect(res.body.type).toBe("validation_error");
    expect(res.body.title).toBe("Invalid request");
    expect(res.body.errors).toBeInstanceOf(Array);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
