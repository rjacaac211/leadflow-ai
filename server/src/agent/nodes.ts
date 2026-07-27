import { END, interrupt } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { prisma, recordEvent } from "../db.js";
import { fetchWebsiteText } from "../integrations/enrichment.js";
import { syncLeadToCrm } from "../integrations/hubspot.js";
import { sendEmail } from "../integrations/resend.js";
import { notifySlack, notifySlackWithApproval } from "../integrations/slack.js";
import { runEnrichmentAgent } from "./enrichment-agent.js";
import { createModel, logTokenUsage } from "./llm.js";
import { lintOutreachDraft } from "./outreach-critique.js";
import { buildThreadTranscript } from "./reply-context.js";
import { computeLeadScore, scoreToTier } from "./scoring.js";
import type { ApprovalDecision, IntakeStateType, ReplyIntent, ReplyStateType } from "./state.js";

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

  await recordEvent(lead.id, "enrichment_agent_started", { url: lead.companyWebsite });
  let text: string | null = null;
  let pagesVisited = 0;
  try {
    const agentResult = await runEnrichmentAgent(lead.companyWebsite);
    if (agentResult) {
      text = agentResult.text;
      pagesVisited = agentResult.pagesVisited;
      await recordEvent(lead.id, "enrichment_agent_finished", {
        url: lead.companyWebsite,
        pagesVisited,
        chars: text.length,
      });
    }
  } catch (error) {
    logger.warn(
      { leadId: lead.id, err: error },
      "enrichment agent failed — falling back to single-page fetch",
    );
    await recordEvent(lead.id, "enrichment_agent_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to the single-fetch path if the agent found nothing usable —
  // the same "degrade, don't drop the lead" pattern every other integration
  // in this repo follows, not a missing-credential case (there's no new key
  // here), but the same spirit.
  if (!text) {
    text = await fetchWebsiteText(lead.companyWebsite);
  }

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
    viaAgent: pagesVisited > 0,
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

// Where the graph goes after a successful (or compensated) crmSync — shared
// by the normal conditional edge and the crmSync errorHandler so both stay
// in sync with the same qualified/disqualified branching rule.
export function nextAfterCrmSync(qualified: boolean): "draftOutreach" | typeof END {
  return qualified ? "draftOutreach" : END;
}

export async function crmSyncNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lead = await loadLead(state.leadId);
  // Let a real failure propagate so RetryPolicy can retry transient errors;
  // the errorHandler registered on this node in graph.ts is what enforces
  // "a CRM outage must not lose the lead or block outreach" once retries
  // are exhausted, instead of swallowing the error on the very first try.
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
    `Write a short, personalized reply-style email to the inbound lead below. Reference something concrete from their message or their company's website so it reads researched, not templated. No pushy language, no placeholder brackets, no markdown — plain text only. Never mention the lead source or any other internal metadata about how the lead arrived. Sign off as "The Meridian Team".`,
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
  await recordEvent(lead.id, "outreach_drafted", { messageId: draft.id, subject });

  // lead.stage moves to AWAITING_APPROVAL in approvalGateNode, once the
  // critique/revise cycle below has actually finished and we're about to
  // pause for a human — not here, since a draft can still go through
  // several silent revisions before a human ever sees it.
  return {
    draftMessageId: draft.id,
    draftSubject: subject,
    draftBody: body,
    revisionCount: 0,
  };
}

export const MAX_OUTREACH_REVISIONS = 2;

export async function critiqueOutreachNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  const lintIssues = lintOutreachDraft(state.draftSubject, state.draftBody);

  const critiqueSchema = z.object({
    passes: z.boolean().describe("True only if the draft needs no changes"),
    issues: z
      .array(z.string())
      .describe("Specific problems found; empty if the draft passes"),
  });

  const prompt = [
    `You are reviewing a sales outreach email draft before it goes to a human for approval.`,
    ``,
    `Check for: genuine personalization (references something real and specific about the lead or their company, not generic filler), appropriate tone (not pushy, no invented commitments or pricing), and that it reads like it was actually written for this lead rather than a template.`,
    ``,
    `Subject: ${state.draftSubject}`,
    `Body:\n${state.draftBody}`,
  ].join("\n");

  const model = createModel(512).withStructuredOutput(critiqueSchema, {
    name: "critique_outreach",
    includeRaw: true,
  });
  const result = await model.invoke(prompt);
  logTokenUsage("critique_outreach", result.raw as AIMessage);

  const semanticIssues = result.parsed.passes ? [] : result.parsed.issues;
  const issues = [...lintIssues, ...semanticIssues];
  const passes = lintIssues.length === 0 && result.parsed.passes;

  await recordEvent(state.leadId, "outreach_critiqued", {
    passes,
    issues,
    revisionCount: state.revisionCount,
  });

  return { critiquePassed: passes, critiqueIssues: issues };
}

