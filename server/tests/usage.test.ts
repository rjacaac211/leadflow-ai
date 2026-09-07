import { describe, expect, it } from "vitest";
import { accumulateUsage, drainUsage } from "../src/agent/usage.js";

const usage = (inputTokens: number, outputTokens: number, costUsd: number) => ({
  inputTokens,
  outputTokens,
  costUsd,
});

describe("per-lead usage accumulator", () => {
  it("returns null for a lead that never made a call", () => {
    expect(drainUsage("lead-never-ran")).toBeNull();
  });

  it("sums calls, tokens and cost for one lead", () => {
    accumulateUsage("lead-a", usage(100, 20, 0.001));
    accumulateUsage("lead-a", usage(250, 80, 0.0035));
    expect(drainUsage("lead-a")).toEqual({
      calls: 2,
      inputTokens: 350,
      outputTokens: 100,
      costUsd: 0.0045,
    });
  });

  it("keeps concurrent leads separate", () => {
    accumulateUsage("lead-b", usage(10, 1, 0.1));
    accumulateUsage("lead-c", usage(20, 2, 0.2));
    accumulateUsage("lead-b", usage(30, 3, 0.3));

    expect(drainUsage("lead-b")?.inputTokens).toBe(40);
    expect(drainUsage("lead-c")?.inputTokens).toBe(20);
  });

  // Draining must clear the entry, or a lead's second pipeline run (an approval
  // resume, say) would re-report the first run's spend on top of its own.
  it("clears the entry so a second drain reports nothing", () => {
    accumulateUsage("lead-d", usage(10, 5, 0.01));
    expect(drainUsage("lead-d")).not.toBeNull();
    expect(drainUsage("lead-d")).toBeNull();
  });

  it("starts a fresh total after a drain", () => {
    accumulateUsage("lead-e", usage(10, 5, 0.01));
    drainUsage("lead-e");
    accumulateUsage("lead-e", usage(7, 3, 0.02));
    expect(drainUsage("lead-e")).toEqual({
      calls: 1,
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.02,
    });
  });

  it("rounds cost to six decimals so float drift never reaches the audit trail", () => {
    accumulateUsage("lead-f", usage(1, 1, 0.1));
    accumulateUsage("lead-f", usage(1, 1, 0.2));
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
    expect(drainUsage("lead-f")?.costUsd).toBe(0.3);
  });
});
