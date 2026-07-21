import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Post a notification to a Slack incoming webhook. Without SLACK_WEBHOOK_URL
 * this is a logged no-op ("mock mode"). Failures never break the pipeline —
 * a missed notification is not worth losing a lead over.
 */
export async function notifySlack(text: string): Promise<{ mock: boolean }> {
  if (!config.slackWebhookUrl) {
    logger.info({ text }, "slack mock mode: notification not sent");
    return { mock: true };
  }
  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "slack notification failed");
    }
  } catch (error) {
    logger.warn({ err: error }, "slack notification errored");
  }
  return { mock: false };
}
