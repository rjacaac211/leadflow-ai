import { logger } from "../logger.js";

const MAX_TEXT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Strip an HTML document down to readable text. Pure function (unit tested);
 * intentionally simple — good enough for an LLM to extract company context.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Fetch the lead's company homepage and return readable text for the
 * qualification prompt. Failures are non-fatal: enrichment is best-effort
 * and the pipeline continues without it.
 */
export async function fetchWebsiteText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "LeadFlowAI-Enrichment/1.0" },
    });
    if (!response.ok) {
      logger.warn({ url, status: response.status }, "enrichment fetch failed");
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return null;
    }
    const html = await response.text();
    const text = htmlToText(html);
    return text ? text.slice(0, MAX_TEXT_CHARS) : null;
  } catch (error) {
    logger.warn({ url, err: error }, "enrichment fetch errored");
    return null;
  }
}
