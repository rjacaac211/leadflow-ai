import { interrupt } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { prisma, recordEvent } from "../db.js";
import { fetchWebsiteText } from "../integrations/enrichment.js";
import { syncLeadToCrm } from "../integrations/hubspot.js";
import { sendEmail } from "../integrations/resend.js";
import { notifySlack } from "../integrations/slack.js";
import { createModel, logTokenUsage } from "./llm.js";
import { computeLeadScore, scoreToTier } from "./scoring.js";
import type { ApprovalDecision, IntakeStateType, ReplyStateType } from "./state.js";

async function loadLead(leadId: string) {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  return lead;
}

function leadContextBlock(lead: {
  name: string;
  email: string;
  company: string | null;
  companyWebsite: string | null;
  message: string | null;
  source: string;
}): string {
  return [
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company ?? "(not provided)"}`,
    `Website: ${lead.companyWebsite ?? "(not provided)"}`,
    `Source: ${lead.source}`,
    `Message from the lead:\n${lead.message ?? "(none)"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Intake pipeline nodes
// ---------------------------------------------------------------------------

export async function enrichNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);
  if (!lead.companyWebsite) {
    await recordEvent(lead.id, "enrichment_skipped", {
      reason: "no company website on lead",
    });
    return { enrichment: null };
  }

  const text = await fetchWebsiteText(lead.companyWebsite);
  if (!text) {
    await recordEvent(lead.id, "enrichment_failed", { url: lead.companyWebsite });
    return { enrichment: null };
  }

  await prisma.lead.update({
    where: { id: lead.id },
    data: { enrichmentSummary: text.slice(0, 2000) },
  });
  await recordEvent(lead.id, "enriched", {
    url: lead.companyWebsite,
    chars: text.length,
  });
  return { enrichment: text };
}

export async function qualifyNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);
  const { icp } = config;
  const criterionNames = icp.criteria.map((c) => c.name) as [string, ...string[]];

  const ratingSchema = z.object({
    ratings: z
      .array(
        z.object({
          name: z.enum(criterionNames).describe("The ICP criterion being rated"),
          score: z
            .number()
            .int()
            .min(0)
            .max(5)
            .describe("0 = no fit or no evidence, 5 = strong fit"),
          rationale: z.string().describe("One or two sentences of evidence"),
        }),
      )
      .describe("Exactly one rating per ICP criterion"),
    summary: z
      .string()
      .describe("Two or three sentences summarizing overall fit for a sales rep"),
  });

  const rubric = icp.criteria
    .map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
    .join("\n");

  const prompt = [
    `You are a lead-qualification analyst for the following product:`,
    icp.productPitch,
    ``,
    `Ideal customer profile: ${icp.targetCustomer}`,
    ``,
    `Rate this inbound lead against each rubric criterion. Base every rating on evidence from the lead's submission and company website text; when there is no evidence for a criterion, score it low rather than guessing.`,
    ``,
    `Rubric:\n${rubric}`,
    ``,
    `Lead:\n${leadContextBlock(lead)}`,
    ``,
    `Company website text (may be empty):\n${state.enrichment ?? "(no enrichment available)"}`,
  ].join("\n");

  const model = createModel(2048).withStructuredOutput(ratingSchema, {
    name: "rate_lead",
    includeRaw: true,
  });
  const result = await model.invoke(prompt);
  logTokenUsage("qualify", result.raw as AIMessage);
  const { ratings, summary } = result.parsed;

  const score = computeLeadScore(icp.criteria, ratings);
  const tier = scoreToTier(score, icp.tierThresholds);
  const qualified = score >= icp.disqualifyBelow;

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      score,
      tier,
      qualificationReason: summary,
      stage: qualified ? "QUALIFIED" : "DISQUALIFIED",
    },
  });
  await recordEvent(lead.id, qualified ? "qualified" : "disqualified", {
    score,
    tier,
    ratings,
  });
  logger.info({ leadId: lead.id, score, tier, qualified }, "lead qualified");

  return { score, tier, qualified, qualificationReason: summary };
}

