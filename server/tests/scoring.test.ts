import { describe, expect, it } from "vitest";
import {
  computeLeadScore,
  findDisqualifyingCriterion,
  qualifyFromRatings,
  scoreToTier,
} from "../src/agent/scoring.js";
import type { IcpConfig, IcpCriterion } from "../src/config.js";

const criteria: IcpCriterion[] = [
  { name: "industry_fit", description: "", weight: 3 },
  { name: "pain_signal", description: "", weight: 4 },
  { name: "urgency", description: "", weight: 2 },
];

describe("computeLeadScore", () => {
  it("returns 100 when every criterion scores 5", () => {
    const score = computeLeadScore(
      criteria,
      criteria.map((c) => ({ name: c.name, score: 5, rationale: "" })),
    );
    expect(score).toBe(100);
  });

  it("returns 0 when every criterion scores 0", () => {
    const score = computeLeadScore(
      criteria,
      criteria.map((c) => ({ name: c.name, score: 0, rationale: "" })),
    );
    expect(score).toBe(0);
  });

  it("weights criteria: heavy criterion moves the score more", () => {
    const heavyOnly = computeLeadScore(criteria, [
      { name: "pain_signal", score: 5, rationale: "" },
    ]);
    const lightOnly = computeLeadScore(criteria, [
      { name: "urgency", score: 5, rationale: "" },
    ]);
    // pain_signal carries 4/9 of the weight, urgency 2/9
    expect(heavyOnly).toBe(44);
    expect(lightOnly).toBe(22);
    expect(heavyOnly).toBeGreaterThan(lightOnly);
  });

  it("treats missing ratings as 0 and clamps out-of-range scores", () => {
    const score = computeLeadScore(criteria, [
      { name: "industry_fit", score: 99, rationale: "" }, // clamped to 5
      { name: "unknown_criterion", score: 5, rationale: "" }, // ignored
    ]);
    expect(score).toBe(33); // 3/9 of the weight at full marks
  });

  it("returns 0 for an empty rubric instead of dividing by zero", () => {
    expect(computeLeadScore([], [])).toBe(0);
  });
});

describe("scoreToTier", () => {
  const thresholds = { hot: 70, warm: 40 };

  it("maps scores to tiers at the boundaries", () => {
    expect(scoreToTier(100, thresholds)).toBe("hot");
    expect(scoreToTier(70, thresholds)).toBe("hot");
    expect(scoreToTier(69, thresholds)).toBe("warm");
    expect(scoreToTier(40, thresholds)).toBe("warm");
    expect(scoreToTier(39, thresholds)).toBe("cold");
    expect(scoreToTier(0, thresholds)).toBe("cold");
  });
});

const gatedCriteria: IcpCriterion[] = [
  { name: "industry_fit", description: "", weight: 3, disqualifyAtOrBelow: 1 },
  { name: "pain_signal", description: "", weight: 4, disqualifyAtOrBelow: 0 },
  { name: "urgency", description: "", weight: 2 },
];

describe("findDisqualifyingCriterion", () => {
  it("returns null when no criterion is gated", () => {
    expect(
      findDisqualifyingCriterion(criteria, [{ name: "pain_signal", score: 0, rationale: "" }]),
    ).toBeNull();
  });

  it("returns null when every gated criterion clears its floor", () => {
    expect(
      findDisqualifyingCriterion(gatedCriteria, [
        { name: "industry_fit", score: 2, rationale: "" },
        { name: "pain_signal", score: 1, rationale: "" },
      ]),
    ).toBeNull();
  });

  it("vetoes at the boundary, not just below it", () => {
    expect(
      findDisqualifyingCriterion(gatedCriteria, [
        { name: "industry_fit", score: 1, rationale: "" },
        { name: "pain_signal", score: 5, rationale: "" },
      ]),
    ).toBe("industry_fit");
  });

  it("vetoes a zero pain signal even when everything else is perfect", () => {
    expect(
      findDisqualifyingCriterion(gatedCriteria, [
        { name: "industry_fit", score: 5, rationale: "" },
        { name: "pain_signal", score: 0, rationale: "" },
        { name: "urgency", score: 5, rationale: "" },
      ]),
    ).toBe("pain_signal");
  });

  it("treats a missing rating as 0, so absent evidence still vetoes", () => {
    expect(findDisqualifyingCriterion(gatedCriteria, [])).toBe("industry_fit");
  });

  it("reports the first tripped criterion in rubric order", () => {
    expect(
      findDisqualifyingCriterion(gatedCriteria, [
        { name: "industry_fit", score: 0, rationale: "" },
        { name: "pain_signal", score: 0, rationale: "" },
      ]),
    ).toBe("industry_fit");
  });
});

describe("qualifyFromRatings", () => {
  const icp: IcpConfig = {
    productPitch: "",
    targetCustomer: "",
    criteria: gatedCriteria,
    tierThresholds: { hot: 70, warm: 40 },
    disqualifyBelow: 25,
  };

  it("qualifies a strong lead", () => {
    const outcome = qualifyFromRatings(icp, [
      { name: "industry_fit", score: 5, rationale: "" },
      { name: "pain_signal", score: 5, rationale: "" },
      { name: "urgency", score: 4, rationale: "" },
    ]);
    expect(outcome).toEqual({
      score: 96,
      tier: "hot",
      qualified: true,
      disqualifiedBy: null,
    });
  });

  it("disqualifies on score alone when nothing is vetoed", () => {
    const outcome = qualifyFromRatings(icp, [
      { name: "industry_fit", score: 2, rationale: "" },
      { name: "pain_signal", score: 1, rationale: "" },
      { name: "urgency", score: 0, rationale: "" },
    ]);
    expect(outcome.disqualifiedBy).toBeNull();
    expect(outcome.score).toBeLessThan(25);
    expect(outcome.qualified).toBe(false);
  });

  // The regression the offline eval caught: a competitor scored 36/100 — above
  // the cutoff — on the strength of industry and headcount, despite an
  // explicit zero pain signal. The veto is what stops it reaching outreach.
  it("vetoes a passing score when a gated criterion is zero", () => {
    const outcome = qualifyFromRatings(icp, [
      { name: "industry_fit", score: 3, rationale: "" },
      { name: "pain_signal", score: 0, rationale: "" },
      { name: "urgency", score: 5, rationale: "" },
    ]);
    expect(outcome.score).toBeGreaterThanOrEqual(icp.disqualifyBelow);
    expect(outcome.qualified).toBe(false);
    expect(outcome.disqualifiedBy).toBe("pain_signal");
  });

  it("keeps reporting the score and tier for a vetoed lead", () => {
    const outcome = qualifyFromRatings(icp, [
      { name: "industry_fit", score: 1, rationale: "" },
      { name: "pain_signal", score: 5, rationale: "" },
      { name: "urgency", score: 5, rationale: "" },
    ]);
    // The veto changes `qualified`, not the arithmetic — the dashboard still
    // shows what the lead scored and why it was rejected.
    expect(outcome.score).toBe(73);
    expect(outcome.tier).toBe("hot");
    expect(outcome.qualified).toBe(false);
    expect(outcome.disqualifiedBy).toBe("industry_fit");
  });
});
