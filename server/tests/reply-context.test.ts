import { describe, expect, it } from "vitest";
import { buildThreadTranscript, type ThreadMessage } from "../src/agent/reply-context.js";

function msg(partial: Partial<ThreadMessage> & { createdAt: Date }): ThreadMessage {
  return {
    direction: "OUTBOUND",
    subject: null,
    body: "",
    ...partial,
  };
}

describe("buildThreadTranscript", () => {
  it("returns a placeholder for no messages", () => {
    expect(buildThreadTranscript([])).toBe("(no prior messages)");
  });

  it("orders messages chronologically regardless of input order", () => {
    const later = msg({ body: "second", createdAt: new Date("2026-01-02T00:00:00Z") });
    const earlier = msg({ body: "first", createdAt: new Date("2026-01-01T00:00:00Z") });
    const transcript = buildThreadTranscript([later, earlier]);
    expect(transcript.indexOf("first")).toBeLessThan(transcript.indexOf("second"));
  });

  it("labels outbound and inbound messages distinctly", () => {
    const transcript = buildThreadTranscript([
      msg({ direction: "OUTBOUND", body: "hello", createdAt: new Date("2026-01-01T00:00:00Z") }),
      msg({ direction: "INBOUND", body: "hi back", createdAt: new Date("2026-01-02T00:00:00Z") }),
    ]);
    expect(transcript).toContain("→ to lead");
    expect(transcript).toContain("← from lead");
  });

  it("includes the subject line when present", () => {
    const transcript = buildThreadTranscript([
      msg({ subject: "Following up", body: "body text", createdAt: new Date("2026-01-01T00:00:00Z") }),
    ]);
    expect(transcript).toContain("Following up");
  });

  it("keeps the most recent content when truncating", () => {
    const messages = [
      msg({ body: "A".repeat(100), createdAt: new Date("2026-01-01T00:00:00Z") }),
      msg({ body: "B".repeat(100), createdAt: new Date("2026-01-02T00:00:00Z") }),
    ];
    const transcript = buildThreadTranscript(messages, 50);
    expect(transcript).toContain("truncated");
    expect(transcript).toContain("B");
    expect(transcript).not.toContain("A");
  });

  it("does not truncate when under the limit", () => {
    const transcript = buildThreadTranscript(
      [msg({ body: "short", createdAt: new Date("2026-01-01T00:00:00Z") })],
      6000,
    );
    expect(transcript).not.toContain("truncated");
  });
});
