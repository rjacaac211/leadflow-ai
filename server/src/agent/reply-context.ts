/** Minimal shape needed from an OutreachMessage row to render a transcript. */
export interface ThreadMessage {
  direction: "INBOUND" | "OUTBOUND";
  subject: string | null;
  body: string;
  createdAt: Date;
}

const DEFAULT_MAX_CHARS = 6000;

/**
 * Renders prior outreach/reply messages for a lead as a plain-text transcript
 * for the reply-classification/handling prompts, so the model sees the full
 * conversation instead of just the latest message in isolation. Mirrors the
 * dashboard's own "→ to lead" / "← from lead" convention (LeadDetail.jsx) so
 * the transcript reads the same way a human reviewer already sees it.
 *
 * Truncates from the front (keeps the most recent messages) when the
 * transcript exceeds maxChars, since what the lead just said matters more
 * than early context on a long thread.
 */
export function buildThreadTranscript(
  messages: ThreadMessage[],
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (messages.length === 0) return "(no prior messages)";

  const lines = messages
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => {
      const who = m.direction === "OUTBOUND" ? "→ to lead" : "← from lead";
      const subjectLine = m.subject ? `${m.subject}\n` : "";
      return `${who} (${m.createdAt.toISOString()}):\n${subjectLine}${m.body}`;
    });

  const transcript = lines.join("\n\n");
  if (transcript.length <= maxChars) return transcript;

  return `(earlier messages truncated)\n\n${transcript.slice(-maxChars)}`;
}
