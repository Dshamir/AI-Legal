import type { Request, Response, NextFunction } from "express";

export function setCacheHeaders(maxAge: number) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", `private, max-age=${maxAge}`);
    next();
  };
}

export function noCache(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}
