import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

let warnedOpenWebhooks = false;

/**
 * Shared-secret auth for inbound webhooks (n8n / Zapier / curl send it as an
 * X-API-Key header). If WEBHOOK_API_KEY is unset, requests pass with a
 * warning — that keeps the local demo zero-config, but set the key anywhere
 * the endpoint is reachable from the internet.
 */
export function requireWebhookKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.webhookApiKey) {
    if (!warnedOpenWebhooks) {
      warnedOpenWebhooks = true;
      logger.warn("WEBHOOK_API_KEY is not set — webhook endpoints are OPEN (dev mode)");
    }
    next();
    return;
  }
  const provided = req.header("x-api-key") ?? "";
  if (!provided || !safeEqual(provided, config.webhookApiKey)) {
    res.status(401).json({ error: "invalid or missing X-API-Key" });
    return;
  }
  next();
}
