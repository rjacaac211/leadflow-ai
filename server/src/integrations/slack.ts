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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Post an approval-request message with interactive Approve/Reject buttons,
 * via the Slack Web API (chat.postMessage with a bot token) rather than the
 * plain incoming webhook `notifySlack` uses, since Block Kit interactivity
 * requires a real bot token + channel, not just a webhook URL. Falls back to
 * `notifySlack`'s plain-text/mock behavior when either is unset, so the
 * pipeline still degrades gracefully with only an Anthropic key.
 *
 * The button `value` carries the raw leadId — the n8n workflow that receives
 * the interaction reads it straight back out and calls the existing
 * unauthenticated `/api/leads/:id/approve|reject` routes, same as the
 * dashboard does.
 */
export async function notifySlackWithApproval(
  leadId: string,
  subject: string,
  body: string,
): Promise<{ mock: boolean }> {
  const summaryText = `:memo: Outreach draft awaiting approval — *${subject}*`;

  if (!config.slackBotToken || !config.slackApprovalChannel) {
    return notifySlack(summaryText);
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.slackBotToken}`,
      },
      body: JSON.stringify({
        channel: config.slackApprovalChannel,
        text: summaryText,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: summaryText },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Subject:* ${truncate(subject, 150)}\n\n${truncate(body, 2500)}`,
            },
          },
          {
            type: "actions",
            block_id: "leadflow_approval_actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve", emoji: true },
                style: "primary",
                action_id: "leadflow_approve",
                value: leadId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject", emoji: true },
                style: "danger",
                action_id: "leadflow_reject",
                value: leadId,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as { ok: boolean; error?: string };
    if (!payload.ok) {
      logger.warn({ error: payload.error }, "slack chat.postMessage failed");
    }
  } catch (error) {
    logger.warn({ err: error }, "slack chat.postMessage errored");
  }
  return { mock: false };
}
