import { config } from "../config.js";
import { logger } from "../logger.js";

const HUBSPOT_BASE = "https://api.hubapi.com";

export interface CrmSyncInput {
  email: string;
  name: string;
  company?: string;
  website?: string;
  score: number;
  tier: string;
  qualificationReason: string;
}

export interface CrmSyncResult {
  mock: boolean;
  contactId: string | null;
}

async function hubspotRequest(
  path: string,
  method: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${HUBSPOT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.hubspotAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HubSpot ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Upsert the lead as a HubSpot contact and attach the qualification summary
 * as a note. With no HUBSPOT_ACCESS_TOKEN configured this is a logged no-op
 * ("mock mode") so the pipeline runs end-to-end with only an LLM key.
 */
export async function syncLeadToCrm(input: CrmSyncInput): Promise<CrmSyncResult> {
  if (!config.hubspotAccessToken) {
    logger.info({ email: input.email, tier: input.tier }, "hubspot mock mode: skipping CRM sync");
    return { mock: true, contactId: null };
  }

  const [firstname, ...rest] = input.name.split(" ");
  const properties: Record<string, string> = {
    email: input.email,
    firstname: firstname ?? input.name,
    lastname: rest.join(" "),
  };
  if (input.company) properties.company = input.company;
  if (input.website) properties.website = input.website;

  // Upsert by email (idempotent for repeat submissions from the same lead).
  const upserted = await hubspotRequest(
    `/crm/v3/objects/contacts/${encodeURIComponent(input.email)}?idProperty=email`,
    "PATCH",
    { properties },
  ).catch(async (error: unknown) => {
    if (error instanceof Error && error.message.includes("(404)")) {
      return hubspotRequest("/crm/v3/objects/contacts", "POST", { properties });
    }
    throw error;
  });

  const contactId = String((upserted as { id?: unknown }).id ?? "");

  if (contactId) {
    await hubspotRequest("/crm/v3/objects/notes", "POST", {
      properties: {
        hs_timestamp: Date.now(),
        hs_note_body: `LeadFlow AI qualification — score ${input.score}/100 (${input.tier}).\n\n${input.qualificationReason}`,
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 },
          ],
        },
      ],
    });
  }

  logger.info({ email: input.email, contactId }, "hubspot contact synced");
  return { mock: false, contactId: contactId || null };
}
