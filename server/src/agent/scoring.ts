/**
 * Pure scoring logic for lead qualification. The LLM rates each ICP criterion
 * 0-5 with a rationale (structured output in nodes.ts); these functions turn
 * those ratings into a deterministic weighted 0-100 score and a tier, so the
 * rubric math is auditable and unit-testable rather than buried in a prompt.
 */

import type { IcpCriterion } from "../config.js";

export interface CriterionRating {
  name: string;
  /** 0 (no fit / no evidence) to 5 (strong fit) */
  score: number;
  rationale: string;
}

export function computeLeadScore(
  criteria: IcpCriterion[],
  ratings: CriterionRating[],
): number {
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) return 0;

  const ratingByName = new Map(ratings.map((r) => [r.name, r]));
  let weighted = 0;
  for (const criterion of criteria) {
    const rating = ratingByName.get(criterion.name);
    const clamped = Math.min(5, Math.max(0, rating?.score ?? 0));
    weighted += (clamped / 5) * criterion.weight;
  }
  return Math.round((weighted / totalWeight) * 100);
}

export type LeadTier = "hot" | "warm" | "cold";

export function scoreToTier(
  score: number,
  thresholds: { hot: number; warm: number },
): LeadTier {
  if (score >= thresholds.hot) return "hot";
  if (score >= thresholds.warm) return "warm";
  return "cold";
}
