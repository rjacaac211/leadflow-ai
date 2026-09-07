/**
 * Offline eval for lead qualification.
 *
 *   npm run eval -- --repeat 3
 *
 * Replays a labeled lead set through the exact prompt and schema qualifyNode
 * uses (src/agent/qualify-prompt.ts) and the exact deterministic scoring
 * qualifyNode applies (src/agent/scoring.ts), then grades the result against
 * human labels.
 *
 * Deliberately imports nothing from db.ts, routes/, or @prisma/client: this has
 * to run in CI and on a laptop with no Postgres, using only ANTHROPIC_API_KEY.
 * If you find yourself needing a Lead row here, build a LeadContext instead.
 */

import "./load-env.js"; // must stay first — see load-env.ts
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AIMessage } from "@langchain/core/messages";
import { config } from "../src/config.js";
import { createModel, logTokenUsage } from "../src/agent/llm.js";
import { buildQualifyPrompt, buildRatingSchema } from "../src/agent/qualify-prompt.js";
import { qualifyFromRatings } from "../src/agent/scoring.js";
import { loadCases, loadThresholds, type EvalCase } from "./dataset.js";
import { checkThresholds, summarizeEvalRun, TIERS, type CaseAttempt } from "./metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  repeat: number;
  concurrency: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const num = (flag: string, fallback: number): number => {
    const value = get(flag);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`${flag} must be a positive number, got "${value}"`);
    }
    return Math.floor(parsed);
  };
  return {
    repeat: num("--repeat", 1),
    concurrency: num("--concurrency", 4),
    out: get("--out") ?? path.resolve(here, "report.json"),
  };
}

