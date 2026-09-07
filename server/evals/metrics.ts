/**
 * Pure scoring/aggregation for the qualification eval. No I/O, no LLM calls —
 * unit-tested in tests/eval-metrics.test.ts so the harness's own arithmetic is
 * trustworthy before anyone reads a number out of it.
 */

import type { LeadTier } from "../src/agent/scoring.js";

export const TIERS: LeadTier[] = ["hot", "warm", "cold"];

export interface ExpectedLabel {
  tier: LeadTier;
  qualified: boolean;
  scoreRange: [number, number];
}

/** One model call against one case. */
export interface CaseAttempt {
  caseId: string;
  score: number;
  tier: LeadTier;
  qualified: boolean;
  expected: ExpectedLabel;
}

export interface CaseSummary {
  caseId: string;
  expected: ExpectedLabel;
  attempts: number;
  scores: number[];
  meanScore: number;
  /** max - min across repeats: how nondeterministic this case is. */
  scoreSpread: number;
  tierHits: number;
  qualifiedHits: number;
  inRangeHits: number;
  /** True only if every repeat got the tier right — the honest per-case verdict. */
  stable: boolean;
}

export interface EvalSummary {
  cases: CaseSummary[];
  totalAttempts: number;
  tierAccuracy: number;
  qualifiedAccuracy: number;
  inRangeRate: number;
  /** Mean absolute distance from the expected band (0 when inside it). */
  scoreMae: number;
  maxScoreSpread: number;
  /** Of the cases labeled `qualified: false`, the share correctly rejected. */
  disqualifyRecall: number;
  /** expected tier -> actual tier -> count */
  confusion: Record<LeadTier, Record<LeadTier, number>>;
}

export interface Thresholds {
  tierAccuracy: number;
  qualifiedAccuracy: number;
  disqualifyRecall: number;
  maxScoreMae: number;
}

/** Distance outside the expected band; 0 when the score is inside it. */
export function bandError(score: number, [min, max]: [number, number]): number {
  if (score < min) return min - score;
  if (score > max) return score - max;
  return 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function emptyConfusion(): Record<LeadTier, Record<LeadTier, number>> {
  const rows = {} as Record<LeadTier, Record<LeadTier, number>>;
  for (const expected of TIERS) {
    rows[expected] = { hot: 0, warm: 0, cold: 0 };
  }
  return rows;
}

export function summarizeEvalRun(attempts: CaseAttempt[]): EvalSummary {
  const byCase = new Map<string, CaseAttempt[]>();
  for (const attempt of attempts) {
    const existing = byCase.get(attempt.caseId);
    if (existing) existing.push(attempt);
    else byCase.set(attempt.caseId, [attempt]);
  }

  const confusion = emptyConfusion();
  for (const attempt of attempts) {
    confusion[attempt.expected.tier][attempt.tier] += 1;
  }

  const cases: CaseSummary[] = [];
  for (const [caseId, caseAttempts] of byCase) {
    const expected = caseAttempts[0].expected;
    const scores = caseAttempts.map((a) => a.score);
    const tierHits = caseAttempts.filter((a) => a.tier === expected.tier).length;
    cases.push({
      caseId,
      expected,
      attempts: caseAttempts.length,
      scores,
      meanScore: mean(scores),
      scoreSpread: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0,
      tierHits,
      qualifiedHits: caseAttempts.filter((a) => a.qualified === expected.qualified).length,
      inRangeHits: caseAttempts.filter((a) => bandError(a.score, expected.scoreRange) === 0)
        .length,
      stable: tierHits === caseAttempts.length,
    });
  }

  const total = attempts.length;
  const rejectAttempts = attempts.filter((a) => !a.expected.qualified);

  return {
    cases,
    totalAttempts: total,
    tierAccuracy: total === 0 ? 0 : attempts.filter((a) => a.tier === a.expected.tier).length / total,
    qualifiedAccuracy:
      total === 0 ? 0 : attempts.filter((a) => a.qualified === a.expected.qualified).length / total,
    inRangeRate:
      total === 0 ? 0 : attempts.filter((a) => bandError(a.score, a.expected.scoreRange) === 0).length / total,
    scoreMae: mean(attempts.map((a) => bandError(a.score, a.expected.scoreRange))),
    maxScoreSpread: cases.length === 0 ? 0 : Math.max(...cases.map((c) => c.scoreSpread)),
    // Vacuously perfect when the dataset has no reject cases, rather than 0/0.
    disqualifyRecall:
      rejectAttempts.length === 0
        ? 1
        : rejectAttempts.filter((a) => !a.qualified).length / rejectAttempts.length,
    confusion,
  };
}

export function checkThresholds(
  summary: EvalSummary,
  thresholds: Thresholds,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const atLeast = (label: string, actual: number, floor: number) => {
    if (actual < floor) {
      failures.push(`${label} ${actual.toFixed(3)} is below the required ${floor}`);
    }
  };

  atLeast("tier accuracy", summary.tierAccuracy, thresholds.tierAccuracy);
  atLeast("qualified accuracy", summary.qualifiedAccuracy, thresholds.qualifiedAccuracy);
  atLeast("disqualify recall", summary.disqualifyRecall, thresholds.disqualifyRecall);
  if (summary.scoreMae > thresholds.maxScoreMae) {
    failures.push(
      `score MAE ${summary.scoreMae.toFixed(2)} exceeds the allowed ${thresholds.maxScoreMae}`,
    );
  }

  return { passed: failures.length === 0, failures };
}
