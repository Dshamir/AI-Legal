import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { captureException } from "../lib/errorTracking";
import { logger } from "../lib/logger";

const isProduction = process.env.NODE_ENV === "production";

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const log = res.locals.log ?? logger;
  const requestId = res.locals.requestId ?? "unknown";

  if (err instanceof ZodError) {
    res.status(400).json({
      type: "validation_error",
      title: "Invalid request",
      status: 400,
      requestId,
      errors: err.issues.map((e) => ({
        path: e.path.map(String).join("."),
        message: e.message,
      })),
    });
    return;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  log.error({ err: error, requestId }, "Unhandled error");
  captureException(error, { requestId, path: req.path, method: req.method });

  res.status(500).json({
    type: "server_error",
    title: isProduction ? "Something went wrong" : error.message,
    status: 500,
    requestId,
  });
}