export async function crmSyncNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);
  try {
    const result = await syncLeadToCrm({
      email: lead.email,
      name: lead.name,
      company: lead.company ?? undefined,
      website: lead.companyWebsite ?? undefined,
      score: state.score,
      tier: state.tier,
      qualificationReason: state.qualificationReason,
    });
    if (result.contactId) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { hubspotContactId: result.contactId },
      });
    }
    await recordEvent(lead.id, "crm_synced", {
      mock: result.mock,
      contactId: result.contactId,
    });
  } catch (error) {
    // CRM being down should not lose the lead or halt outreach.
    logger.error({ leadId: lead.id, err: error }, "crm sync failed");
    await recordEvent(lead.id, "crm_sync_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {};
}

export async function draftOutreachNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);
  const { icp } = config;

  const draftSchema = z.object({
    subject: z.string().describe("Email subject line, under 80 characters"),
    body: z
      .string()
      .describe("Plain-text email body, 90-140 words, ending with a soft call to action"),
  });

  const prompt = [
    `You are a sales development rep writing a first outreach email for this product:`,
    icp.productPitch,
    ``,
    `Write a short, personalized reply-style email to the inbound lead below. Reference something concrete from their message or their company's website so it reads researched, not templated. No pushy language, no placeholder brackets, no markdown — plain text only. Sign off as "The Meridian Team".`,
    ``,
    `Lead:\n${leadContextBlock(lead)}`,
    ``,
    `Qualification summary (internal, do not quote directly): ${state.qualificationReason}`,
    ``,
    `Company website text (may be empty):\n${(state.enrichment ?? "").slice(0, 3000)}`,
  ].join("\n");

  const model = createModel(1024).withStructuredOutput(draftSchema, {
    name: "draft_email",
    includeRaw: true,
  });
  const result = await model.invoke(prompt);
  logTokenUsage("draft_outreach", result.raw as AIMessage);
  const { subject, body } = result.parsed;

  const draft = await prisma.outreachMessage.create({
    data: {
      leadId: lead.id,
      direction: "OUTBOUND",
      status: "DRAFT",
      subject,
      body,
    },
  });
  await prisma.lead.update({
    where: { id: lead.id },
    data: { stage: "AWAITING_APPROVAL" },
  });
  await recordEvent(lead.id, "outreach_drafted", { messageId: draft.id, subject });

  return { draftMessageId: draft.id, draftSubject: subject, draftBody: body };
}

export async function approvalGateNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  // Pauses the graph (durably, via the Postgres checkpointer) until a human
  // approves or rejects the draft from the dashboard. The resume value comes
  // from POST /api/leads/:id/approve|reject as a Command({ resume }).
  const decision = interrupt<
    { type: string; leadId: string; subject: string; body: string },
    ApprovalDecision
  >({
    type: "approval_request",
    leadId: state.leadId,
    subject: state.draftSubject,
    body: state.draftBody,
  });

  if (decision.decision === "approve") {
    return {
      approved: true,
      draftSubject: decision.subject?.trim() || state.draftSubject,
      draftBody: decision.body?.trim() || state.draftBody,
    };
  }
  await recordEvent(state.leadId, "outreach_rejected", {
    reason: decision.reason ?? null,
  });
  return { approved: false };
}

export async function sendNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);

  if (!state.approved) {
    if (state.draftMessageId) {
      await prisma.outreachMessage.update({
        where: { id: state.draftMessageId },
        data: { status: "REJECTED" },
      });
    }
    await prisma.lead.update({
      where: { id: lead.id },
      data: { stage: "QUALIFIED" },
    });
    return {};
  }

  const result = await sendEmail({
    to: lead.email,
    subject: state.draftSubject,
    body: state.draftBody,
  });

  if (state.draftMessageId) {
    await prisma.outreachMessage.update({
      where: { id: state.draftMessageId },
      data: {
        status: "SENT",
        subject: state.draftSubject,
        body: state.draftBody,
      },
    });
  }
  await prisma.lead.update({
    where: { id: lead.id },
    data: { stage: "OUTREACH_SENT" },
  });
  await recordEvent(lead.id, "outreach_sent", {
    mock: result.mock,
    providerId: result.providerId,
  });

  if (state.tier === "hot") {
    await notifySlack(
      `:fire: Hot lead: *${lead.name}* (${lead.email}${lead.company ? `, ${lead.company}` : ""}) scored ${state.score}/100. Outreach sent — consider a personal follow-up.`,
    );
    await recordEvent(lead.id, "slack_notified", { tier: state.tier });
  }
  return {};
}

