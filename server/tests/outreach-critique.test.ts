import { describe, expect, it } from "vitest";
import { lintOutreachDraft, shouldRevise } from "../src/agent/outreach-critique.js";

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

describe("lintOutreachDraft", () => {
  it("passes a well-formed draft", () => {
    expect(lintOutreachDraft("A short subject line", words(110))).toEqual([]);
  });

  it("flags a body that is too short", () => {
    expect(lintOutreachDraft("Subject", words(10))).toEqual(
      expect.arrayContaining([expect.stringContaining("expected 90-140")]),
    );
  });

  it("flags a body that is too long", () => {
    expect(lintOutreachDraft("Subject", words(200))).toEqual(
      expect.arrayContaining([expect.stringContaining("expected 90-140")]),
    );
  });

  it("flags an overlong subject", () => {
    const longSubject = "x".repeat(100);
    expect(lintOutreachDraft(longSubject, words(110))).toEqual(
      expect.arrayContaining([expect.stringContaining("80")]),
    );
  });

  it("flags placeholder brackets", () => {
    expect(lintOutreachDraft("Hi [First Name]", words(110))).toEqual(
      expect.arrayContaining([expect.stringContaining("placeholder")]),
    );
  });

  it("flags markdown syntax", () => {
    expect(lintOutreachDraft("Subject", `**bold claim** ${words(108)}`)).toEqual(
      expect.arrayContaining([expect.stringContaining("markdown")]),
    );
  });

  it("flags leaked source metadata", () => {
    expect(lintOutreachDraft("Subject", `We saw your source was great. ${words(105)}`)).toEqual(
      expect.arrayContaining([expect.stringContaining("source")]),
    );
  });

  it("can return multiple issues at once", () => {
    const issues = lintOutreachDraft("x".repeat(100), words(10));
    expect(issues.length).toBeGreaterThan(1);
  });
});

describe("shouldRevise", () => {
  it("revises when failing and under the cap", () => {
    expect(shouldRevise(false, 0, 2)).toBe(true);
    expect(shouldRevise(false, 1, 2)).toBe(true);
  });

  it("stops once the revision cap is reached", () => {
    expect(shouldRevise(false, 2, 2)).toBe(false);
  });

  it("stops once the draft passes, regardless of revision count", () => {
    expect(shouldRevise(true, 0, 2)).toBe(false);
  });
});
