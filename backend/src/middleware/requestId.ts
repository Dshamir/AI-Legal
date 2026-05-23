import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers["x-request-id"] as string) ?? crypto.randomUUID();
  res.setHeader("x-request-id", id);
  res.locals.requestId = id;
  res.locals.log = logger.child({ requestId: id });
  next();
}
