import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { computeLeadScore, scoreToTier, type LeadTier } from "../src/agent/scoring.js";
import { loadCases, loadThresholds } from "../evals/dataset.js";
import {
  bandError,
  checkThresholds,
  summarizeEvalRun,
  type CaseAttempt,
  type EvalSummary,
  type ExpectedLabel,
} from "../evals/metrics.js";

const hotLabel: ExpectedLabel = { tier: "hot", qualified: true, scoreRange: [70, 100] };
const coldLabel: ExpectedLabel = { tier: "cold", qualified: false, scoreRange: [0, 24] };

function attempt(
  caseId: string,
  score: number,
  tier: LeadTier,
  qualified: boolean,
  expected: ExpectedLabel,
): CaseAttempt {
  return { caseId, score, tier, qualified, expected };
}

describe("bandError", () => {
  it("is zero inside the band, including on both edges", () => {
    expect(bandError(70, [70, 100])).toBe(0);
    expect(bandError(85, [70, 100])).toBe(0);
    expect(bandError(100, [70, 100])).toBe(0);
  });

  it("measures distance outside the band in either direction", () => {
    expect(bandError(64, [70, 100])).toBe(6);
    expect(bandError(30, [0, 24])).toBe(6);
  });
});

describe("summarizeEvalRun", () => {
  it("scores a perfect run", () => {
    const summary = summarizeEvalRun([
      attempt("a", 82, "hot", true, hotLabel),
      attempt("b", 10, "cold", false, coldLabel),
    ]);
    expect(summary.tierAccuracy).toBe(1);
    expect(summary.qualifiedAccuracy).toBe(1);
    expect(summary.disqualifyRecall).toBe(1);
    expect(summary.inRangeRate).toBe(1);
    expect(summary.scoreMae).toBe(0);
    expect(summary.cases.every((c) => c.stable)).toBe(true);
  });

  it("counts a tier miss and the distance outside the band", () => {
    const summary = summarizeEvalRun([attempt("a", 60, "warm", true, hotLabel)]);
    expect(summary.tierAccuracy).toBe(0);
    // qualified was still right (true === true) even though the tier was wrong.
    expect(summary.qualifiedAccuracy).toBe(1);
    expect(summary.scoreMae).toBe(10);
    expect(summary.inRangeRate).toBe(0);
  });

  it("marks a case flaky rather than stable when repeats disagree", () => {
    const summary = summarizeEvalRun([
      attempt("a", 72, "hot", true, hotLabel),
      attempt("a", 68, "warm", true, hotLabel),
      attempt("a", 74, "hot", true, hotLabel),
    ]);
    const [only] = summary.cases;
    expect(only.attempts).toBe(3);
    expect(only.tierHits).toBe(2);
    expect(only.stable).toBe(false);
    expect(only.scoreSpread).toBe(6);
    expect(summary.maxScoreSpread).toBe(6);
    expect(summary.tierAccuracy).toBeCloseTo(2 / 3);
  });

  it("reports no spread for a single-attempt case", () => {
    const summary = summarizeEvalRun([attempt("a", 80, "hot", true, hotLabel)]);
    expect(summary.cases[0].scoreSpread).toBe(0);
    expect(summary.maxScoreSpread).toBe(0);
  });

  it("measures disqualify recall only over cases labeled unqualified", () => {
    const summary = summarizeEvalRun([
      // Labeled unqualified but let through — the failure that matters.
      attempt("junk", 30, "cold", true, coldLabel),
      attempt("junk2", 5, "cold", false, coldLabel),
      // A qualified case must not dilute the recall denominator.
      attempt("good", 90, "hot", true, hotLabel),
    ]);
    expect(summary.disqualifyRecall).toBe(0.5);
  });

  it("treats a dataset with no reject cases as vacuously perfect recall", () => {
    const summary = summarizeEvalRun([attempt("a", 80, "hot", true, hotLabel)]);
    expect(summary.disqualifyRecall).toBe(1);
  });

  it("builds a confusion matrix keyed expected -> actual", () => {
    const summary = summarizeEvalRun([
      attempt("a", 60, "warm", true, hotLabel),
      attempt("b", 90, "hot", true, hotLabel),
      attempt("c", 5, "cold", false, coldLabel),
    ]);
    expect(summary.confusion.hot.warm).toBe(1);
    expect(summary.confusion.hot.hot).toBe(1);
    expect(summary.confusion.cold.cold).toBe(1);
    expect(summary.confusion.cold.hot).toBe(0);
  });

  it("returns zeroed metrics for an empty run rather than dividing by zero", () => {
    const summary = summarizeEvalRun([]);
    expect(summary.totalAttempts).toBe(0);
    expect(summary.tierAccuracy).toBe(0);
    expect(summary.scoreMae).toBe(0);
    expect(summary.maxScoreSpread).toBe(0);
  });
});

