import { Router } from "express";
import { prisma, recordEvent } from "../db.js";
import { logger } from "../logger.js";
import { normalizeLeadPayload } from "../services/leads.js";
import { runIntakePipeline, runReplyPipeline } from "../agent/graph.js";
import { requireWebhookKey } from "../middleware/auth.js";

export const webhooksRouter = Router();

webhooksRouter.use(requireWebhookKey);

/**
 * Lead capture — the entry point for n8n, Zapier ("Webhooks by Zapier"),
 * form builders, or the dashboard's demo form. Responds 202 immediately and
 * runs the agent pipeline in the background; callers poll the dashboard API
 * (or watch CRM/Slack) for the outcome.
 */
webhooksRouter.post("/lead", async (req, res) => {
  const normalized = normalizeLeadPayload(req.body);
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.error });
    return;
  }

  const existing = await prisma.lead.findUnique({
    where: { email: normalized.lead.email },
  });
  if (existing) {
    await recordEvent(existing.id, "duplicate_submission", {
      source: normalized.lead.source,
    });
    res.status(200).json({
      leadId: existing.id,
      status: "duplicate",
      message: "lead with this email already exists",
    });
    return;
  }

  const lead = await prisma.lead.create({ data: normalized.lead });
  await recordEvent(lead.id, "lead_received", { source: lead.source });

  runIntakePipeline(lead.id).catch(async (error: unknown) => {
    logger.error({ leadId: lead.id, err: error }, "intake pipeline failed");
    await recordEvent(lead.id, "pipeline_failed", {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  });

  res.status(202).json({ leadId: lead.id, status: "processing" });
});

/**
 * Inbound email reply — wire this to Resend's inbound webhook, an n8n IMAP
 * trigger, or post to it manually from the dashboard to simulate a reply.
 */
webhooksRouter.post("/email-reply", async (req, res) => {
  const { email, message } = (req.body ?? {}) as {
    email?: unknown;
    message?: unknown;
  };
  if (typeof email !== "string" || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "expected { email: string, message: string }" });
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!lead) {
    res.status(404).json({ error: `no lead found for ${email}` });
    return;
  }

  try {
    const result = await runReplyPipeline(lead.id, message.slice(0, 8000));
    res.json({ leadId: lead.id, ...result });
  } catch (error) {
    logger.error({ leadId: lead.id, err: error }, "reply pipeline failed");
    res.status(500).json({ error: "reply pipeline failed" });
  }
});
