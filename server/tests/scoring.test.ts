import { describe, expect, it } from "vitest";
import { computeLeadScore, scoreToTier } from "../src/agent/scoring.js";
import type { IcpCriterion } from "../src/config.js";

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
