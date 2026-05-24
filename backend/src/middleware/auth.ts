import { Request, Response, NextFunction } from "express";

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const gotrueUrl = process.env.SUPABASE_URL ?? "";
  if (!gotrueUrl) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  try {
    const resp = await fetch(`${gotrueUrl}/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      res.status(401).json({ detail: "Invalid or expired token" });
      return;
    }
    const user = await resp.json();
    if (!user?.id) {
      res.status(401).json({ detail: "Invalid or expired token" });
      return;
    }

    res.locals.userId = user.id;
    res.locals.userEmail = (user.email ?? "").toLowerCase();
    res.locals.token = token;
    next();
  } catch {
    res.status(502).json({ detail: "Auth service unavailable" });
  }
}
