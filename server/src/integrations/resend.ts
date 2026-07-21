import { config } from "../config.js";
import { logger } from "../logger.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  mock: boolean;
  providerId: string | null;
}

/**
 * Send an outreach email via Resend. Without RESEND_API_KEY this is a logged
 * no-op ("mock mode") — the message is still recorded in the database, so the
 * dashboard and demo flow work with only an LLM key.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!config.resendApiKey) {
    logger.info(
      { to: input.to, subject: input.subject },
      "resend mock mode: email not actually sent",
    );
    return { mock: true, providerId: null };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.outreachFromEmail,
      to: [input.to],
      subject: input.subject,
      text: input.body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${text.slice(0, 500)}`);
  }
  const data = (await response.json()) as { id?: string };
  logger.info({ to: input.to, providerId: data.id }, "outreach email sent");
  return { mock: false, providerId: data.id ?? null };
}