// ---------------------------------------------------------------------------
// Reply pipeline nodes
// ---------------------------------------------------------------------------

export async function classifyReplyNode(
  state: ReplyStateType,
): Promise<Partial<ReplyStateType>> {
  const lead = await loadLead(state.leadId);

  await prisma.outreachMessage.create({
    data: {
      leadId: lead.id,
      direction: "INBOUND",
      status: "RECEIVED",
      body: state.replyText,
    },
  });

  const intentSchema = z.object({
    intent: z
      .enum(["interested", "question", "opt_out", "other"])
      .describe(
        "interested = wants a call/demo/pricing; question = asks something answerable about the product; opt_out = asks to stop contact; other = anything else",
      ),
    reasoning: z.string().describe("One sentence explaining the classification"),
  });

  const model = createModel(512).withStructuredOutput(intentSchema, {
    name: "classify_reply",
    includeRaw: true,
  });
  const result = await model.invoke(
    [
      `Classify the intent of this email reply from a sales lead.`,
      ``,
      `Lead: ${lead.name} (${lead.company ?? "unknown company"})`,
      `Their reply:\n${state.replyText}`,
    ].join("\n"),
  );
  logTokenUsage("classify_reply", result.raw as AIMessage);

  await recordEvent(lead.id, "reply_classified", {
    intent: result.parsed.intent,
    reasoning: result.parsed.reasoning,
  });
  return { intent: result.parsed.intent, intentReasoning: result.parsed.reasoning };
}

export async function handleReplyNode(
  state: ReplyStateType,
): Promise<Partial<ReplyStateType>> {
  const lead = await loadLead(state.leadId);
  const { icp } = config;

  if (state.intent === "opt_out") {
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: "OPTED_OUT" } });
    await recordEvent(lead.id, "opted_out", {});
    return { responseBody: null };
  }

  if (state.intent === "other") {
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: "REPLIED" } });
    return { responseBody: null };
  }

  const responseSchema = z.object({
    body: z
      .string()
      .describe("Plain-text email reply, under 120 words, signed 'The Meridian Team'"),
  });

  const instruction =
    state.intent === "interested"
      ? `The lead is interested. Write a warm reply confirming a teammate will reach out shortly to schedule time, and ask for their availability this week. Do not invent pricing or commitments.`
      : `The lead asked a question. Answer it briefly and accurately using only the product description below; if the answer isn't covered there, say a teammate will follow up with details rather than guessing.`;

  const model = createModel(1024).withStructuredOutput(responseSchema, {
    name: "draft_reply",
    includeRaw: true,
  });
  const result = await model.invoke(
    [
      `You are replying to an email from a sales lead.`,
      ``,
      `Product description: ${icp.productPitch}`,
      ``,
      instruction,
      ``,
      `Lead: ${lead.name} (${lead.company ?? "unknown company"})`,
      `Their message:\n${state.replyText}`,
    ].join("\n"),
  );
  logTokenUsage("handle_reply", result.raw as AIMessage);
  const responseBody = result.parsed.body;

  const sendResult = await sendEmail({
    to: lead.email,
    subject: "Re: your message",
    body: responseBody,
  });
  await prisma.outreachMessage.create({
    data: {
      leadId: lead.id,
      direction: "OUTBOUND",
      status: "SENT",
      subject: "Re: your message",
      body: responseBody,
    },
  });

  const newStage = state.intent === "interested" ? "ESCALATED" : "REPLIED";
  await prisma.lead.update({ where: { id: lead.id }, data: { stage: newStage } });
  await recordEvent(lead.id, "reply_handled", {
    intent: state.intent,
    mock: sendResult.mock,
  });

  if (state.intent === "interested") {
    await notifySlack(
      `:speech_balloon: *${lead.name}* (${lead.email}) replied and is interested — handed off for human follow-up.`,
    );
  }
  return { responseBody };
}
