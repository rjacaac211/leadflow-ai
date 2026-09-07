/**
 * Loading and typing for the eval fixtures. Split out from the runner so the
 * unit tests can validate the dataset without importing the runner, whose
 * top-level main() would try to make Anthropic calls on import.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LeadContext } from "../src/agent/qualify-prompt.js";
import type { ExpectedLabel, Thresholds } from "./metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface EvalCase {
  id: string;
  notes: string;
  lead: LeadContext;
  enrichment: string;
  expected: ExpectedLabel;
}

export function loadCases(): EvalCase[] {
  const raw = readFileSync(path.resolve(here, "dataset/qualification.json"), "utf-8");
  return (JSON.parse(raw) as { cases: EvalCase[] }).cases;
}

export function loadThresholds(): Thresholds {
  const raw = readFileSync(path.resolve(here, "thresholds.json"), "utf-8");
  return JSON.parse(raw) as Thresholds;
}