export async function reviseOutreachNode(
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
    `You previously drafted this sales outreach email for the product below, but a review pass found issues. Revise it to fix every issue listed while keeping what already works. No pushy language, no placeholder brackets, no markdown — plain text only. Never mention the lead source or any other internal metadata about how the lead arrived. Sign off as "The Meridian Team".`,
    icp.productPitch,
    ``,
    `Previous subject: ${state.draftSubject}`,
    `Previous body:\n${state.draftBody}`,
    ``,
    `Issues to fix:\n- ${state.critiqueIssues.join("\n- ")}`,
    ``,
    `Lead:\n${leadContextBlock(lead)}`,
    ``,
    `Company website text (may be empty):\n${(state.enrichment ?? "").slice(0, 3000)}`,
  ].join("\n");

  const model = createModel(1024).withStructuredOutput(draftSchema, {
    name: "revise_email",
    includeRaw: true,
  });
  const result = await model.invoke(prompt);
  logTokenUsage("revise_outreach", result.raw as AIMessage);
  const { subject, body } = result.parsed;

  const revisionCount = state.revisionCount + 1;
  if (state.draftMessageId) {
    await prisma.outreachMessage.update({
      where: { id: state.draftMessageId },
      data: { subject, body },
    });
  }
  await recordEvent(state.leadId, "outreach_revised", { revisionCount });

  return { draftSubject: subject, draftBody: body, revisionCount };
}

