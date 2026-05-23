import * as Sentry from "@sentry/node";
import { logger } from "./logger";

const dsn = process.env.SENTRY_DSN || process.env.GLITCHTIP_DSN;

export function initErrorTracking() {
  if (!dsn) {
    logger.warn("SENTRY_DSN not set — error tracking disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.1,
  });
  logger.info("Error tracking initialized");
}

export function captureException(error: unknown, context?: Record<string, unknown>) {
  if (dsn) {
    Sentry.captureException(error, { extra: context });
  }
}

export { Sentry };
