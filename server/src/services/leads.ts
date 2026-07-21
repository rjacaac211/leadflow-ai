/**
 * Pure lead-payload normalization. Webhook senders (n8n, Zapier, raw curl,
 * form builders) disagree on field names, so this maps the common variants
 * onto our canonical shape. Kept free of I/O so it can be unit tested.
 */

export interface NormalizedLead {
  name: string;
  email: string;
  company?: string;
  companyWebsite?: string;
  message?: string;
  source: string;
}

export type NormalizeResult =
  | { ok: true; lead: NormalizedLead }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstString(
  payload: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function normalizeLeadPayload(input: unknown): NormalizeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const payload = input as Record<string, unknown>;

  const email = firstString(payload, ["email", "email_address", "workEmail"]);
  if (!email) return { ok: false, error: "missing required field: email" };
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return { ok: false, error: `invalid email: ${email}` };
  }

  let name = firstString(payload, ["name", "full_name", "fullName"]);
  if (!name) {
    const first = firstString(payload, ["first_name", "firstName"]);
    const last = firstString(payload, ["last_name", "lastName"]);
    name = [first, last].filter(Boolean).join(" ") || undefined;
  }
  if (!name) name = email.split("@")[0];

  const company = firstString(payload, [
    "company",
    "company_name",
    "companyName",
    "organization",
  ]);

  let companyWebsite = firstString(payload, [
    "company_website",
    "companyWebsite",
    "website",
    "domain",
    "url",
  ]);
  if (companyWebsite && !/^https?:\/\//i.test(companyWebsite)) {
    companyWebsite = `https://${companyWebsite}`;
  }
  if (companyWebsite) {
    try {
      const parsed = new URL(companyWebsite);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        companyWebsite = undefined;
      }
    } catch {
      companyWebsite = undefined;
    }
  }

  const message = firstString(payload, [
    "message",
    "notes",
    "inquiry",
    "comments",
    "body",
  ]);

  const source = firstString(payload, ["source", "utm_source"]) ?? "webhook";

  return {
    ok: true,
    lead: {
      name: name.slice(0, 200),
      email: email.toLowerCase(),
      company: company?.slice(0, 200),
      companyWebsite,
      message: message?.slice(0, 4000),
      source: source.slice(0, 100),
    },
  };
}