describe("checkThresholds", () => {
  const passing: EvalSummary = summarizeEvalRun([
    attempt("a", 80, "hot", true, hotLabel),
    attempt("b", 10, "cold", false, coldLabel),
  ]);

  it("passes a clean run", () => {
    const result = checkThresholds(passing, {
      tierAccuracy: 0.75,
      qualifiedAccuracy: 0.85,
      disqualifyRecall: 0.9,
      maxScoreMae: 6,
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("names every breached threshold", () => {
    const failing = summarizeEvalRun([attempt("a", 30, "cold", true, hotLabel)]);
    const result = checkThresholds(failing, {
      tierAccuracy: 0.75,
      qualifiedAccuracy: 0.85,
      disqualifyRecall: 0.9,
      maxScoreMae: 6,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2); // tier accuracy + score MAE
    expect(result.failures.join(" ")).toContain("tier accuracy");
    expect(result.failures.join(" ")).toContain("score MAE");
  });

  it("fails a run that lets unqualified leads through", () => {
    const leaky = summarizeEvalRun([attempt("junk", 20, "cold", true, coldLabel)]);
    const result = checkThresholds(leaky, {
      tierAccuracy: 0.75,
      qualifiedAccuracy: 0.85,
      disqualifyRecall: 0.9,
      maxScoreMae: 6,
    });
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("disqualify recall");
  });
});

// These guard the labels themselves. A dataset whose expected tier disagrees
// with its own score range would make the eval unfalsifiable, and that kind of
// drift is easy to introduce while hand-editing fixtures or retuning
// icp.config.json's thresholds.
describe("qualification dataset integrity", () => {
  const cases = loadCases();
  const { tierThresholds, disqualifyBelow } = config.icp;

  it("has cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it("uses unique ids", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every tier and both qualified outcomes", () => {
    const tiers = new Set(cases.map((c) => c.expected.tier));
    expect([...tiers].sort()).toEqual(["cold", "hot", "warm"]);
    expect(cases.some((c) => c.expected.qualified)).toBe(true);
    expect(cases.some((c) => !c.expected.qualified)).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s has a coherent label",
    (_id, evalCase) => {
      const [min, max] = evalCase.expected.scoreRange;
      expect(min).toBeLessThanOrEqual(max);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(100);

      // The whole band must sit in one tier, so the expected tier is unambiguous.
      expect(scoreToTier(min, tierThresholds)).toBe(evalCase.expected.tier);
      expect(scoreToTier(max, tierThresholds)).toBe(evalCase.expected.tier);

      // `qualified` is NOT derivable from the score: a criterion veto can
      // reject a lead that scores well (see findDisqualifyingCriterion). So
      // only one direction is checkable — a lead expected to qualify must at
      // least clear the cutoff. A lead expected to be rejected may score
      // anywhere, because the veto is what catches it.
      if (evalCase.expected.qualified) {
        expect(min).toBeGreaterThanOrEqual(disqualifyBelow);
      }

      expect(evalCase.notes.length).toBeGreaterThan(20);
      expect(evalCase.lead.name).toBeTruthy();
      expect(evalCase.lead.email).toContain("@");
    },
  );

  it("labels bands that are actually reachable by the weighted rubric", () => {
    // computeLeadScore can only emit a fixed lattice of values (weights over a
    // 0-5 scale), so a band could in principle contain no achievable score.
    const { criteria } = config.icp;
    const reachable = new Set<number>();
    const walk = (index: number, acc: { name: string; score: number; rationale: string }[]) => {
      if (index === criteria.length) {
        reachable.add(computeLeadScore(criteria, acc));
        return;
      }
      for (let score = 0; score <= 5; score++) {
        walk(index + 1, [...acc, { name: criteria[index].name, score, rationale: "" }]);
      }
    };
    walk(0, []);

    for (const evalCase of cases) {
      const [min, max] = evalCase.expected.scoreRange;
      const hit = [...reachable].some((score) => score >= min && score <= max);
      expect(hit, `${evalCase.id} band ${min}-${max} is unreachable`).toBe(true);
    }
  });

  // The eval has to run in CI and on a laptop with no Postgres, on an API key
  // alone. That constraint is easy to break by accident — one convenience
  // import of `loadLead` and the whole harness needs a database. This walks the
  // real import graph rather than trusting the comments that say not to.
  it("never reaches Prisma or the database layer through any import", () => {
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const entryPoints = [
      "evals/run-qualification-eval.ts",
      "evals/dataset.ts",
      "evals/metrics.ts",
    ];

    const visited = new Set<string>();
    const offenders: string[] = [];
    const queue = entryPoints.map((p) => path.resolve(serverDir, p));

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);

      const source = readFileSync(file, "utf-8");
      // Strip comments so the explanatory notes about Prisma don't self-trip.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

      for (const match of code.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1];
        if (specifier === "@prisma/client" || /(^|\/)db\.js$/.test(specifier)) {
          offenders.push(`${path.relative(serverDir, file)} -> ${specifier}`);
          continue;
        }
        if (!specifier.startsWith(".")) continue; // node_modules: not our graph
        queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    }

    expect(visited.size).toBeGreaterThan(entryPoints.length); // graph actually walked
    expect(offenders).toEqual([]);
  });

  it("has thresholds in the 0-1 range", () => {
    const thresholds = loadThresholds();
    for (const key of ["tierAccuracy", "qualifiedAccuracy", "disqualifyRecall"] as const) {
      expect(thresholds[key]).toBeGreaterThan(0);
      expect(thresholds[key]).toBeLessThanOrEqual(1);
    }
    expect(thresholds.maxScoreMae).toBeGreaterThanOrEqual(0);
  });
});
