import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireAuth } from "../../src/middleware/auth";

describe("requireAuth", () => {
  const app = express();
  app.get("/test", requireAuth, (_req, res) => res.json({ ok: true }));

  it("rejects requests without Authorization header", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/Missing/i);
  });

  it("rejects requests with non-Bearer token", async () => {
    const res = await request(app).get("/test").set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/Missing/i);
  });

  it("returns 500 when Supabase env vars are not set", async () => {
    const res = await request(app).get("/test").set("Authorization", "Bearer fake-token");
    expect(res.status).toBe(500);
    expect(res.body.detail).toMatch(/not configured/i);
  });
});