/** Minimal worker-pool map — keeps concurrent Anthropic calls bounded. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

interface AttemptOutcome extends CaseAttempt {
  repeatIndex: number;
  disqualifiedBy: string | null;
  summary: string;
  ratings: { name: string; score: number; rationale: string }[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

async function runOneAttempt(
  evalCase: EvalCase,
  repeatIndex: number,
): Promise<AttemptOutcome> {
  const { icp } = config;
  const prompt = buildQualifyPrompt({
    lead: evalCase.lead,
    icp,
    // "" means "this company has no usable website text" — pass it through as
    // null so the prompt renders the same "(no enrichment available)" line the
    // real pipeline shows when enrichment is skipped.
    enrichment: evalCase.enrichment === "" ? null : evalCase.enrichment,
  });

  const model = createModel(2048).withStructuredOutput(buildRatingSchema(icp.criteria), {
    name: "rate_lead",
    includeRaw: true,
  });

  const startedAt = Date.now();
  const result = await model.invoke(prompt);
  const latencyMs = Date.now() - startedAt;

  // No leadId: nothing to attribute this to in the audit trail, and the eval
  // has no database anyway. The return value is what we want here.
  const usage = logTokenUsage(`eval:${evalCase.id}`, result.raw as AIMessage);
  const { ratings, summary } = result.parsed;

  // Exactly the verdict qualifyNode computes — same function, no reimplementation.
  const { score, tier, qualified, disqualifiedBy } = qualifyFromRatings(icp, ratings);

  return {
    caseId: evalCase.id,
    repeatIndex,
    score,
    tier,
    qualified,
    disqualifiedBy,
    expected: evalCase.expected,
    summary,
    ratings,
    costUsd: usage?.costUsd ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    latencyMs,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required to run the eval");
  }

  const cases = loadCases();
  const thresholds = loadThresholds();

  const work = cases.flatMap((evalCase) =>
    Array.from({ length: args.repeat }, (_unused, repeatIndex) => ({ evalCase, repeatIndex })),
  );

  console.log(
    `\nQualification eval — ${cases.length} cases x ${args.repeat} repeat(s) = ${work.length} calls`,
  );
  console.log(
    `provider: ${config.llmProvider}  model: ${config.llmModel}  concurrency: ${args.concurrency}\n`,
  );

  const startedAt = Date.now();
  const outcomes = await mapWithConcurrency(work, args.concurrency, ({ evalCase, repeatIndex }) =>
    runOneAttempt(evalCase, repeatIndex),
  );
  const wallClockMs = Date.now() - startedAt;

  const summary = summarizeEvalRun(outcomes);
  const gate = checkThresholds(summary, thresholds);

  console.log(
    `${pad("case", 32)}${pad("expected", 16)}${pad("actual", 16)}${pad("scores", 18)}ok`,
  );
  console.log("-".repeat(88));
  for (const caseSummary of summary.cases) {
    const expected = `${caseSummary.expected.tier} ${caseSummary.expected.scoreRange[0]}-${caseSummary.expected.scoreRange[1]}`;
    const actualTiers = [
      ...new Set(
        outcomes.filter((o) => o.caseId === caseSummary.caseId).map((o) => o.tier),
      ),
    ].join("/");
    const mark = caseSummary.stable ? "PASS" : caseSummary.tierHits > 0 ? "FLAKY" : "FAIL";
    console.log(
      pad(caseSummary.caseId, 32) +
        pad(expected, 16) +
        pad(`${actualTiers} ${Math.round(caseSummary.meanScore)}`, 16) +
        pad(caseSummary.scores.join(","), 18) +
        mark,
    );
  }

  const totalCost = outcomes.reduce((sum, o) => sum + o.costUsd, 0);
  const totalTokens = outcomes.reduce((sum, o) => sum + o.inputTokens + o.outputTokens, 0);
  const meanLatency = outcomes.reduce((sum, o) => sum + o.latencyMs, 0) / outcomes.length;

  console.log("\nconfusion (rows = expected, cols = actual)");
  console.log(`${pad("", 8)}${TIERS.map((t) => pad(t, 8)).join("")}`);
  for (const expected of TIERS) {
    console.log(
      pad(expected, 8) + TIERS.map((actual) => pad(String(summary.confusion[expected][actual]), 8)).join(""),
    );
  }

  console.log("");
  console.log(`tier accuracy      ${(summary.tierAccuracy * 100).toFixed(1)}%  (min ${(thresholds.tierAccuracy * 100).toFixed(0)}%)`);
  console.log(`qualified accuracy ${(summary.qualifiedAccuracy * 100).toFixed(1)}%  (min ${(thresholds.qualifiedAccuracy * 100).toFixed(0)}%)`);
  console.log(`disqualify recall  ${(summary.disqualifyRecall * 100).toFixed(1)}%  (min ${(thresholds.disqualifyRecall * 100).toFixed(0)}%)`);
  console.log(`in-range rate      ${(summary.inRangeRate * 100).toFixed(1)}%`);
  console.log(`score MAE          ${summary.scoreMae.toFixed(2)}  (max ${thresholds.maxScoreMae})`);
  console.log(`max score spread   ${summary.maxScoreSpread}${args.repeat > 1 ? "" : "  (single run — no variance signal)"}`);
  console.log("");
  console.log(`total cost         $${totalCost.toFixed(4)}  (${(totalCost / work.length).toFixed(5)}/call, ${totalTokens} tokens)`);
  console.log(`mean call latency  ${Math.round(meanLatency)}ms   wall clock ${(wallClockMs / 1000).toFixed(1)}s`);

  const report = {
    generatedAt: new Date().toISOString(),
    provider: config.llmProvider,
    model: config.llmModel,
    repeat: args.repeat,
    icp: {
      tierThresholds: config.icp.tierThresholds,
      disqualifyBelow: config.icp.disqualifyBelow,
      criteria: config.icp.criteria.map((c) => ({ name: c.name, weight: c.weight })),
    },
    thresholds,
    passed: gate.passed,
    failures: gate.failures,
    summary,
    cost: { totalUsd: Number(totalCost.toFixed(6)), totalTokens, meanLatencyMs: Math.round(meanLatency) },
    attempts: outcomes,
  };
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written to ${args.out}`);

  if (!gate.passed) {
    console.error("\nEVAL FAILED");
    for (const failure of gate.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nEVAL PASSED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