export async function approvalGateNode(
  state: IntakeStateType,
): Promise<Partial<IntakeStateType>> {
  // Idempotent — re-run on every resume along with the rest of this node
  // (interrupt() only skips re-pausing, not the code around it), so this
  // just re-writes the same value on resume rather than double-transitioning.
  await prisma.lead.update({
    where: { id: state.leadId },
    data: { stage: "AWAITING_APPROVAL" },
  });

  // The rest of this node (everything before interrupt()) re-runs on every
  // resume too, so a Slack post here needs its own guard — recordEvent isn't
  // idempotent the way the lead.stage write above is. Only fire once per
  // pause, tracked via the same audit trail every other decision point uses.
  const alreadyNotified = await prisma.leadEvent.findFirst({
    where: { leadId: state.leadId, type: "slack_approval_requested" },
  });
  if (!alreadyNotified) {
    const result = await notifySlackWithApproval(
      state.leadId,
      state.draftSubject,
      state.draftBody,
    );
    await recordEvent(state.leadId, "slack_approval_requested", { mock: result.mock });
  }

  // Pauses the graph (durably, via the Postgres checkpointer) until a human
  // approves or rejects the draft from the dashboard (or via the Slack
  // approval buttons, which route through the same /approve|/reject routes
  // by way of the n8n workflow in automation/n8n-slack-approval-workflow.json).
  // The resume value comes from POST /api/leads/:id/approve|reject as a
  // Command({ resume }).
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

// Intents that get an automated reply drafted and sent. The remainder
// (opt_out, wrong_person, other) are terminal or human-handoff cases with no
// automated response — see handleReplyNode.
const AUTO_REPLY_INTENTS = new Set<ReplyIntent>([
  "interested",
  "meeting_request",
  "pricing_question",
  "product_question",
  "objection",
  "referral",
]);

// Higher-urgency intents that page a human immediately via Slack and move
// the lead straight to ESCALATED instead of just REPLIED.
const ESCALATE_INTENTS = new Set<ReplyIntent>(["interested", "meeting_request"]);

const INTENT_INSTRUCTIONS: Record<Exclude<ReplyIntent, "opt_out" | "wrong_person" | "other">, string> = {
  interested: `The lead expressed general interest. Write a warm reply confirming a teammate will reach out shortly to schedule time, and ask for their availability this week. Do not invent pricing or commitments.`,
  meeting_request: `The lead wants to schedule a call or demo. Confirm enthusiasm and ask for their availability this week; do not commit to a specific time yourself, since a teammate will coordinate scheduling.`,
  pricing_question: `The lead is asking about pricing. Do not invent numbers or commitments — explain that a teammate will follow up with pricing details tailored to their team, and ask a brief qualifying question (e.g. team size) if it's useful.`,
  product_question: `The lead asked a question about the product. Answer it briefly and accurately using only the product description below; if the answer isn't covered there, say a teammate will follow up with details rather than guessing.`,
  objection: `The lead raised a concern or hesitation. Acknowledge it directly and briefly without being defensive or dismissive, and offer that a teammate can address it in more depth. Do not argue or over-promise.`,
  referral: `The lead is pointing to someone else as a better contact rather than evaluating this themselves. Thank them briefly and ask for the best way to reach the person they mentioned, or offer to have a teammate follow up with that contact directly.`,
};

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

  const thread = await prisma.outreachMessage.findMany({
    where: { leadId: lead.id },
    orderBy: { createdAt: "asc" },
  });

  const intentSchema = z.object({
    intent: z
      .enum([
        "interested",
        "meeting_request",
        "pricing_question",
        "product_question",
        "objection",
        "referral",
        "opt_out",
        "wrong_person",
        "other",
      ])
      .describe(
        "interested = general positive interest with no specific ask; meeting_request = explicitly wants a call/demo/meeting; pricing_question = asks about cost or plans; product_question = asks something else answerable about the product; objection = raises a concern, hesitation, or pushback; referral = points to a different person to contact instead of themselves; opt_out = asks to stop contact; wrong_person = says they are not the right contact and names no replacement; other = anything else",
      ),
    reasoning: z.string().describe("One sentence explaining the classification"),
  });

  const model = createModel(512).withStructuredOutput(intentSchema, {
    name: "classify_reply",
    includeRaw: true,
  });
  const result = await model.invoke(
    [
      `Classify the intent of this email reply from a sales lead. Use the full conversation for context, but base the classification on their latest message.`,
      ``,
      `Lead: ${lead.name} (${lead.company ?? "unknown company"})`,
      ``,
      `Conversation so far:\n${buildThreadTranscript(thread)}`,
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

  if (!AUTO_REPLY_INTENTS.has(state.intent)) {
    // wrong_person / other: flag for human follow-up, no automated reply.
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: "REPLIED" } });
    return { responseBody: null };
  }

  const thread = await prisma.outreachMessage.findMany({
    where: { leadId: lead.id },
    orderBy: { createdAt: "asc" },
  });

  const responseSchema = z.object({
    body: z
      .string()
      .describe("Plain-text email reply, under 120 words, signed 'The Meridian Team'"),
  });

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
      INTENT_INSTRUCTIONS[state.intent as keyof typeof INTENT_INSTRUCTIONS],
      ``,
      `Lead: ${lead.name} (${lead.company ?? "unknown company"})`,
      ``,
      `Conversation so far:\n${buildThreadTranscript(thread)}`,
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

  const newStage = ESCALATE_INTENTS.has(state.intent) ? "ESCALATED" : "REPLIED";
  await prisma.lead.update({ where: { id: lead.id }, data: { stage: newStage } });
  await recordEvent(lead.id, "reply_handled", {
    intent: state.intent,
    mock: sendResult.mock,
  });

  if (ESCALATE_INTENTS.has(state.intent)) {
    await notifySlack(
      `:speech_balloon: *${lead.name}* (${lead.email}) replied (${state.intent}) — handed off for human follow-up.`,
    );
  }
  return { responseBody };
}
