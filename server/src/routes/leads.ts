import { Router } from "express";
import { prisma, recordEvent } from "../db.js";
import { logger } from "../logger.js";
import { resumeWithDecision, retryFailedStep } from "../agent/graph.js";

// Precondition errors from retryFailedStep are the caller's fault (nothing to
// retry / a decision is pending instead) — not a real node failure, so they
// don't get a "retry_failed" audit event of their own.
const RETRY_PRECONDITION_MESSAGES = ["has a pending approval", "already completed"];

export const leadsRouter = Router();

leadsRouter.get("/", async (_req, res) => {
  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ leads });
});

leadsRouter.get("/:id", async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.id },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ lead });
});

async function handleDecision(
  leadId: string,
  decision: "approve" | "reject",
  body: { subject?: unknown; body?: unknown; reason?: unknown },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { status: 404, payload: { error: "lead not found" } };
  if (lead.stage !== "AWAITING_APPROVAL") {
    return {
      status: 409,
      payload: { error: `lead is in stage ${lead.stage}, not AWAITING_APPROVAL` },
    };
  }

  const result = await resumeWithDecision(leadId, {
    decision,
    subject: typeof body.subject === "string" ? body.subject : undefined,
    body: typeof body.body === "string" ? body.body : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });
  return { status: 200, payload: { leadId, ...result } };
}

leadsRouter.post("/:id/approve", async (req, res) => {
  try {
    const { status, payload } = await handleDecision(
      req.params.id,
      "approve",
      req.body ?? {},
    );
    res.status(status).json(payload);
  } catch (error) {
    logger.error({ leadId: req.params.id, err: error }, "approve failed");
    res.status(500).json({ error: "failed to resume pipeline" });
  }
});

leadsRouter.post("/:id/reject", async (req, res) => {
  try {
    const { status, payload } = await handleDecision(
      req.params.id,
      "reject",
      req.body ?? {},
    );
    res.status(status).json(payload);
  } catch (error) {
    logger.error({ leadId: req.params.id, err: error }, "reject failed");
    res.status(500).json({ error: "failed to resume pipeline" });
  }
});

// Recovers a lead stuck mid-graph after a post-approval node (e.g. `send`)
// failed and exhausted retries. Deliberately does NOT gate on `lead.stage`
// like approve/reject do — that column can be stale after exactly this kind
// of failure (see CLAUDE.md); the graph checkpoint is the real source of
// truth, and retryFailedStep asks it directly.
leadsRouter.post("/:id/retry", async (req, res) => {
  const leadId = req.params.id;
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  try {
    const result = await retryFailedStep(leadId);
    res.status(200).json({ leadId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to retry pipeline";
    const isPrecondition = RETRY_PRECONDITION_MESSAGES.some((m) => message.includes(m));
    if (!isPrecondition) {
      logger.error({ leadId, err: error }, "retry failed");
      await recordEvent(leadId, "retry_failed", { error: message });
    }
    res.status(isPrecondition ? 409 : 500).json({ error: message });
  }
});
