import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface IcpCriterion {
  name: string;
  description: string;
  weight: number;
}

export interface IcpConfig {
  productPitch: string;
  targetCustomer: string;
  criteria: IcpCriterion[];
  tierThresholds: { hot: number; warm: number };
  disqualifyBelow: number;
}

function loadIcpConfig(): IcpConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath =
    process.env.ICP_CONFIG_PATH ?? path.resolve(here, "../../icp.config.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as IcpConfig;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  webhookApiKey: process.env.WEBHOOK_API_KEY ?? "",
  hubspotAccessToken: process.env.HUBSPOT_ACCESS_TOKEN ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  outreachFromEmail:
    process.env.OUTREACH_FROM_EMAIL || "LeadFlow <onboarding@resend.dev>",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  icp: loadIcpConfig(),
};
