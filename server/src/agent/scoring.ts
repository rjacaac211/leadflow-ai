/**
 * Pure scoring logic for lead qualification. The LLM rates each ICP criterion
 * 0-5 with a rationale (structured output in nodes.ts); these functions turn
 * those ratings into a deterministic weighted 0-100 score and a tier, so the
 * rubric math is auditable and unit-testable rather than buried in a prompt.
 */

import type { IcpConfig, IcpCriterion } from "../config.js";

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

/**
 * The name of the first criterion whose rating trips its `disqualifyAtOrBelow`
 * veto, or null if none do.
 *
 * A weighted average cannot express "this one thing rules the lead out" — the
 * offline eval found a competitor rated `pain_signal: 0` scoring 36/100, above
 * the disqualify cutoff, because its industry and headcount looked right. A
 * missing rating counts as 0 for the same reason computeLeadScore treats it as
 * 0: absence of evidence must not score better than evidence of absence.
 */
export function findDisqualifyingCriterion(
  criteria: IcpCriterion[],
  ratings: CriterionRating[],
): string | null {
  const ratingByName = new Map(ratings.map((r) => [r.name, r]));
  for (const criterion of criteria) {
    if (criterion.disqualifyAtOrBelow === undefined) continue;
    const score = Math.min(5, Math.max(0, ratingByName.get(criterion.name)?.score ?? 0));
    if (score <= criterion.disqualifyAtOrBelow) return criterion.name;
  }
  return null;
}

export interface QualificationOutcome {
  score: number;
  tier: LeadTier;
  qualified: boolean;
  /** Criterion that vetoed the lead, if any — recorded for the audit trail. */
  disqualifiedBy: string | null;
}

/**
 * The complete deterministic verdict for a set of LLM ratings. Shared by
 * qualifyNode and the offline eval harness so the two can never drift — the
 * eval grading the pipeline through different arithmetic than the pipeline
 * uses would make its numbers meaningless.
 */
export function qualifyFromRatings(
  icp: IcpConfig,
  ratings: CriterionRating[],
): QualificationOutcome {
  const score = computeLeadScore(icp.criteria, ratings);
  const disqualifiedBy = findDisqualifyingCriterion(icp.criteria, ratings);
  return {
    score,
    tier: scoreToTier(score, icp.tierThresholds),
    qualified: disqualifiedBy === null && score >= icp.disqualifyBelow,
    disqualifiedBy,
  };
}
