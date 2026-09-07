import { z } from "zod";
import type { IcpConfig, IcpCriterion } from "../config.js";

/**
 * The lead fields the prompts need. Deliberately a structural type rather than
 * Prisma's `Lead` — the offline eval harness (server/evals) builds these from
 * JSON fixtures and must never import @prisma/client. See CLAUDE.md.
 */
export interface LeadContext {
  name: string;
  email: string;
  company: string | null;
  companyWebsite: string | null;
  message: string | null;
  source: string;
}

/** One LLM rating of a single ICP criterion, before deterministic scoring. */
export interface QualificationRating {
  name: string;
  score: number;
  rationale: string;
}

export function leadContextBlock(lead: LeadContext): string {
  return [
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company ?? "(not provided)"}`,
    `Website: ${lead.companyWebsite ?? "(not provided)"}`,
    `Source: ${lead.source}`,
    `Message from the lead:\n${lead.message ?? "(none)"}`,
  ].join("\n");
}

/**
 * Structured-output schema for the qualification call. Built per-call rather
 * than defined once, because the criterion names come from icp.config.json and
 * are pinned into a z.enum so the model can't invent a criterion that
 * computeLeadScore would then silently ignore.
 */
export function buildRatingSchema(criteria: IcpCriterion[]) {
  const criterionNames = criteria.map((c) => c.name) as [string, ...string[]];
  return z.object({
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
}

export function buildQualifyPrompt(args: {
  lead: LeadContext;
  icp: IcpConfig;
  enrichment: string | null;
}): string {
  const { lead, icp, enrichment } = args;
  const rubric = icp.criteria
    .map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
    .join("\n");

  return [
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
    `Company website text (may be empty):\n${enrichment ?? "(no enrichment available)"}`,
  ].join("\n");
}
