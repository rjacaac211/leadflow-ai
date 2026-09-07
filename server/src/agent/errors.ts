/**
 * Classifies whether a node failure is worth retrying automatically.
 *
 * Matches this repo's own integration error shapes rather than guessing:
 * `hubspot.ts`/`resend.ts` throw `Error("... failed (${status}): ...")`,
 * so a parenthesized 3-digit status is retried on 429/5xx and not on 4xx.
 * Anthropic SDK errors expose a numeric `status` instead of embedding it in
 * the message, so that's checked separately. Anything else defaults to
 * non-retriable — an unrecognized error is more likely a bug than a blip.
 */
export function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const statusInMessage = error.message.match(/\((\d{3})\)/);
  if (statusInMessage) {
    const status = Number(statusInMessage[1]);
    return status === 429 || status >= 500;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
  }

  return false;
}
