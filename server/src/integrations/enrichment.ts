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
 * Fetch a page and return its raw HTML, or null on any failure (bad status,
 * non-HTML content type, network error, timeout). Failures are logged, never
 * thrown — every caller treats enrichment as best-effort.
 */
export async function fetchRawHtml(url: string): Promise<string | null> {
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
    return await response.text();
  } catch (error) {
    logger.warn({ url, err: error }, "enrichment fetch errored");
    return null;
  }
}

/**
 * Fetch the lead's company homepage and return readable text for the
 * qualification prompt. This is the single-page fallback used when the
 * agentic multi-page enrichment (agent/enrichment-agent.ts) isn't available
 * or fails — failures here are non-fatal too, for the same reason.
 */
export async function fetchWebsiteText(url: string): Promise<string | null> {
  const html = await fetchRawHtml(url);
  if (!html) return null;
  const text = htmlToText(html);
  return text ? text.slice(0, MAX_TEXT_CHARS) : null;
}

export interface PageLink {
  href: string;
  text: string;
}

// Anchors whose href starts with "#" (pure in-page fragments) are excluded
// by the [^"'#] on the first href character.
const ANCHOR_PATTERN = /<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Pulls every same-document <a> link out of an HTML page, resolved to
 * absolute URLs against baseUrl. Pure (no I/O) — used by the enrichment
 * agent's fetch_page tool to decide what to look at next.
 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const pattern = new RegExp(ANCHOR_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const [, hrefRaw, innerHtml] = match;
    let absoluteUrl: URL;
    try {
      absoluteUrl = new URL(hrefRaw, baseUrl);
    } catch {
      continue;
    }
    if (absoluteUrl.protocol !== "http:" && absoluteUrl.protocol !== "https:") continue;
    const text = htmlToText(innerHtml).replace(/\s+/g, " ").trim();
    links.push({ href: absoluteUrl.toString(), text });
  }
  return links;
}

const RELEVANT_LINK_KEYWORDS = [
  "about",
  "pricing",
  "product",
  "solutions",
  "platform",
  "customers",
  "case-stud",
  "why",
  "company",
  "team",
];

function registrableDomain(hostname: string): string {
  // Strips a leading "www." only — good enough here since this only ever
  // compares a link's host against the lead's own homepage host, not
  // arbitrary third-party domains, so full public-suffix-list handling
  // (e.g. for co.uk-style domains) isn't needed.
  return hostname.replace(/^www\./, "");
}

/**
 * Ranks same-domain links by how likely they are to carry useful B2B
 * qualification signal, for the enrichment agent's tool to offer as
 * candidates. Pure (no I/O). Deliberately same-registrable-domain only —
 * the fetch_page tool must not be able to wander off the lead's own site.
 */
export function rankCandidateLinks(links: PageLink[], baseUrl: string, limit = 10): string[] {
  let baseDomain: string;
  try {
    baseDomain = registrableDomain(new URL(baseUrl).hostname);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (registrableDomain(url.hostname) !== baseDomain) continue;

    const normalized = `${url.origin}${url.pathname}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const haystack = `${url.pathname} ${link.text}`.toLowerCase();
    const score = RELEVANT_LINK_KEYWORDS.reduce(
      (total, keyword) => (haystack.includes(keyword) ? total + 1 : total),
      0,
    );
    if (score > 0) scored.push({ url: normalized, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.url);
}
