import { describe, expect, it } from "vitest";
import { shouldContinueEnrichment } from "../src/agent/enrichment-agent.js";

describe("shouldContinueEnrichment", () => {
  it("continues when the model requested a tool call and budget remains", () => {
    expect(shouldContinueEnrichment(true, 0, 4)).toBe(true);
    expect(shouldContinueEnrichment(true, 3, 4)).toBe(true);
  });

  it("stops once the step budget is exhausted, even with a pending tool call", () => {
    expect(shouldContinueEnrichment(true, 4, 4)).toBe(false);
  });

  it("stops when the model made no tool call, regardless of budget", () => {
    expect(shouldContinueEnrichment(false, 0, 4)).toBe(false);
  });
});
